/**
 * Campos de saldo que o TikTok devolve para Business Centers e contas de anúncio. Fonte ÚNICA usada pelo servidor (classificação) e
 * pela tela (nomes e ordem). O TikTok não documenta publicamente cada campo, então o sistema mostra TUDO o que vier de numérico e usa
 * nomes amigáveis só para os conhecidos; o resto aparece com o próprio nome do campo, "humanizado".
 */

const LABELS = Object.freeze({
  valid_account_balance: 'Saldo disponível',
  account_balance: 'Saldo total',
  valid_cash_balance: 'Dinheiro disponível',
  cash_balance: 'Saldo em dinheiro',
  valid_grant_balance: 'Bônus disponível',
  grant_balance: 'Saldo de bônus',
  valid_coupon_balance: 'Cupom disponível',
  coupon_balance: 'Saldo de cupom',
  balance: 'Saldo',
  available_balance: 'Saldo disponível',
  frozen_balance: 'Saldo bloqueado',
  tax: 'Impostos',
  transferable_amount: 'Valor transferível',
  budget: 'Orçamento',
  budget_cost: 'Orçamento já gasto',
  budget_remaining: 'Orçamento restante',
  credit_limit: 'Limite de crédito',
  credit_balance: 'Crédito total',
  valid_credit_balance: 'Crédito disponível',
  frozen_cash_balance: 'Dinheiro bloqueado',
  frozen_grant_balance: 'Bônus bloqueado',
  frozen_credit_balance: 'Crédito bloqueado',
  cash_tax: 'Impostos (dinheiro)',
  'max_transferable_amount.cash_amount': 'Máx. transferível (dinheiro)',
  'max_transferable_amount.grant_amount': 'Máx. transferível (bônus)',
  'min_transferable_amount.cash_amount': 'Mín. a transferir (dinheiro)',
  'min_transferable_amount.grant_amount': 'Mín. a transferir (bônus)',
  'min_transferable_amount.credit_amount': 'Mín. a transferir (crédito)',
  'budget_amount_restriction.minimum_amount': 'Alteração mínima do orçamento',
  recharge_amount: 'Total já recarregado',
  first_recharge_amount: 'Primeira recarga',
});

/** Ordem de exibição dos campos conhecidos (os demais vêm depois, em ordem alfabética). */
const ORDER = Object.freeze(Object.keys(LABELS));

/** Campos que dizem quanto está DISPONÍVEL para gastar (o total inclui bloqueado e impostos). */
const AVAILABLE_KEYS = Object.freeze(['valid_account_balance', 'available_balance']);

/** Qual campo representa o "saldo disponível" principal (o primeiro que existir). */
const MAIN_KEYS = Object.freeze(['valid_account_balance', 'available_balance', 'valid_cash_balance', 'account_balance', 'cash_balance', 'balance']);

/** Campo que representa dinheiro disponível/guardado (conta para "tem saldo"), e não bloqueio, imposto, orçamento, valor transferível ou histórico de recargas. */
export const isBalanceKey = (key) => /(balance|cash|grant|coupon|credit|available)/.test(key) && !/(frozen|tax|budget|cost|limit|transferable|recharge|minimum|restriction)/.test(key);

/** Como o dinheiro da conta é gerido (Payment Portfolio) e de onde o saldo exibido vem. */
export const PORTFOLIO_TYPE_LABELS = Object.freeze({ SHARED: 'Portfólio compartilhado', NON_SHARED: 'Portfólio individual' });
export const BUDGET_MODE_LABELS = Object.freeze({ UNLIMITED: 'Sem limite de orçamento', MONTHLY_BUDGET: 'Orçamento mensal', DAILY_BUDGET: 'Orçamento diário', CUSTOM_BUDGET: 'Orçamento único' });
/** Contas que gastam do saldo da BC dentro de um orçamento (BC em alocação automática). */
export const isBudgetMode = (mode) => ['MONTHLY_BUDGET', 'DAILY_BUDGET', 'CUSTOM_BUDGET'].includes(mode);

/** Nome em português do campo: o conhecido, ou o próprio nome sem "_" e com a primeira letra maiúscula. */
export function balanceLabel(key) {
  if (LABELS[key]) return LABELS[key];
  const text = String(key).replace(/[_.]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Valor';
}

/** Ordena campos [{ key, value }]: os conhecidos na ordem acima, depois os outros por nome. */
export function sortAmounts(amounts) {
  const rank = (key) => (ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length);
  return [...amounts].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

/** Saldo principal (número) de uma lista [{ key, value }], ou null se o TikTok não informou nenhum campo de saldo. */
export function mainAmount(amounts) {
  for (const key of MAIN_KEYS) {
    const found = amounts.find((a) => a.key === key);
    if (found) return found.value;
  }
  const fallback = amounts.find((a) => isBalanceKey(a.key));
  return fallback ? fallback.value : null;
}

/**
 * Tem saldo? Conta o que está DISPONÍVEL para gastar. Pela documentação oficial, `account_balance` = disponível + bloqueado + impostos (e
 * `cash_balance` idem): olhar o total faria uma conta com dinheiro só bloqueado aparecer "com saldo". Então, quando o TikTok informa o disponível
 * (`valid_account_balance`/`available_balance`), só ele decide; sem ele, os demais `valid_*`; só em último caso, qualquer campo de saldo.
 */
export function hasBalance(amounts) {
  const known = (keys) => amounts.filter((a) => keys.includes(a.key));
  const available = known(AVAILABLE_KEYS);
  if (available.length) return available.some((a) => a.value > 0);
  const valid = amounts.filter((a) => isBalanceKey(a.key) && a.key.startsWith('valid_'));
  if (valid.length) return valid.some((a) => a.value > 0);
  return amounts.some((a) => isBalanceKey(a.key) && a.value > 0);
}
