/**
 * Etiquetas das contas de anúncio e filtros por tipo/situação. Fonte ÚNICA usada pelo servidor (validação) e pelas telas
 * (nomes, filtros). Sem etiqueta = conta comum. Para criar uma etiqueta nova, basta acrescentá-la em ACCOUNT_LABELS
 * (e na restrição CHECK da coluna `tiktok_advertisers.label`, por uma nova migração).
 */

import { DOWN_STATUSES, accountStatusLabel } from './assistant-ops.js';

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

/** Filtro por situação: ativas (acesso funcionando e conta aprovada no TikTok) ou inativas (encerrada, punida, em análise… ou Business Center com erro de acesso). */
export const STATUS_FILTERS = Object.freeze([
  { value: 'all', label: 'Ativas e inativas' },
  { value: 'active', label: 'Somente ativas' },
  { value: 'inactive', label: 'Somente inativas' },
]);

/**
 * Situação de uma conta de anúncio para mostrar, juntando o acesso da conexão e a situação da CONTA no TikTok (`accountStatus`, lida ao atualizar a
 * conexão e na coleta por hora). Devolve { key, label, tone }: `error` (conexão com erro: o que se sabe da conta pode estar velho), `unknown` (situação ainda não lida),
 * `active`, `inactive` (encerrada, punida ou reprovada) e `pending` (em análise ou aguardando algo do TikTok).
 */
export function accountHealth(account) {
  if (account.businessCenterStatus !== 'active') return { key: 'error', label: 'Acesso com erro', tone: 'danger' };
  const status = account.accountStatus ?? null;
  if (!status) return { key: 'unknown', label: 'Sem informação', tone: 'neutral' };
  if (status === 'STATUS_ENABLE') return { key: 'active', label: 'Ativa', tone: 'success' };
  const down = status === 'STATUS_DISABLE' || DOWN_STATUSES.includes(status);
  return { key: down ? 'inactive' : 'pending', label: accountStatusLabel(status), tone: down ? 'danger' : 'warning' };
}

/** Ativa = conexão funcionando e conta não conhecida como inativa. Sem situação lida ainda (`unknown`) conta como ativa: não dá para afirmar o contrário. */
export const isActiveAccount = (account) => ['active', 'unknown'].includes(accountHealth(account).key);

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
