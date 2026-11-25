/**
 * Gerenciador de anúncios: colunas, períodos e visualizações salvas. Fonte ÚNICA usada pelo servidor (validação do que é salvo) e pela
 * tela (cabeçalhos, ordem, formatos), para os dois nunca divergirem.
 */

/**
 * Catálogo de colunas. `type` decide o formato; `sortable` se dá para ordenar; `defaultVisible` se aparece na visualização padrão.
 * As métricas vêm do relatório do TikTok (nível anúncio): "Cliques" e "CPC" são os de destino (cliques no link), como no Ads Manager.
 */
export const MANAGER_COLUMNS = Object.freeze([
  // `levels`: em quais níveis a coluna existe (campaigns, adgroups, ads). O rótulo da coluna "name" muda com o nível (ver `columnLabel`).
  { key: 'name', label: 'Nome', type: 'name', sortable: true, defaultVisible: true, levels: ['campaigns', 'adgroups', 'ads'] },
  { key: 'status', label: 'Status', type: 'status', sortable: true, defaultVisible: true, levels: ['campaigns', 'adgroups', 'ads'] },
  { key: 'toggle', label: 'Ativo', type: 'toggle', sortable: true, defaultVisible: true, levels: ['campaigns', 'adgroups', 'ads'] },
  { key: 'objective', label: 'Objetivo', type: 'objective', sortable: true, defaultVisible: true, levels: ['campaigns'] },
  { key: 'goal', label: 'Meta de otimização', type: 'goal', sortable: true, defaultVisible: true, levels: ['adgroups'] },
  { key: 'budget', label: 'Orçamento', type: 'budget', sortable: true, defaultVisible: true, levels: ['campaigns', 'adgroups'] },
  { key: 'createdAt', label: 'Publicado em', type: 'datetime', sortable: true, defaultVisible: true, levels: ['campaigns', 'adgroups', 'ads'] },
  { key: 'result', label: 'Resultado', type: 'number', sortable: true, defaultVisible: true, levels: ['campaigns', 'adgroups', 'ads'] },
  { key: 'spend', label: 'Valor gasto', type: 'money', sortable: true, defaultVisible: true, levels: ['campaigns', 'adgroups', 'ads'] },
  { key: 'cpc', label: 'CPC (link)', type: 'money', sortable: true, defaultVisible: true, levels: ['campaigns', 'adgroups', 'ads'] },
  { key: 'clicks', label: 'Cliques (link)', type: 'number', sortable: true, defaultVisible: true, levels: ['campaigns', 'adgroups', 'ads'] },
  { key: 'ctr', label: 'CTR', type: 'percent', sortable: true, defaultVisible: true, levels: ['campaigns', 'adgroups', 'ads'] },
  { key: 'account', label: 'Conta', type: 'text', sortable: true, defaultVisible: false, levels: ['campaigns', 'adgroups', 'ads'] },
  { key: 'campaign', label: 'Campanha', type: 'text', sortable: true, defaultVisible: false, levels: ['adgroups', 'ads'] },
  { key: 'adgroup', label: 'Grupo de anúncios', type: 'text', sortable: true, defaultVisible: false, levels: ['ads'] },
  { key: 'impressions', label: 'Impressões', type: 'number', sortable: true, defaultVisible: false, levels: ['campaigns', 'adgroups', 'ads'] },
  { key: 'costPerResult', label: 'Custo por resultado', type: 'money', sortable: true, defaultVisible: false, levels: ['campaigns', 'adgroups', 'ads'] },
  { key: 'conversions', label: 'Conversões', type: 'number', sortable: true, defaultVisible: false, levels: ['campaigns', 'adgroups', 'ads'] },
  { key: 'costPerConversion', label: 'Custo por conversão', type: 'money', sortable: true, defaultVisible: false, levels: ['campaigns', 'adgroups', 'ads'] },
  { key: 'modifiedAt', label: 'Editado em', type: 'datetime', sortable: true, defaultVisible: false, levels: ['campaigns', 'adgroups', 'ads'] },
]);

const NAME_LABELS = Object.freeze({ campaigns: 'Campanha', adgroups: 'Grupo de anúncios', ads: 'Anúncio' });
/** Rótulo da coluna no nível (a primeira coluna é "Campanha", "Grupo de anúncios" ou "Anúncio"). */
export const columnLabel = (col, level) => (col.key === 'name' ? (NAME_LABELS[level] ?? col.label) : col.label);
/** A coluna existe neste nível? */
export const appliesTo = (col, level) => col.levels.includes(level);

