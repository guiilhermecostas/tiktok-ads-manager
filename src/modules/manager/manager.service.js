import { MANAGER_COLUMNS, MAX_CUSTOM_DAYS, MAX_VIEWS_PER_USER, MAX_VIEW_NAME, PRESET_IDS, defaultViewConfig, normalizeViewConfig } from '../../../shared/manager-columns.js';
import { isUniqueViolation } from '../../db/helpers.js';
import { rangeDays, resolveRange } from '../../lib/date-range.js';
import { HttpError, badRequest, notFound } from '../../lib/http-error.js';
import { TtlCache } from '../../lib/ttl-cache.js';

const CACHE_TTL_MS = 60_000;
const CONCURRENCY = 4; // contas consultadas ao mesmo tempo (o ritmo por endpoint é controlado pelo cliente; o TikTok limita 10/s por app)
const ACCOUNT_REUSE_MS = 15_000; // "Atualizar" reaproveita contas que acabaram de carregar certo (só refaz as que falharam ou ficaram velhas)
const MAX_ACCOUNTS = 100;
const MAX_ADS_TOTAL = 20_000;
const STATUS_CHUNK = 20; // /ad/status/update/: até 20 anúncios por pedido

/** Mensagem segura para a tela quando o TikTok recusa a consulta de uma conta (nunca token nem detalhes internos). */
function friendly(err) {
  if (err instanceof HttpError) {
    if (err.code === 'tiktok_reauth') return 'O acesso desta conexão expirou ou foi revogado. Renove o acesso em Contas TikTok.';
    if (err.code === 'tiktok_rate_limited') return 'O TikTok limitou as consultas. Tente de novo em instantes.';
    if (['tiktok_error', 'proxy_error', 'tiktok_unreachable', 'tiktok_token_unreadable'].includes(err.code)) return err.message;
  }
  return 'Não foi possível consultar esta conta agora.';
}

const ZERO = { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, result: 0, costPerResult: 0, conversions: 0, costPerConversion: 0 };

/**
 * Gerenciador de anúncios: todos os anúncios de todas as contas do usuário em UMA consulta (anúncios + desempenho do período), com
 * ativar/pausar e visualizações salvas por pessoa.
 *  - Cada conta usa o PRÓPRIO fuso horário para o período ("Hoje" é o hoje da conta); a lista e o desempenho vêm do TikTok com o token
 *    da BC dona e, se houver, pela proxy dela.
 *  - Falha em uma conta aparece naquela conta; as outras seguem. Resultado em cache por 60 s (muda ao ativar/pausar).
 *  - Nunca exclui anúncios: só ENABLE e DISABLE.
 */
