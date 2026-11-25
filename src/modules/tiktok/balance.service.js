import { balanceLabel, hasBalance, isBudgetMode, mainAmount, sortAmounts } from '../../../shared/balance-fields.js';
import { HttpError } from '../../lib/http-error.js';
import { TtlCache } from '../../lib/ttl-cache.js';

const CACHE_TTL_MS = 60_000;
const CONCURRENCY = 4;

/** Mensagem segura para a tela quando o TikTok recusa a consulta (nunca token nem detalhes internos). */
function friendly(err) {
  if (err instanceof HttpError) {
    if (err.code === 'tiktok_reauth') return 'O acesso desta conexão expirou ou foi revogado. Renove o acesso em Contas TikTok.';
    if (err.code === 'tiktok_rate_limited') return 'O TikTok limitou as consultas. Tente de novo em instantes.';
    // O saldo só é visível a usuários com função financeira na BC (documentação oficial): explica isso quando o TikTok negar.
    if (err.code === 'tiktok_error' && /(permission|authoriz|forbid|role)/i.test(err.message)) return `Sem permissão para ver o saldo: só usuários com função financeira (Finance Manager ou Analyst) na Business Center veem o saldo. (${err.message})`;
    if (['tiktok_error', 'proxy_error', 'tiktok_unreachable', 'tiktok_token_unreadable'].includes(err.code)) return err.message;
  }
  return 'Não foi possível consultar o saldo agora.';
}

const toAmounts = (list) => sortAmounts(list).map((a) => ({ key: a.key, label: balanceLabel(a.key), value: a.value }));

/**
 * O que a conta pode GASTAR, conforme a documentação oficial de `/advertiser/balance/get/`:
 *  - normal: o disponível da própria conta (`balance_info`, que o cliente já prioriza);
 *  - portfólio de pagamento COMPARTILHADO (`SHARED`): o dinheiro é do portfólio e usado por todas as contas ligadas a ele, então o disponível
 *    é o do portfólio (e ele não pode ser somado uma vez por conta);
 *  - BC em alocação automática (orçamento mensal/diário/único): a conta gasta do saldo da BC dentro do orçamento, então o disponível é o
 *    orçamento restante, limitado pelo saldo da BC (o saldo próprio da conta fica zerado por definição).
 */
function describeAccount(item, bcMain) {
  const amounts = toAmounts(item.amounts);
  const portfolio = item.portfolio ? { id: item.portfolio.id, name: item.portfolio.name, type: item.portfolio.type, amounts: toAmounts(item.portfolio.amounts) } : null;
  const out = { amounts, main: mainAmount(amounts), hasBalance: hasBalance(amounts), mainSource: 'account', portfolio, budgetMode: item.budgetMode ?? null };
  if (portfolio?.type === 'SHARED') {
    const pooled = mainAmount(portfolio.amounts);
    if (pooled !== null) Object.assign(out, { main: pooled, hasBalance: hasBalance(portfolio.amounts), mainSource: 'portfolio' });
  } else if (isBudgetMode(item.budgetMode)) {
    const remaining = amounts.find((a) => a.key === 'budget_remaining')?.value;
    if (remaining !== undefined) {
      const usable = Math.max(0, bcMain === null ? remaining : Math.min(remaining, bcMain));
      Object.assign(out, { main: usable, hasBalance: usable > 0, mainSource: 'budget' });
    }
  }
  return out;
}

/**
 * Saldo das Business Centers e das contas de anúncio do usuário, em duas visões SEPARADAS (BC e conta). Uma BC sem saldo pode ter
 * contas com saldo e vice-versa: as duas aparecem, cada uma com a sua situação, e cada conta informa se a BC dela tem saldo.
 *  - Só as conexões do PRÓPRIO usuário (dinheiro não é compartilhado com a equipe por esta tela).
 *  - Uma consulta por BC do TikTok (`/bc/balance/get/` + `/advertiser/balance/get/`), poucas ao mesmo tempo, em cache por 60 s.
 *  - Falha em uma BC (ex.: sem permissão financeira) aparece como aviso naquela BC; as outras seguem normalmente.
 */
