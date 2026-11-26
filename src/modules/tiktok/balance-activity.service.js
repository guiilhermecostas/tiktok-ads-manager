import { DEPOSIT_TYPES, HISTORY_PAGE_SIZE, historyWindow, normalizeHistoryQuery } from '../../../shared/balance-history.js';
import { HttpError, badRequest, notFound } from '../../lib/http-error.js';
import { TtlCache } from '../../lib/ttl-cache.js';
import { bcIdsOf, bcOfAccount, loadOwnScope } from './balance-scope.js';

const SPEND_TTL_MS = 10 * 60_000; // o gasto vitalício muda devagar: 10 minutos bastam (e poupa o limite de chamadas do TikTok)
const HISTORY_TTL_MS = 30_000;
const SPEND_CHUNK = 5; // o relatório aceita até 5 contas por pedido
const SPEND_CONCURRENCY = 2;

/** Mensagem segura para a tela quando o TikTok recusa a consulta (nunca token nem detalhes internos). */
function friendly(err, what) {
  if (err instanceof HttpError) {
    if (err.code === 'tiktok_reauth') return 'O acesso desta conexão expirou ou foi revogado. Renove o acesso em Contas TikTok.';
    if (err.code === 'tiktok_rate_limited') return 'O TikTok limitou as consultas. Tente de novo em instantes.';
    if (err.code === 'tiktok_error' && /(permission|authoriz|forbid|role|finance)/i.test(err.message)) {
      return `Sem permissão para ver ${what}: só usuários com função financeira (Finance Manager ou Analyst) na Business Center veem isto. (${err.message})`;
    }
    if (['tiktok_error', 'proxy_error', 'tiktok_unreachable', 'tiktok_token_unreadable'].includes(err.code)) return err.message;
  }
  return `Não foi possível consultar ${what} agora.`;
}

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/**
 * Gasto total e histórico de depósitos, por Business Center e por conta de anúncio. Mesmas regras do saldo:
 *  - só as conexões e contas do PRÓPRIO usuário (`loadOwnScope`);
 *  - o cliente NUNCA informa a BC de uma conta: ela é descoberta aqui, e conexão, BC e conta são conferidas contra o que o usuário tem;
 *  - em cache (gasto 10 min, histórico 30 s) e com poucas chamadas ao mesmo tempo (o TikTok limita a frequência).
 */
