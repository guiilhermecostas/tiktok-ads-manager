/**
 * Etiquetas das contas de anúncio e filtros por tipo/situação. Fonte ÚNICA usada pelo servidor (validação) e pelas telas
 * (nomes, filtros). Sem etiqueta = conta comum. Para criar uma etiqueta nova, basta acrescentá-la em ACCOUNT_LABELS
 * (e na restrição CHECK da coluna `tiktok_advertisers.label`, por uma nova migração).
 */

export const ACCOUNT_LABELS = Object.freeze({
  agency: 'Conta de agência',
});

/** Rótulo curto para selos e filtros. */
export const ACCOUNT_LABEL_SHORT = Object.freeze({
  agency: 'Agência',
});

export const isAccountLabel = (value) => typeof value === 'string' && Object.hasOwn(ACCOUNT_LABELS, value);

/** Quantas contas uma única chamada pode etiquetar (limita o tamanho do pedido). */
export const MAX_LABEL_BATCH = 200;

/** Filtro por tipo: todas, só as comuns (sem etiqueta) ou só as de agência. */
export const KIND_FILTERS = Object.freeze([
  { value: 'all', label: 'Todos os tipos' },
  { value: 'standard', label: 'Contas comuns' },
  { value: 'agency', label: 'Contas de agência' },
]);

/** Filtro por situação: acesso funcionando (ativas) ou Business Center com erro de acesso (inativas). */
export const STATUS_FILTERS = Object.freeze([
  { value: 'all', label: 'Ativas e inativas' },
  { value: 'active', label: 'Somente ativas' },
  { value: 'inactive', label: 'Somente inativas' },
]);

export const isActiveAccount = (account) => account.businessCenterStatus === 'active';

/** Filtro de contas: tipo, situação, moeda e Business Center (`center` = o ID da BC como texto, ou 'all'). Todos os filtros se combinam (E). */
export function matchesAccountFilter(account, { kind = 'all', status = 'all', currency = 'all', center = 'all' } = {}) {
  if (center !== 'all' && String(account.businessCenterId) !== center) return false;
  if (currency !== 'all' && account.currency !== currency) return false;
  if (kind === 'standard' && account.label) return false;
  if (kind !== 'all' && kind !== 'standard' && account.label !== kind) return false;
  if (status === 'active' && !isActiveAccount(account)) return false;
  if (status === 'inactive' && isActiveAccount(account)) return false;
  return true;
}

/** As Business Centers das contas, uma vez cada: [{ id (texto), name, accounts }], em ordem alfabética (para o filtro por Business Center). */
export function centersOf(accounts) {
  const byId = new Map();
  for (const account of accounts) {
    const id = String(account.businessCenterId);
    if (!byId.has(id)) byId.set(id, { id, name: account.businessCenterName || `Business Center ${id}`, accounts: 0 });
    byId.get(id).accounts += 1;
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/** Contagem por tipo, para resumos ("2 de agência, 1 comum"). */
export function countByKind(accounts) {
  const counts = { standard: 0 };
  for (const key of Object.keys(ACCOUNT_LABELS)) counts[key] = 0;
  for (const account of accounts) {
    if (account.label && account.label in counts) counts[account.label] += 1;
    else counts.standard += 1;
  }
  return counts;
}
