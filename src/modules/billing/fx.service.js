import { BASE_CURRENCY } from '../../../shared/billing.js';

const REFRESH_EVERY_MS = 6 * 60 * 60 * 1000; // a fonte publica poucas vezes por dia
const TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 200_000;
const MAX_CURRENCIES = 40;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Câmbio da cobrança: mantém, para cada moeda em que alguém anuncia, quantos REAIS vale 1 unidade.
 *  - A fonte é pública e SEM chave (Frankfurter, https://frankfurter.dev). Na requisição vai só a lista de moedas: nenhum dado de pessoa, conta ou valor.
 *  - Cotação fixada à mão pelo admin (`source = 'manual'`) NUNCA é sobrescrita; remover a cotação manual devolve a moeda à atualização automática.
 *  - Se a fonte falhar, ficam as últimas cotações guardadas (a cobrança nunca para por isso) e o erro aparece no painel do admin, sem expor endereços.
 *  - A resposta é conferida: só moedas pedidas, números finitos e positivos, tamanho limitado. O endereço vem da configuração do servidor, nunca de quem usa o sistema.
 */
export function createFxService({ repo, config, fetchFn = fetch, log = console, now = () => new Date() }) {
  let timer = null;
  let inflight = null;
  const status = { lastOkAt: null, lastError: null };

  /** Moedas a buscar: o dólar (usado também no nível de gasto), as que aparecem no livro de gasto e as que já têm cotação automática. */
  async function currenciesToFetch() {
    const [ledger, rates] = await Promise.all([repo.ledgerCurrencies(), repo.listRates()]);
    const wanted = new Set(['USD', ...ledger, ...rates.filter((r) => r.source === 'auto').map((r) => r.currency)]);
    return [...wanted].filter((c) => CURRENCY_RE.test(c) && c !== BASE_CURRENCY).sort().slice(0, MAX_CURRENCIES);
  }

  async function fetchRates(list) {
    const url = `${config.baseUrl}/rates?base=${BASE_CURRENCY}&quotes=${list.join(',')}`;
    const response = await fetchFn(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`a fonte de cotações respondeu ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_BODY_CHARS) throw new Error('a resposta da fonte de cotações é grande demais');
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('resposta inesperada da fonte de cotações');
    const wanted = new Set(list);
    const rates = [];
    for (const item of data) {
      // A fonte devolve "1 BRL = X moeda". Queremos o inverso: quantos reais vale 1 unidade da moeda.
      if (item?.base !== BASE_CURRENCY || !wanted.has(item.quote) || typeof item.rate !== 'number' || !Number.isFinite(item.rate) || item.rate <= 0) continue;
      const brlPerUnit = Number((1 / item.rate).toFixed(10));
      if (brlPerUnit > 0 && brlPerUnit <= 1_000_000) rates.push({ currency: item.quote, brlPerUnit });
    }
    if (!rates.length) throw new Error('a fonte de cotações não devolveu nenhuma moeda pedida');
    return rates;
  }

  async function doRefresh() {
    if (!config.enabled) return { updated: 0, requested: 0, missing: [], disabled: true };
    const list = await currenciesToFetch();
    try {
      const rates = await fetchRates(list);
      const updated = await repo.upsertAutoRates(rates);
      status.lastOkAt = now().toISOString();
      status.lastError = null;
      const got = new Set(rates.map((r) => r.currency));
      return { updated, requested: list.length, missing: list.filter((c) => !got.has(c)), disabled: false };
    } catch (err) {
      status.lastError = err?.name === 'TimeoutError' ? 'a fonte de cotações demorou demais para responder' : String(err?.message ?? 'falha ao buscar as cotações').slice(0, 200);
      throw err;
    }
  }

  return {
    /** Busca e grava as cotações agora. Pedidos simultâneos compartilham o mesmo resultado. Lança se a fonte falhar. */
    refresh() {
      inflight ??= doRefresh().finally(() => { inflight = null; });
      return inflight;
    },
    status: () => ({ enabled: config.enabled, ...status }),
    /** Liga a atualização a cada 6 h (só o servidor liga, nunca os testes). */
    start() {
      if (timer || !config.enabled) return;
      const run = () => doRefresh().then((r) => { if (r.updated) log.info?.(`[câmbio] ${r.updated} cotação(ões) atualizada(s)`); }).catch((err) => log.warn?.(`[câmbio] não foi possível atualizar: ${status.lastError ?? err?.message}`));
      run();
      timer = setInterval(run, REFRESH_EVERY_MS);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