export function createBalanceActivityService({ tiktok, connections, log = console, now = () => new Date() }) {
  const spendCache = new TtlCache({ ttlMs: SPEND_TTL_MS, maxEntries: 100 });
  const historyCache = new TtlCache({ ttlMs: HISTORY_TTL_MS, maxEntries: 500 });
  const inflight = new Map();

  /** Gasto vitalício de um grupo de contas de UMA conexão. Se o lote falhar, repete conta por conta para isolar a que deu problema. */
  async function spendOfChunk(connection, ids, currencies) {
    const result = new Map();
    const fail = (list, error) => list.forEach((id) => result.set(id, { error }));
    const ask = (list) => tiktok.withToken(connection.id, (token, api) => api.getLifetimeSpend(token, list));
    const ok = (id, found) => result.set(id, { spend: found?.spend ?? 0, currency: found?.currency ?? currencies.get(id) ?? null }); // sem linha = nunca gastou
    try {
      const found = await ask(ids);
      for (const id of ids) ok(id, found.get(id));
    } catch (err) {
      if (!(err instanceof HttpError) || err.code === 'tiktok_reauth' || err.code === 'tiktok_rate_limited' || ids.length === 1) {
        log.warn?.(`[gasto] conexão ${connection.id}: ${err?.code ?? 'erro'}`); // sem token nem dados
        fail(ids, friendly(err, 'o gasto'));
        return result;
      }
      for (const id of ids) { // uma conta recusada derrubou o lote: tenta uma por vez
        try {
          ok(id, (await ask([id])).get(id));
        } catch (inner) {
          fail([id], friendly(inner, 'o gasto'));
        }
      }
    }
    return result;
  }

  async function buildSpend(actor, { own, known }) {
    const accounts = {};
    const tasks = [];
    for (const connection of own) {
      const mine = known.filter((a) => a.businessCenterId === connection.id);
      if (connection.status !== 'active') {
        for (const a of mine) accounts[`${connection.id}:${a.id}`] = { error: 'Esta conexão está com erro de acesso. Renove o acesso em Contas TikTok.' };
        continue;
      }
      const currencies = new Map(mine.map((a) => [a.id, a.currency ?? null]));
      for (const ids of chunk(mine.map((a) => a.id), SPEND_CHUNK)) tasks.push({ connection, ids, currencies });
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(SPEND_CONCURRENCY, tasks.length) }, async () => {
      while (next < tasks.length) {
        const task = tasks[next];
        next += 1;
        const result = await spendOfChunk(task.connection, task.ids, task.currencies);
        for (const [id, value] of result) accounts[`${task.connection.id}:${id}`] = value;
      }
    }));

    // Cada BC soma o gasto das contas dela (moedas diferentes nunca se somam).
    const bcs = {};
    for (const connection of own) {
      for (const bcId of bcIdsOf(connection)) {
        const members = known.filter((a) => a.businessCenterId === connection.id && bcOfAccount(a, connection) === bcId);
        const totals = new Map();
        let failed = 0;
        for (const a of members) {
          const value = accounts[`${connection.id}:${a.id}`];
          if (!value || value.error) {
            failed += 1;
            continue;
          }
          const code = value.currency ?? 'UNKNOWN';
          totals.set(code, (totals.get(code) ?? 0) + value.spend);
        }
        bcs[`${connection.id}:${bcId}`] = { totals: [...totals].map(([currency, spend]) => ({ currency, spend })).sort((x, y) => y.spend - x.spend), accounts: members.length, failed };
      }
    }
    return { fetchedAt: now().toISOString(), accounts, bcs };
  }

  /** Mensagem para a tela quando o histórico não pôde ser lido. */
  const historyError = (err) => new HttpError(502, friendly(err, 'o histórico de depósitos'), 'history_unavailable'); // nunca 401/403 do TikTok: a tela trataria como sessão do sistema

  return {
    /** Gasto total (vitalício) por conta e por BC. `fresh` ignora o cache de 10 min. Pedidos simultâneos compartilham o resultado. */
    async spend(actor, { fresh = false } = {}) {
      const scope = await loadOwnScope(connections, actor);
      const signature = scope.own.map((c) => `${c.id}.${c.status}.${c.lastSyncedAt}.${(c.ownerBcIds ?? []).join('-')}`).join('|');
      const key = `spend:${actor.id}:${signature}:${scope.known.length}`;
      if (fresh) spendCache.delete(key);
      const cached = spendCache.get(key);
      if (cached) return cached;
      if (inflight.has(key)) return inflight.get(key);
      const promise = buildSpend(actor, scope).then((data) => {
        spendCache.set(key, data);
        return data;
      }).finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    },

    /**
     * Histórico de depósitos de UMA Business Center (`kind` 'bc') ou de UMA conta de anúncio (`kind` 'account'), paginado.
     * Confere: parâmetros válidos, conexão do próprio usuário e ativa, BC da conexão, conta conhecida da conexão (a BC dela vem do banco).
     */
    async history(actor, rawQuery) {
      const { value: q, errors } = normalizeHistoryQuery(rawQuery);
      if (errors.length) throw badRequest(errors[0].message, 'validation_error');
      const { own, known } = await loadOwnScope(connections, actor);
      const connection = own.find((c) => c.id === q.connectionId);
      if (!connection) throw notFound('Conexão não encontrada.');
      if (connection.status !== 'active') throw new HttpError(409, 'Esta conexão está com erro de acesso. Renove o acesso em Contas TikTok.', 'tiktok_connection_error');

      let bcId;
      let accountIds = null;
      if (q.kind === 'bc') {
        if (!bcIdsOf(connection).includes(q.bcId)) throw notFound('Business Center não encontrada nesta conexão.');
        bcId = q.bcId;
      } else {
        const account = known.find((a) => a.businessCenterId === connection.id && a.id === q.advertiserId);
        if (!account) throw notFound('Conta de anúncio não encontrada nesta conexão.');
        bcId = bcOfAccount(account, connection);
        if (!bcId) throw new HttpError(409, 'O sistema ainda não sabe a Business Center desta conta. Use "Atualizar contas" em Contas TikTok.', 'bc_unknown');
        accountIds = [account.id];
      }

      const span = historyWindow(q.range, now());
      const key = `history:${actor.id}:${connection.id}:${q.kind}:${bcId}:${accountIds?.[0] ?? ''}:${q.range}:${q.filter}:${q.page}:${span.startTime.slice(0, 10)}`;
      const cached = historyCache.get(key);
      if (cached) return cached;
      try {
        const { transactions, pageInfo } = await tiktok.withToken(connection.id, (token, api) => api.listTransactions(token, {
          bcId, level: q.kind === 'bc' ? 'BC' : 'ADVERTISER', accountIds, types: q.filter === 'deposits' ? [...DEPOSIT_TYPES] : null,
          startTime: span.startTime, endTime: span.endTime, page: q.page, pageSize: HISTORY_PAGE_SIZE,
        }));
        const data = { kind: q.kind, range: q.range, filter: q.filter, page: pageInfo.page, pageSize: HISTORY_PAGE_SIZE, totalNumber: pageInfo.totalNumber, totalPages: pageInfo.totalPage, transactions };
        historyCache.set(key, data);
        return data;
      } catch (err) {
        log.warn?.(`[historico] conexão ${connection.id}: ${err?.code ?? 'erro'}`); // sem token nem dados
        throw historyError(err);
      }
    },
  };
}
