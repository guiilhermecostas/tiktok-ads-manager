/**
 * Contas e rankings das perguntas sobre a operação (assistente do Início): período em horário LOCAL do navegador, anúncios rejeitados, gasto total
 * por moeda e os melhores anúncios por desempenho e por custo. Funções puras (sem DOM, sem rede), testadas em Node. Valores de moedas diferentes
 * NUNCA se misturam: tudo é agrupado por moeda.
 */

/** Situações do anúncio que significam "reprovado" pelo TikTok (tabela oficial de status do anúncio). */
export const REJECTED_AD_STATUSES = Object.freeze(new Set([
  'AD_STATUS_AUDIT_DENY', 'AD_STATUS_ADGROUP_AUDIT_DENY', 'AD_STATUS_REVIEW_PARTIALLY_APPROVED', 'AD_STATUS_PROMOTE_AD_OFFLINE_AUDIT', 'AD_STATUS_CREATIVE_PRODUCT_ALL_REJECTED',
]));
export const isRejectedStatus = (status) => REJECTED_AD_STATUSES.has(status);

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/**
 * Período em horário LOCAL (o do navegador): `{ from, to }` como Date (`to` exclusivo). Mesmos ids do Gerenciador.
 * today, yesterday, last7 (hoje + 6 dias), last14, last30, thisMonth, lastMonth.
 */
export function localRange(period, now = new Date()) {
  const today = startOfDay(now);
  switch (period) {
    case 'yesterday': return { from: addDays(today, -1), to: today };
    case 'last7': return { from: addDays(today, -6), to: addDays(today, 1) };
    case 'last14': return { from: addDays(today, -13), to: addDays(today, 1) };
    case 'last30': return { from: addDays(today, -29), to: addDays(today, 1) };
    case 'thisMonth': return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: addDays(today, 1) };
    case 'lastMonth': return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 1) };
    default: return { from: today, to: addDays(today, 1) };
  }
}

const inRange = (iso, from, to) => {
  const time = Date.parse(iso ?? '');
  return Number.isFinite(time) && time >= from.getTime() && time < to.getTime();
};

/** Gasto e métricas somados por moeda: `[{ currency, spend, impressions, clicks, conversions, count }]`, do maior gasto ao menor. */
export function totalsByCurrency(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.currency ?? 'UNKNOWN';
    const t = map.get(key) ?? { currency: key, spend: 0, impressions: 0, clicks: 0, conversions: 0, count: 0 };
    t.spend += row.spend ?? 0;
    t.impressions += row.impressions ?? 0;
    t.clicks += row.clicks ?? 0;
    t.conversions += row.conversions ?? 0;
    t.count += 1;
    map.set(key, t);
  }
  return [...map.values()].sort((a, b) => b.spend - a.spend);
}

/**
 * Anúncios reprovados: `{ inPeriod, total }`. "No período" = reprovado AGORA e com a última alteração dentro do período (o TikTok atualiza a data
 * ao reprovar; não há data exata da reprovação); `total` = todos os reprovados no momento.
 */
export function rejectedAds(rows, { from, to }) {
  const rejected = rows.filter((r) => isRejectedStatus(r.status));
  return { inPeriod: rejected.filter((r) => inRange(r.modifiedAt, from, to)), total: rejected };
}

/** Anúncios com gasto, do melhor ao pior desempenho: mais conversões, depois maior CTR, depois maior gasto. Até `limit`, por moeda. */
export function bestByPerformance(rows, limit = 5) {
  const by = new Map();
  for (const r of rows.filter((x) => (x.spend ?? 0) > 0)) by.set(r.currency ?? 'UNKNOWN', [...(by.get(r.currency ?? 'UNKNOWN') ?? []), r]);
  return [...by.entries()].map(([currency, list]) => ({
    currency,
    rows: list.sort((a, b) => (b.conversions ?? 0) - (a.conversions ?? 0) || (b.ctr ?? 0) - (a.ctr ?? 0) || b.spend - a.spend).slice(0, limit),
  })).sort((a, b) => b.rows.reduce((s, r) => s + r.spend, 0) - a.rows.reduce((s, r) => s + r.spend, 0));
}

