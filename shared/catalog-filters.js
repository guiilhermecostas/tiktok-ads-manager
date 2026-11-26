/**
 * Filtros e "ocultar" da lista de catálogos. Regras puras, usadas pela tela e pelo servidor (um só critério).
 * Ocultar é só VISUAL e vale para a pessoa que ocultou: o catálogo continua existindo no TikTok e para as outras pessoas.
 */
import { isCatalogId } from './catalog.js';

/** Quantos catálogos uma pessoa pode ter ocultos (impede a tabela de crescer sem limite) e quantos entram por pedido. */
export const MAX_HIDDEN_PER_USER = 1000;
export const MAX_HIDE_BATCH = 100;

export const STATUS_FILTERS = Object.freeze([
  ['', 'Todas as situações'],
  ['ready', 'Prontos para anúncios'],
  ['empty', 'Sem produtos disponíveis'],
]);
const STATUS_KEYS = STATUS_FILTERS.map(([key]) => key);

/** Texto sem acento e em minúsculas, para a busca ignorar maiúsculas e acentos. */
export const normalizeText = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const BC_ID_RE = /^\d{1,24}$/;
/** "País · moeda" de um catálogo (ex.: "US · USD"); vazio quando o TikTok não informou. */
export const regionLabel = (catalog) => (catalog.regionCode ? `${catalog.regionCode} · ${catalog.currency ?? '—'}` : '');

/** Filtros válidos: qualquer outra coisa vira "sem filtro" (nunca quebra a tela por causa de um valor antigo). */
export function normalizeFilters(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  return {
    bcId: typeof f.bcId === 'string' && BC_ID_RE.test(f.bcId) ? f.bcId : '',
    status: STATUS_KEYS.includes(f.status) ? f.status : '',
    region: typeof f.region === 'string' ? f.region.slice(0, 40) : '',
    q: typeof f.q === 'string' ? f.q.slice(0, 100) : '',
    showHidden: f.showHidden === true,
  };
}

export const hasActiveFilters = (filters) => Boolean(filters.bcId || filters.status || filters.region || filters.q.trim());

/** Aplica os filtros. Os ocultos só aparecem com `showHidden`. */
export function filterCatalogs(catalogs, rawFilters) {
  const filters = normalizeFilters(rawFilters);
  const q = normalizeText(filters.q.trim());
  return catalogs.filter((c) => {
    if (c.hidden && !filters.showHidden) return false;
    if (filters.bcId && c.bcId !== filters.bcId) return false;
    if (filters.status === 'ready' && !c.adCreationEligible) return false;
    if (filters.status === 'empty' && c.adCreationEligible) return false;
    if (filters.region && regionLabel(c) !== filters.region) return false;
    return !q || normalizeText(`${c.name} ${c.id} ${c.bcName ?? ''} ${c.bcId}`).includes(q);
  });
}

/**
 * Uma opção por Business Center (não por conexão: a mesma BC pode ter várias conexões), com o nome e quantos catálogos ela tem.
 * `countHidden`: conta também os ocultos (quando a pessoa está vendo os ocultos).
 */
export function bcOptions(catalogs, { countHidden = false } = {}) {
  const byBc = new Map();
  for (const c of catalogs) {
    if (c.hidden && !countHidden) continue;
    const entry = byBc.get(c.bcId) ?? { bcId: c.bcId, name: c.bcName || `BC ${c.bcId}`, count: 0 };
    entry.count += 1;
    if (c.bcName && entry.name.startsWith('BC ')) entry.name = c.bcName;
    byBc.set(c.bcId, entry);
  }
  return [...byBc.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.bcId.localeCompare(b.bcId));
}

/** Combinações de país e moeda que existem na lista (para o filtro "País · moeda"). */
export function regionOptions(catalogs, { countHidden = false } = {}) {
  return [...new Set(catalogs.filter((c) => countHidden || !c.hidden).map(regionLabel).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

/**
 * Confere o pedido de ocultar/mostrar: `items` = [{ bcId, catalogId }] (1 a 100, sem repetidos) e `hidden` = true | false.
 * Retorna { value: { items, hidden }, errors }.
 */
export function normalizeHideInput(raw) {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  if (typeof body.hidden !== 'boolean') errors.push({ path: 'hidden', message: 'Informe se é para ocultar ou mostrar.' });
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_HIDE_BATCH) {
    errors.push({ path: 'items', message: `Escolha de 1 a ${MAX_HIDE_BATCH} catálogos.` });
    return { value: null, errors };
  }
  const seen = new Set();
  const items = [];
  for (const item of body.items) {
    const bcId = item?.bcId;
    const catalogId = item?.catalogId;
    if (typeof bcId !== 'string' || !BC_ID_RE.test(bcId) || !isCatalogId(catalogId)) {
      errors.push({ path: 'items', message: 'Catálogo inválido.' });
      break;
    }
    if (seen.has(catalogId)) continue;
    seen.add(catalogId);
    items.push({ bcId, catalogId });
  }
  return { value: errors.length ? null : { items, hidden: body.hidden }, errors };
}