export function createBalanceService({ tiktok, connections, log = console, now = () => new Date() }) {
  const cache = new TtlCache({ ttlMs: CACHE_TTL_MS, maxEntries: 100 });
  const inflight = new Map();

  /** Consulta uma BC do TikTok com o token da conexão. Devolve os dois resultados, cada um com o próprio erro (se houver). */
  async function fetchBc(connection, bcId) {
    try {
      return await tiktok.withToken(connection.id, async (token, api) => {
        const [bc, accounts] = await Promise.allSettled([api.getBcBalance(token, bcId), api.listAdvertiserBalances(token, bcId)]);
        for (const r of [bc, accounts]) if (r.status === 'rejected' && r.reason instanceof HttpError && r.reason.code === 'tiktok_reauth') throw r.reason; // token caiu: a conexão já foi marcada com erro
        return {
          bc: bc.status === 'fulfilled' ? { ok: true, ...bc.value } : { ok: false, error: friendly(bc.reason) },
          accounts: accounts.status === 'fulfilled' ? { ok: true, list: accounts.value } : { ok: false, error: friendly(accounts.reason) },
        };
      });
    } catch (err) {
      log.warn?.(`[saldo] conexão ${connection.id}, BC ${bcId}: ${err?.code ?? 'erro'}`); // sem token nem dados
      const error = friendly(err);
      return { bc: { ok: false, error }, accounts: { ok: false, error } };
    }
  }

  /** Conexões e contas do PRÓPRIO usuário (lidas do banco, rápido). */
  async function load(actor) {
    const own = (await connections.listVisible(actor.id)).filter((c) => c.ownerId === actor.id);
    const known = (await connections.advertisers(actor.id)).filter((a) => a.businessCenterOwned);
    return { own, known };
  }

  async function build(actor, { own, known }) {
    const bcs = [];
    const accounts = [];
    const tasks = [];

    for (const connection of own) {
      const bcIds = connection.bcId ? [connection.bcId] : connection.ownerBcIds;
      const base = { connectionId: connection.id, connectionName: connection.name };
      const mine = known.filter((a) => a.businessCenterId === connection.id);
      if (connection.status !== 'active' || !bcIds.length) {
        const error = connection.status !== 'active' ? 'Esta conexão está com erro de acesso. Renove o acesso em Contas TikTok.' : 'O sistema ainda não sabe o ID da Business Center desta conexão. Use "Atualizar contas" em Contas TikTok.';
        bcs.push({ ...base, key: `${connection.id}:-`, bcId: null, status: 'error', error, currency: null, amounts: [], main: null, hasBalance: false, accountsTotal: mine.length, accountsWithBalance: 0, accountsError: null });
        for (const a of mine) accounts.push({ ...base, key: `${connection.id}:${a.id}`, advertiserId: a.id, name: a.name, advertiserStatus: null, bcId: a.ownerBcId, currency: a.currency, status: 'unknown', error, amounts: [], main: null, hasBalance: false, bcHasBalance: null });
        continue;
      }
      for (const bcId of bcIds) tasks.push({ connection, bcId, base, mine: mine.filter((a) => (a.ownerBcId ?? (connection.bcId ? connection.bcId : null)) === bcId) });
      // Contas que o TikTok não ligou a nenhuma BC conhecida da conexão: aparecem mesmo assim, sem saldo informado.
      for (const a of mine.filter((x) => !bcIds.includes(x.ownerBcId ?? connection.bcId))) {
        accounts.push({ ...base, key: `${connection.id}:${a.id}`, advertiserId: a.id, name: a.name, advertiserStatus: null, bcId: null, currency: a.currency, status: 'unknown', error: 'Sem Business Center informada: o TikTok não ligou esta conta a uma BC.', amounts: [], main: null, hasBalance: false, bcHasBalance: null });
      }
    }

    // Poucas consultas ao mesmo tempo (o TikTok limita a frequência).
    const results = new Array(tasks.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
      while (next < tasks.length) {
        const index = next;
        next += 1;
        results[index] = await fetchBc(tasks[index].connection, tasks[index].bcId);
      }
    }));

    tasks.forEach((task, index) => {
      const { connection, bcId, base, mine } = task;
      const { bc, accounts: acc } = results[index];
      const bcAmounts = bc.ok ? toAmounts(bc.amounts) : [];
      const bcHas = bc.ok ? hasBalance(bcAmounts) : null;
      const listed = acc.ok ? acc.list : [];
      const listedIds = new Set(listed.map((a) => a.id));
      const names = new Map(mine.map((a) => [a.id, a]));

      const bcMain = bc.ok ? mainAmount(bcAmounts) : null;
      for (const item of listed) {
        const db = names.get(item.id);
        accounts.push({
          ...base, key: `${connection.id}:${item.id}`, advertiserId: item.id, name: item.name || db?.name || item.id, advertiserStatus: item.status, bcId,
          currency: item.currency ?? db?.currency ?? bc.currency ?? null, status: 'ok', error: null, ...describeAccount(item, bcMain), bcHasBalance: bcHas,
        });
      }
      // Contas conhecidas desta BC que o TikTok não devolveu (ou a consulta falhou): aparecem sem saldo informado.
      for (const db of mine.filter((a) => !listedIds.has(a.id))) {
        accounts.push({
          ...base, key: `${connection.id}:${db.id}`, advertiserId: db.id, name: db.name, advertiserStatus: null, bcId, currency: db.currency, status: 'unknown',
          error: acc.ok ? 'O TikTok não informou o saldo desta conta (ele só informa as contas em que esta Business Center é administradora).' : acc.error, amounts: [], main: null, hasBalance: false, bcHasBalance: bcHas,
        });
      }
      bcs.push({
        ...base, key: `${connection.id}:${bcId}`, bcId, status: bc.ok ? 'ok' : 'error', error: bc.ok ? null : bc.error, currency: bc.ok ? bc.currency : null,
        amounts: bcAmounts, main: bc.ok ? mainAmount(bcAmounts) : null, hasBalance: Boolean(bcHas),
        portfolioType: bc.ok ? bc.portfolioType ?? null : null, accountsTotal: Math.max(mine.length, listed.length), accountsWithBalance: accounts.filter((a) => a.connectionId === connection.id && a.bcId === bcId && a.status === 'ok' && a.hasBalance).length, accountsError: acc.ok ? null : acc.error,
      });
    });

    bcs.sort((a, b) => a.connectionName.localeCompare(b.connectionName) || String(a.bcId).localeCompare(String(b.bcId)));
    accounts.sort((a, b) => Number(b.hasBalance) - Number(a.hasBalance) || (b.main ?? -1) - (a.main ?? -1) || a.name.localeCompare(b.name));

    // Totais por moeda (moedas diferentes nunca se somam).
    const totals = new Map();
    const bump = (currency, field, value) => {
      const code = currency ?? 'UNKNOWN';
      const row = totals.get(code) ?? { currency: code, bc: 0, accounts: 0 };
      row[field] += value;
      totals.set(code, row);
    };
    for (const b of bcs) if (b.main !== null) bump(b.currency, 'bc', b.main);
    // Cada dinheiro entra UMA vez: portfólio compartilhado (o mesmo valor aparece em todas as contas ligadas a ele) soma só uma vez, e conta que
    // gasta do saldo da BC (orçamento) não soma (esse dinheiro já está no total da BC).
    const countedPools = new Set();
    for (const a of accounts) {
      if (a.main === null || a.mainSource === 'budget') continue;
      if (a.mainSource === 'portfolio') {
        const pool = `${a.connectionId}:${a.portfolio.id ?? `bc${a.bcId}`}`;
        if (countedPools.has(pool)) continue;
        countedPools.add(pool);
      }
      bump(a.currency, 'accounts', a.main);
    }

    return {
      fetchedAt: now().toISOString(),
      summary: {
        bcs: bcs.length,
        bcsWithBalance: bcs.filter((b) => b.status === 'ok' && b.hasBalance).length,
        bcsWithoutBalance: bcs.filter((b) => b.status === 'ok' && !b.hasBalance).length,
        bcsWithError: bcs.filter((b) => b.status === 'error').length,
        accounts: accounts.length,
        accountsWithBalance: accounts.filter((a) => a.status === 'ok' && a.hasBalance).length,
        accountsWithoutBalance: accounts.filter((a) => a.status === 'ok' && !a.hasBalance).length,
        accountsUnknown: accounts.filter((a) => a.status !== 'ok').length,
        accountsOnBudget: accounts.filter((a) => a.mainSource === 'budget').length, // gastam do saldo da BC, dentro de um orçamento (não entram na soma)
        accountsSharedPortfolio: accounts.filter((a) => a.mainSource === 'portfolio').length, // dividem o saldo de um portfólio (entra uma vez na soma)
      },
      totals: [...totals.values()].sort((a, b) => (b.bc + b.accounts) - (a.bc + a.accounts)),
      bcs,
      accounts,
    };
  }

  return {
    /** Visão completa (BCs e contas). `fresh` ignora o cache de 60 s. Consultas simultâneas do mesmo usuário compartilham o resultado. */
    async overview(actor, { fresh = false } = {}) {
      const loaded = await load(actor);
      // A chave do cache muda quando as conexões mudam (conectar, remover, sincronizar, erro de acesso): nunca mostra um resultado velho.
      const signature = loaded.own.map((c) => `${c.id}.${c.status}.${c.lastSyncedAt}.${c.ownerBcIds.join('-')}`).join('|');
      const key = `balance:${actor.id}:${signature}:${loaded.known.length}`;
      if (fresh) cache.delete(key);
      const cached = cache.get(key);
      if (cached) return cached;
      if (inflight.has(key)) return inflight.get(key);
      const promise = build(actor, loaded).then((data) => {
        cache.set(key, data);
        return data;
      }).finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    },
  };
}