export function createManagerService({ tiktok, connections, views, log = console, now = () => new Date() }) {
  const cache = new TtlCache({ ttlMs: CACHE_TTL_MS, maxEntries: 50 });
  const inflight = new Map();
  const versions = new Map(); // pessoa -> contador que invalida o cache dela depois de ativar/pausar
  const accountVersions = new Map(); // `pessoa:conta` -> contador (ativar/pausar numa conta só invalida aquela conta)
  const accountResults = new TtlCache({ ttlMs: CACHE_TTL_MS * 2, maxEntries: 500 }); // resultado COMPLETO de cada conta (a idade fica em `at`)

  /** Anúncios primeiro; o desempenho só é pedido se a conta TEM anúncios (conta vazia = 1 chamada, não 2). */
  async function fetchAccount(account, range) {
    try {
      return await tiktok.withToken(account.businessCenterId, async (token, api) => {
        const ads = (await Promise.allSettled([api.listAds(token, account.id)]))[0];
        if (ads.status === 'rejected') {
          if (ads.reason instanceof HttpError && ads.reason.code === 'tiktok_reauth') throw ads.reason;
          return { ads, metrics: ads };
        }
        if (!ads.value.ads.length) return { ads, metrics: { status: 'fulfilled', value: { metrics: new Map(), hasResult: true } } };
        const metrics = (await Promise.allSettled([api.getAdMetrics(token, account.id, { startDate: range.from, endDate: range.to })]))[0];
        if (metrics.status === 'rejected' && metrics.reason instanceof HttpError && metrics.reason.code === 'tiktok_reauth') throw metrics.reason;
        return { ads, metrics };
      });
    } catch (err) {
      log.warn?.(`[gerenciador] conta ${account.id}: ${err?.code ?? 'erro'}`); // sem token nem dados
      const error = friendly(err);
      return { ads: { status: 'rejected', reason: err, message: error }, metrics: { status: 'rejected', reason: err, message: error } };
    }
  }

  const isThrottled = (result) => [result.ads, result.metrics].some((r) => r.status === 'rejected' && r.reason instanceof HttpError && r.reason.code === 'tiktok_rate_limited');
  const completed = (result) => result.ads.status === 'fulfilled' && result.metrics.status === 'fulfilled';
  const PAUSED = 'O TikTok pediu uma pausa nas consultas (limite de frequência). Clique em Atualizar em alguns instantes: só esta conta será consultada de novo.';

  async function build(actor, { preset, from, to, accounts, fresh }) {
    const tasks = accounts.map((account) => ({ account, range: resolveRange(preset, { timeZone: account.timezone, now: now(), from, to }) }));
    const results = new Array(tasks.length);
    let next = 0;
    let throttled = false; // o TikTok pediu pausa: não insiste nas contas que faltam (a suspensão pode durar minutos)
    const accountKey = ({ account, range }) => `acct:${actor.id}:${account.id}:${range.from}:${range.to}:${accountVersions.get(`${actor.id}:${account.id}`) ?? 0}`;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
      while (next < tasks.length) {
        const index = next;
        next += 1;
        const key = accountKey(tasks[index]);
        const saved = accountResults.get(key);
        if (saved && now().getTime() - saved.at < (fresh ? ACCOUNT_REUSE_MS : CACHE_TTL_MS)) {
          results[index] = saved.result;
          continue;
        }
        if (throttled) {
          results[index] = { ads: { status: 'rejected', reason: null, message: PAUSED }, metrics: { status: 'rejected', reason: null, message: PAUSED } };
          continue;
        }
        const result = await fetchAccount(tasks[index].account, tasks[index].range);
        if (isThrottled(result)) throttled = true;
        if (completed(result)) accountResults.set(key, { at: now().getTime(), result }); // só guarda o que carregou inteiro
        results[index] = result;
      }
    }));

    const rows = [];
    const accountList = [];
    let truncated = false;
    tasks.forEach(({ account, range }, index) => {
      const { ads, metrics } = results[index];
      const base = { id: account.id, name: account.name, currency: account.currency, timezone: account.timezone, connectionId: account.businessCenterId, from: range.from, to: range.to };
      if (ads.status !== 'fulfilled') {
        accountList.push({ ...base, status: 'error', error: ads.message ?? friendly(ads.reason), adsCount: 0, metricsError: null, hasResult: true });
        return;
      }
      const stats = metrics.status === 'fulfilled' ? metrics.value : null;
      if (ads.value.truncated) truncated = true;
      for (const ad of ads.value.ads) {
        if (rows.length >= MAX_ADS_TOTAL) {
          truncated = true;
          break;
        }
        const m = stats?.metrics.get(ad.adId) ?? ZERO;
        const hasResult = stats ? stats.hasResult : false;
        rows.push({
          key: `${account.id}:${ad.adId}`, ...ad, accountName: account.name, currency: account.currency,
          spend: m.spend, impressions: m.impressions, clicks: m.clicks, ctr: m.ctr, cpc: m.cpc,
          result: hasResult ? m.result : null, costPerResult: hasResult ? m.costPerResult : null, conversions: m.conversions, costPerConversion: m.costPerConversion,
          hasMetrics: Boolean(stats),
        });
      }
      accountList.push({ ...base, status: 'ok', error: null, adsCount: ads.value.ads.length, metricsError: stats ? null : (metrics.message ?? friendly(metrics.reason)), hasResult: stats ? stats.hasResult : false });
    });

    return {
      fetchedAt: now().toISOString(),
      range: { preset, from: accountList[0]?.from ?? null, to: accountList[0]?.to ?? null, custom: preset === 'custom' },
      truncated,
      accounts: accountList,
      ads: rows,
    };
  }

  /** Valida o período pedido (predefinido ou personalizado) e devolve { preset, from, to } ou lança 400. */
  function parseRange({ preset, from, to }) {
    const chosen = preset ?? 'today';
    if (chosen === 'custom') {
      const range = resolveRange('custom', { from, to });
      if (!range) throw badRequest('Período inválido: informe as duas datas (AAAA-MM-DD), a inicial não pode ser depois da final.');
      if (rangeDays(range.from, range.to) > MAX_CUSTOM_DAYS) throw badRequest(`O período personalizado pode ter no máximo ${MAX_CUSTOM_DAYS} dias.`);
      return { preset: 'custom', ...range };
    }
    if (!PRESET_IDS.includes(chosen)) throw badRequest('Período inválido.');
    return { preset: chosen, from: null, to: null };
  }

  const viewName = (value) => {
    const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > MAX_VIEW_NAME) throw badRequest(`O nome da visualização deve ter de 1 a ${MAX_VIEW_NAME} caracteres.`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) throw badRequest('O nome da visualização contém caracteres inválidos.');
    return name;
  };

  return {
    columns: MANAGER_COLUMNS,
    defaultViewConfig,

    /** Todos os anúncios das contas ativas do usuário, com o desempenho do período. `fresh` ignora o cache de 60 s. */
    async ads(actor, query = {}, { fresh = false } = {}) {
      const range = parseRange(query);
      const all = (await connections.advertisers(actor.id)).filter((a) => a.businessCenterStatus === 'active');
      const accounts = all.slice(0, MAX_ACCOUNTS);
      const signature = accounts.map((a) => `${a.businessCenterId}.${a.id}.${a.timezone}`).join('|');
      const key = `ads:${actor.id}:${versions.get(actor.id) ?? 0}:${range.preset}:${range.from}:${range.to}:${signature}`;
      if (fresh) cache.delete(key);
      const cached = cache.get(key);
      if (cached) return cached;
      if (inflight.has(key)) return inflight.get(key);
      const promise = build(actor, { ...range, accounts, fresh }).then((data) => {
        cache.set(key, { ...data, totalAccounts: all.length });
        return { ...data, totalAccounts: all.length };
      }).finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    },

    /**
     * Ativa ou pausa anúncios de UMA conta (de 20 em 20, que é o limite do TikTok). Só contas visíveis ao usuário e ativas.
     * Devolve { status, updated: [ids confirmados], failed: [ids] }; falha parcial não esconde o que deu certo.
     */
    async setStatus(actor, { advertiserId, adIds, status }) {
      if (!['ENABLE', 'DISABLE'].includes(status)) throw badRequest('Status inválido (use ENABLE ou DISABLE).');
      const unique = [...new Set(adIds)];
      if (!unique.length || unique.length > 200) throw badRequest('Escolha de 1 a 200 anúncios.');
      const advertiser = await tiktok.assertAdvertiserAccess(actor, advertiserId); // 404 se a conta não for do usuário
      const updated = [];
      let failure = null;
      for (let i = 0; i < unique.length; i += STATUS_CHUNK) {
        const chunk = unique.slice(i, i + STATUS_CHUNK);
        try {
          const done = await tiktok.withToken(advertiser.businessCenterId, (token, api) => api.updateAdStatus(token, advertiserId, chunk, status));
          updated.push(...done);
        } catch (err) {
          if (!updated.length) throw err; // nada mudou: erro normal
          failure = friendly(err);
          break;
        }
      }
      versions.set(actor.id, (versions.get(actor.id) ?? 0) + 1); // a próxima consulta já mostra o novo status
      accountVersions.set(`${actor.id}:${advertiserId}`, (accountVersions.get(`${actor.id}:${advertiserId}`) ?? 0) + 1);
      log.info?.(`[gerenciador] usuário ${actor.id}: ${status} em ${updated.length} anúncio(s) da conta ${advertiserId}`);
      return { status, updated, failed: unique.filter((id) => !updated.includes(id)), failure };
    },

    // ---------- visualizações salvas (de cada PESSOA) ----------
    async listViews(user) {
      return views.list(user.id);
    },
    async createView(user, { name, config, isDefault = false }) {
      const clean = normalizeViewConfig(config);
      if (!clean) throw badRequest('Configuração da visualização inválida.');
      if ((await views.count(user.id)) >= MAX_VIEWS_PER_USER) throw new HttpError(409, `Você já tem ${MAX_VIEWS_PER_USER} visualizações (o máximo). Exclua alguma para salvar outra.`, 'too_many_views');
      try {
        const id = await views.create(user.id, { name: viewName(name), config: clean, isDefault: Boolean(isDefault) });
        return await views.get(user.id, id);
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, 'Já existe uma visualização com esse nome.', 'view_exists');
        throw err;
      }
    },
    async updateView(user, id, { name, config, isDefault }) {
      const clean = config === undefined ? undefined : normalizeViewConfig(config);
      if (config !== undefined && !clean) throw badRequest('Configuração da visualização inválida.');
      if (name === undefined && config === undefined && isDefault === undefined) throw badRequest('Nada para atualizar.');
      if (isDefault !== undefined && typeof isDefault !== 'boolean') throw badRequest('Valor inválido.');
      try {
        if (!(await views.update(user.id, id, { name: name === undefined ? undefined : viewName(name), config: clean, isDefault }))) throw notFound('Visualização não encontrada.');
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, 'Já existe uma visualização com esse nome.', 'view_exists');
        throw err;
      }
      return views.get(user.id, id);
    },
    async deleteView(user, id) {
      if (!(await views.remove(user.id, id))) throw notFound('Visualização não encontrada.');
    },
  };
}
