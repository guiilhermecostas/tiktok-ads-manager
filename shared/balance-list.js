/**
 * Lista compacta de Saldo: situação de cada linha, filtro, busca, ordenação e somas por moeda. Regras puras (a tela e os testes usam as mesmas).
 * Uma "linha" é uma Business Center ou uma conta de anúncio, como o servidor devolve em `GET /api/tiktok/balance`.
 */

/** Situação de uma linha: with (tem saldo) | without (zerado) | unknown (erro ou o TikTok não informou). */
export const situationOf = (row) => (row.status !== 'ok' ? 'unknown' : row.hasBalance ? 'with' : 'without');

export const STATUS_FILTERS = Object.freeze([
  ['', 'Todas'],
  ['with', 'Com saldo'],
  ['without', 'Sem saldo'],
  ['unknown', 'Sem informação'],
]);
export const SORT_KEYS = Object.freeze(['name', 'balance', 'spend']);

/** Texto sem acento e em minúsculas (a busca ignora acento e maiúsculas). */
export const normalizeText = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Quantas linhas há em cada situação. */
export function countBySituation(rows) {
  const counts = { with: 0, without: 0, unknown: 0 };
  for (const row of rows) counts[situationOf(row)] += 1;
  return counts;
}

/** Filtra por situação e busca (nome, ID, nome da conexão). `idOf(row)`: o ID que aparece na lista. */
export function filterRows(rows, { status = '', q = '' } = {}, idOf = (row) => row.advertiserId ?? row.bcId) {
  const needle = normalizeText(q.trim());
  return rows.filter((row) => {
    if (status && situationOf(row) !== status) return false;
    if (!needle) return true;
    return normalizeText(`${row.name ?? ''} ${idOf(row) ?? ''} ${row.connectionName ?? ''}`).includes(needle);
  });
}

/**
 * Ordena por nome (A–Z), saldo ou total gasto. Quem não tem o valor (erro, ainda carregando) vai SEMPRE para o fim, nos dois sentidos.
 * `spendOf(row)`: o total gasto da linha (número) ou null. Empates desempatam pelo nome, então a ordem é estável.
 */
export function sortRows(rows, sort, dir, spendOf = () => null) {
  const sign = dir === 'asc' ? 1 : -1;
  const valueOf = (row) => (sort === 'balance' ? (row.main ?? null) : sort === 'spend' ? spendOf(row) : null);
  const byName = (a, b) => String(a.name ?? a.bcId ?? '').localeCompare(String(b.name ?? b.bcId ?? ''), 'pt-BR');
  return [...rows].sort((a, b) => {
    if (sort === 'name') return sign * byName(a, b);
    const x = valueOf(a);
    const y = valueOf(b);
    if (x === null && y === null) return byName(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return sign * (x - y) || byName(a, b);
  });
}

/** Soma por moeda (moedas diferentes nunca se somam). `entries`: [{ currency, value }] com value nulo ignorado. */
export function sumByCurrency(entries) {
  const totals = new Map();
  for (const { currency, value } of entries) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    const code = currency ?? 'UNKNOWN';
    totals.set(code, (totals.get(code) ?? 0) + value);
  }
  return [...totals].map(([currency, value]) => ({ currency, value })).sort((a, b) => b.value - a.value);
}
