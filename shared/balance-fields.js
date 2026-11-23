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
  credit_balance: 'Crédito disponível',
});

/** Ordem de exibição dos campos conhecidos (os demais vêm depois, em ordem alfabética). */
const ORDER = Object.freeze(Object.keys(LABELS));

/** Qual campo representa o "saldo disponível" principal (o primeiro que existir). */
const MAIN_KEYS = Object.freeze(['valid_account_balance', 'available_balance', 'valid_cash_balance', 'account_balance', 'cash_balance', 'balance']);

/** Campo que representa dinheiro disponível/guardado (conta para "tem saldo"), e não bloqueio, imposto ou orçamento. */
export const isBalanceKey = (key) => /(balance|cash|grant|coupon|credit|available|recharge)/.test(key) && !/(frozen|tax|budget|cost|limit)/.test(key);

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

/** Tem saldo? Verdadeiro se algum campo de saldo for maior que zero. */
export const hasBalance = (amounts) => amounts.some((a) => isBalanceKey(a.key) && a.value > 0);