export const COLUMN_KEYS = Object.freeze(MANAGER_COLUMNS.map((c) => c.key));
export const SORTABLE_KEYS = Object.freeze(MANAGER_COLUMNS.filter((c) => c.sortable).map((c) => c.key));
export const columnOf = (key) => MANAGER_COLUMNS.find((c) => c.key === key) ?? null;

/** Períodos prontos. O padrão é HOJE. Cada conta usa o PRÓPRIO fuso horário para saber o que é "hoje". */
export const DATE_PRESETS = Object.freeze([
  { id: 'today', label: 'Hoje' },
  { id: 'yesterday', label: 'Ontem' },
  { id: 'last7', label: 'Últimos 7 dias' },
  { id: 'last14', label: 'Últimos 14 dias' },
  { id: 'last30', label: 'Últimos 30 dias' },
  { id: 'thisMonth', label: 'Este mês' },
  { id: 'lastMonth', label: 'Mês passado' },
]);
export const DEFAULT_PRESET = 'today';
export const PRESET_IDS = Object.freeze(DATE_PRESETS.map((p) => p.id));
/** Maior período personalizado (dias): o relatório do TikTok aceita até 365 sem quebra por tempo; limitamos para manter a tela rápida. */
export const MAX_CUSTOM_DAYS = 90;

/** Filtro de situação da tela. */
export const STATUS_FILTERS = Object.freeze(['', 'active', 'paused', 'delivering', 'problem']);

/** Limites das visualizações salvas. */
export const MAX_VIEWS_PER_USER = 20;
export const MAX_VIEW_NAME = 40;

/** Configuração padrão: colunas padrão na ordem do catálogo, ordenado por valor gasto (maior primeiro), sem filtros. */
export function defaultViewConfig() {
  return {
    columns: MANAGER_COLUMNS.map((c) => ({ key: c.key, visible: c.defaultVisible })), // colunas que não existem no nível são ignoradas ao desenhar
    sort: { key: 'spend', dir: 'desc' },
    filters: { status: '', accountId: '', onlySpent: false },
    datePreset: DEFAULT_PRESET,
    pageSize: 100,
  };
}

const PAGE_SIZES = [50, 100, 200];

/**
 * Valida e normaliza uma visualização (do navegador OU do banco). Nunca confia no que veio: devolve só campos conhecidos, completa
 * colunas que faltam (ao final, ocultas) e recusa chaves desconhecidas ou repetidas. Retorna `null` se for inválida.
 */
export function normalizeViewConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  if (!Array.isArray(input.columns) || input.columns.length < 1 || input.columns.length > COLUMN_KEYS.length) return null;
  const seen = new Set();
  const columns = [];
  for (const col of input.columns) {
    if (col === null || typeof col !== 'object' || !COLUMN_KEYS.includes(col.key) || seen.has(col.key) || typeof col.visible !== 'boolean') return null;
    seen.add(col.key);
    columns.push({ key: col.key, visible: col.visible });
  }
  // Coluna que faltava (visualização salva antes dela existir): fica oculta, EXCETO as exclusivas de campanhas/grupos (a visualização só tinha anúncios,
  // então nada muda lá) — assim já aparecem Objetivo, Meta e Orçamento nas novas abas.
  for (const key of COLUMN_KEYS) {
    if (seen.has(key)) continue;
    const col = columnOf(key);
    columns.push({ key, visible: col.defaultVisible && !col.levels.includes('ads') });
  }
  if (!columns.some((c) => c.visible && c.key === 'name')) return null; // o nome do anúncio é a âncora da tabela: sempre visível

  const sort = input.sort ?? {};
  if (!SORTABLE_KEYS.includes(sort.key) || !['asc', 'desc'].includes(sort.dir)) return null;

  const filters = input.filters ?? {};
  if (!STATUS_FILTERS.includes(filters.status ?? '')) return null;
  const accountId = filters.accountId ?? '';
  if (typeof accountId !== 'string' || (accountId !== '' && !/^\d{1,24}$/.test(accountId))) return null;
  if (typeof (filters.onlySpent ?? false) !== 'boolean') return null;

  if (!PRESET_IDS.includes(input.datePreset ?? DEFAULT_PRESET)) return null;
  const pageSize = input.pageSize ?? 100;
  if (!PAGE_SIZES.includes(pageSize)) return null;

  return {
    columns,
    sort: { key: sort.key, dir: sort.dir },
    filters: { status: filters.status ?? '', accountId, onlySpent: filters.onlySpent ?? false },
    datePreset: input.datePreset ?? DEFAULT_PRESET,
    pageSize,
  };
}