/**
 * Melhores anúncios em CUSTO, por moeda: o menor custo por resultado (entre os que têm resultado); se nenhum tiver, o menor CPC (entre os que têm cliques).
 * Só entram anúncios com gasto relevante (pelo menos 2% do gasto da moeda, mínimo 1 unidade): custo baixo com gasto ínfimo não significa nada.
 * Devolve `[{ currency, metric: 'costPerResult' | 'cpc', rows }]`.
 */
export function bestByCost(rows, limit = 5) {
  const groups = new Map();
  for (const r of rows.filter((x) => (x.spend ?? 0) > 0)) groups.set(r.currency ?? 'UNKNOWN', [...(groups.get(r.currency ?? 'UNKNOWN') ?? []), r]);
  const out = [];
  for (const [currency, list] of groups) {
    const total = list.reduce((s, r) => s + r.spend, 0);
    const relevant = list.filter((r) => r.spend >= Math.max(1, total * 0.02));
    const withResult = relevant.filter((r) => (r.result ?? 0) > 0 && (r.costPerResult ?? 0) > 0);
    if (withResult.length) {
      out.push({ currency, metric: 'costPerResult', rows: withResult.sort((a, b) => a.costPerResult - b.costPerResult || b.spend - a.spend).slice(0, limit) });
      continue;
    }
    const withClicks = relevant.filter((r) => (r.clicks ?? 0) > 0 && (r.cpc ?? 0) > 0);
    if (withClicks.length) out.push({ currency, metric: 'cpc', rows: withClicks.sort((a, b) => a.cpc - b.cpc || b.spend - a.spend).slice(0, limit) });
  }
  return out.sort((a, b) => b.rows.reduce((s, r) => s + r.spend, 0) - a.rows.reduce((s, r) => s + r.spend, 0));
}

/** Contas que caíram: mudanças em que a conta ERA ativa (ou não se sabia) e passou a um estado de queda. `down`: lista de status de queda. */
export function accountsThatDropped(events, down) {
  const seen = new Set();
  const dropped = [];
  for (const e of events) {
    if (!down.includes(e.status) || e.previousStatus === null || down.includes(e.previousStatus)) continue; // primeira leitura não é "queda" (não sabemos desde quando)
    if (seen.has(e.advertiserId)) continue;
    seen.add(e.advertiserId);
    dropped.push(e);
  }
  return dropped;
}

/** Situações da CONTA de anúncio (tabela "Advertiser Status" da documentação oficial) em português. STATUS_ENABLE = aprovada e ativa. */
export const ACCOUNT_STATUS_LABELS = Object.freeze({
  STATUS_ENABLE: 'Ativa',
  STATUS_LIMIT: 'Punida pelo TikTok',
  STATUS_DISABLE: 'Encerrada',
  STATUS_PENDING_CONFIRM: 'Em análise',
  STATUS_PENDING_VERIFIED: 'Aguardando verificação',
  STATUS_CONFIRM_FAIL: 'Reprovada na análise',
  STATUS_CONFIRM_FAIL_END: 'Reprovada na análise final',
  STATUS_PENDING_CONFIRM_MODIFY: 'Alterações em análise',
  STATUS_CONFIRM_MODIFY_FAIL: 'Alterações reprovadas',
  STATUS_WAIT_FOR_BPM_AUDIT: 'Aguardando análise',
  STATUS_WAIT_FOR_PUBLIC_AUTH: 'Aguardando autenticação bancária',
  STATUS_SELF_SERVICE_UNAUDITED: 'Aguardando verificação das qualificações',
  STATUS_CONTRACT_PENDING: 'Contrato ainda não vigora',
});
/** Situações que contam como a conta ter "caído" (punida, encerrada ou reprovada). */
export const DOWN_STATUSES = Object.freeze(['STATUS_LIMIT', 'STATUS_DISABLE', 'STATUS_CONFIRM_FAIL', 'STATUS_CONFIRM_FAIL_END', 'STATUS_CONFIRM_MODIFY_FAIL']);
export const accountStatusLabel = (status) => ACCOUNT_STATUS_LABELS[status] ?? String(status ?? '—').replace(/^STATUS_/, '').replace(/_/g, ' ').toLowerCase();
