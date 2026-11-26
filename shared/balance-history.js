/**
 * Histórico de depósitos (transações) de uma Business Center ou de uma conta de anúncio. Regras puras, usadas pela tela e pelo servidor.
 * Fonte oficial: `/bc/account/transaction/get/` (tipos de transação, `amount_type`, janela máxima de 365 dias, página de 1 a 50).
 */

/** Tipos de transação do TikTok (documentação oficial) com o nome em português. */
export const TRANSACTION_TYPES = Object.freeze({
  ADD_BALANCE: 'Depósito (saldo adicionado)',
  INCREASE_BALANCE: 'Saldo aumentado',
  DECREASE_BALANCE: 'Saldo reduzido',
  BILL_PAYMENT: 'Pagamento de fatura',
  CANCELLATION: 'Cancelamento',
  PROMOTION_ISSUED: 'Crédito promocional recebido',
  PROMOTION_EXPIRED: 'Crédito promocional expirado',
  CARD_VERIFICATION: 'Verificação do cartão',
  CARD_VERIFICATION_REFUND: 'Reembolso da verificação do cartão',
  ORDER_CREATION_PAYMENT: 'Pagamento de pedido',
  ORDER_EDIT_PAYMENT: 'Pagamento de edição de pedido',
  RETURN_OF_REMAINING_BUDGET: 'Devolução de orçamento restante',
  REFUND: 'Reembolso',
});

/** O que conta como "depósito": dinheiro que ENTRA (recarga direta ou saldo aumentado, inclusive por transferência da BC). */
export const DEPOSIT_TYPES = Object.freeze(['ADD_BALANCE', 'INCREASE_BALANCE']);

export const HISTORY_FILTERS = Object.freeze([
  ['deposits', 'Só depósitos'],
  ['all', 'Todas as movimentações'],
]);
export const HISTORY_RANGES = Object.freeze([
  [90, 'Últimos 90 dias'],
  [180, 'Últimos 6 meses'],
  [365, 'Últimos 12 meses'],
]);
export const BILLING_TYPES = Object.freeze({ CASH: 'Dinheiro', CREDIT: 'Crédito de anúncio' });

export const HISTORY_PAGE_SIZE = 20; // o TikTok aceita de 1 a 50 por página
export const MAX_HISTORY_PAGE = 100;
export const HISTORY_KINDS = Object.freeze(['bc', 'account']);

const FILTER_KEYS = HISTORY_FILTERS.map(([key]) => key);
const RANGE_DAYS = HISTORY_RANGES.map(([days]) => days);
const DIGITS = /^\d{1,24}$/;

/** Nome do tipo; um tipo que o sistema ainda não conhece aparece em minúsculas, sem os sublinhados (nunca quebra a tela). */
export const typeLabel = (type) => TRANSACTION_TYPES[type] ?? String(type ?? 'movimentação').toLowerCase().replace(/_/g, ' ');

/** `amount_type` do TikTok → sinal (+1 entra, −1 sai, 0 neutro). O `amount` costuma vir positivo: quem diz se entra ou sai é o tipo. */
export const signOf = (amountType) => (amountType === 'POSITIVE' ? 1 : amountType === 'NEGATIVE' ? -1 : 0);

/**
 * Janela da consulta: do início do dia (`days - 1` dias atrás) até agora, em UTC e no formato do TikTok ("YYYY-MM-DD HH:MM:SS").
 * Sempre menor que 365 dias (o limite do TikTok), mesmo no período de 12 meses.
 */
export function historyWindow(days, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
  return { startTime: stamp(start), endTime: stamp(now) };
}

/**
 * Confere os parâmetros de uma consulta de histórico (vêm da URL, então tudo chega como texto). Só valores conhecidos passam.
 * `kind`: 'bc' (precisa de `bcId`) ou 'account' (precisa de `advertiserId`; a BC é descoberta no servidor, nunca informada pelo cliente).
 * Retorna { value, errors }.
 */
export function normalizeHistoryQuery(raw) {
  const q = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const one = (v) => (typeof v === 'string' ? v : undefined); // `?a=1&a=2` vira lista: recusado
  const kind = one(q.kind);
  if (!HISTORY_KINDS.includes(kind)) errors.push({ path: 'kind', message: 'Escolha Business Center ou conta de anúncio.' });
  const connectionId = one(q.connectionId);
  if (!/^\d{1,9}$/.test(connectionId ?? '') || Number(connectionId) < 1) errors.push({ path: 'connectionId', message: 'Conexão inválida.' });
  const bcId = one(q.bcId);
  const advertiserId = one(q.advertiserId);
  if (kind === 'bc' && !DIGITS.test(bcId ?? '')) errors.push({ path: 'bcId', message: 'Business Center inválida.' });
  if (kind === 'account' && !DIGITS.test(advertiserId ?? '')) errors.push({ path: 'advertiserId', message: 'Conta de anúncio inválida.' });
  const range = q.range === undefined ? 90 : /^\d{2,3}$/.test(one(q.range) ?? '') ? Number(q.range) : NaN;
  if (!RANGE_DAYS.includes(range)) errors.push({ path: 'range', message: 'Período inválido.' });
  const filter = q.filter === undefined ? 'deposits' : one(q.filter);
  if (!FILTER_KEYS.includes(filter)) errors.push({ path: 'filter', message: 'Filtro inválido.' });
  const page = q.page === undefined ? 1 : /^\d{1,3}$/.test(one(q.page) ?? '') ? Number(q.page) : NaN;
  if (!Number.isInteger(page) || page < 1 || page > MAX_HISTORY_PAGE) errors.push({ path: 'page', message: 'Página inválida.' });
  if (errors.length) return { value: null, errors };
  return {
    value: { kind, connectionId: Number(connectionId), bcId: kind === 'bc' ? bcId : null, advertiserId: kind === 'account' ? advertiserId : null, range, filter, page },
    errors: [],
  };
}
