/**
 * Níveis do Gerenciador: campanhas, grupos de anúncios e anúncios (a hierarquia do TikTok). Fonte ÚNICA para o servidor (rotas, consultas) e
 * para a tela (abas, textos), para os dois nunca divergirem.
 */
export const MANAGER_LEVELS = Object.freeze({
  campaigns: {
    id: 'campaigns', tab: 'Campanhas', singular: 'campanha', plural: 'campanhas', article: 'a', idsField: 'campaignIds',
    searchHint: 'Buscar campanha, conta ou ID…', enabledStatus: 'CAMPAIGN_STATUS_ENABLE', disabledStatus: 'CAMPAIGN_STATUS_DISABLE',
    emptyHint: 'Quando você publicar campanhas, elas aparecem aqui.',
  },
  adgroups: {
    id: 'adgroups', tab: 'Grupos de anúncios', singular: 'grupo de anúncios', plural: 'grupos de anúncios', article: 'o', idsField: 'adgroupIds',
    searchHint: 'Buscar grupo, campanha, conta ou ID…', enabledStatus: 'ADGROUP_STATUS_DELIVERY_OK', disabledStatus: 'ADGROUP_STATUS_DISABLE',
    emptyHint: 'Quando você publicar campanhas, os grupos aparecem aqui.',
  },
  ads: {
    id: 'ads', tab: 'Anúncios', singular: 'anúncio', plural: 'anúncios', article: 'o', idsField: 'adIds',
    searchHint: 'Buscar anúncio, campanha, grupo, conta ou ID…', enabledStatus: 'AD_STATUS_DELIVERY_OK', disabledStatus: 'AD_STATUS_DISABLE',
    emptyHint: 'Quando você publicar campanhas, os anúncios aparecem aqui.',
  },
});

export const LEVEL_IDS = Object.freeze(Object.keys(MANAGER_LEVELS));
export const DEFAULT_LEVEL = 'campaigns';
export const isLevel = (value) => typeof value === 'string' && Object.hasOwn(MANAGER_LEVELS, value);

const humanize = (value) => {
  const text = String(value ?? '').replace(/_/g, ' ').toLowerCase().trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '—';
};

/** Objetivo da campanha (tabela "Advertising objective" da documentação oficial). */
const OBJECTIVES = Object.freeze({
  TRAFFIC: 'Tráfego', WEB_CONVERSIONS: 'Conversões no site', PRODUCT_SALES: 'Vendas de produtos', LEAD_GENERATION: 'Geração de leads',
  REACH: 'Alcance', VIDEO_VIEWS: 'Visualizações de vídeo', ENGAGEMENT: 'Engajamento', APP_PROMOTION: 'Promoção de app', RF_REACH: 'Alcance e frequência',
  SHOP_PURCHASES: 'Compras na loja', CATALOG_SALES: 'Vendas do catálogo', STORE_PURCHASES: 'Compras na loja',
});
export const objectiveLabel = (value) => (value ? (OBJECTIVES[value] ?? humanize(value)) : '—');

/** Meta de otimização do grupo (tabela "Optimization goal"). */
const GOALS = Object.freeze({
  CLICK: 'Cliques', CONVERT: 'Conversões', VALUE: 'Valor', SHOW: 'Impressões', REACH: 'Alcance', VIDEO_VIEW: 'Visualizações de vídeo',
  ENGAGED_VIEW: 'Visualizações engajadas', LEAD_GENERATION: 'Leads', INSTALL: 'Instalações', PAGE_VISIT: 'Visitas à página', FOLLOWERS: 'Seguidores',
  PROFILE_VIEWS: 'Visitas ao perfil', LANDING_PAGE_VIEW: 'Visualizações da página', SHOP_PURCHASE: 'Compras na loja',
});
export const goalLabel = (value) => (value ? (GOALS[value] ?? humanize(value)) : '—');

/** Texto do orçamento ("US$ 50,00/dia"); `formatMoney` formata o valor na moeda da conta. Sem orçamento próprio (CBO) explica de onde vem. */
export function budgetLabel(row, level, formatMoney) {
  const { budget, budgetMode } = row;
  if (!budgetMode) return '—';
  if (budgetMode === 'BUDGET_MODE_INFINITE') return level === 'adgroups' ? 'Definido na campanha' : 'Sem limite';
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return '—';
  const value = formatMoney(budget, row.currency);
  if (budgetMode === 'BUDGET_MODE_DAY') return `${value}/dia`;
  if (budgetMode === 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET') return `${value}/dia (médio)`;
  if (budgetMode === 'BUDGET_MODE_TOTAL') return `${value} no total`;
  return value;
}
