/**
 * Transferência de saldo entre a Business Center e uma conta de anúncio (`POST /bc/transfer/`, documentação oficial v1.3):
 *  - RECHARGE: tira da BC e põe na conta (adicionar saldo à conta);
 *  - REFUND: tira da conta e devolve para a BC (retirar saldo da conta).
 * Isto NÃO coloca dinheiro novo na BC (cartão, PIX, boleto): isso só se faz no portal do TikTok.
 * Fonte ÚNICA das regras, usada pelo servidor (validação e pré-conferência) e pela tela (o que mostrar e o que bloquear).
 * Módulo isomórfico: não depende de Node nem do DOM.
 */
export const TRANSFER_TYPES = Object.freeze({
  RECHARGE: { id: 'RECHARGE', label: 'Adicionar saldo à conta', short: 'Adicionar', from: 'BC', to: 'conta' },
  REFUND: { id: 'REFUND', label: 'Retirar saldo da conta', short: 'Retirar', from: 'conta', to: 'BC' },
});
export const TRANSFER_TYPE_IDS = Object.freeze(Object.keys(TRANSFER_TYPES));

/** Teto por transferência (na moeda da conta) e quantas por hora: freios de segurança contra erro de digitação e uso indevido. */
export const MAX_TRANSFER_AMOUNT = 100_000;
export const MAX_TRANSFERS_PER_HOUR = 20;
/** Identificador da operação: 32 caracteres hexadecimais gerados pela tela (a mesma operação nunca move o dinheiro duas vezes). */
export const OPERATION_ID_RE = /^[0-9a-f]{32}$/;

const ID_RE = /^\d{1,24}$/;
const AMOUNT_RE = /^\d{1,9}(?:[.,]\d{1,2})?$/;

/**
 * Valor da transferência: número positivo com no máximo 2 casas (aceita "25", "25.5", "25,50" e números). Dinheiro NUNCA é arredondado em silêncio:
 * mais de 2 casas, sinal, separador de milhar, notação científica ou texto viram `null`.
 */
export function parseTransferAmount(raw) {
  let value = null;
  if (typeof raw === 'number') {
    value = Number.isFinite(raw) && Math.abs(raw * 100 - Math.round(raw * 100)) < 1e-7 ? Math.round(raw * 100) / 100 : null;
  } else if (typeof raw === 'string' && AMOUNT_RE.test(raw.trim())) {
    value = Math.round(Number(raw.trim().replace(',', '.')) * 100) / 100;
  }
  return value !== null && value > 0 && value <= MAX_TRANSFER_AMOUNT ? value : null;
}

/** Valida o pedido (do navegador): `{ value, errors }`; `errors` = [{ path, message }]. Só campos conhecidos. */
export function validateTransferInput(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  const connectionId = Number.isInteger(input.connectionId) && input.connectionId > 0 ? input.connectionId : null;
  if (connectionId === null) fail('connectionId', 'Conexão inválida.');
  if (typeof input.bcId !== 'string' || !ID_RE.test(input.bcId)) fail('bcId', 'Business Center inválida.');
  if (typeof input.advertiserId !== 'string' || !ID_RE.test(input.advertiserId)) fail('advertiserId', 'Conta de anúncio inválida.');
  if (!TRANSFER_TYPE_IDS.includes(input.type)) fail('type', 'Escolha adicionar ou retirar saldo.');
  const amount = parseTransferAmount(input.amount);
  if (amount === null) fail('amount', `Informe um valor maior que zero, com até 2 casas decimais (máximo ${MAX_TRANSFER_AMOUNT.toLocaleString('pt-BR')}).`);
  if (typeof input.operationId !== 'string' || !OPERATION_ID_RE.test(input.operationId)) fail('operationId', 'Identificador da operação inválido. Recarregue a tela e tente de novo.');
  if (typeof input.password !== 'string' || input.password.length < 1 || input.password.length > 200) fail('password', 'Informe a sua senha para confirmar.');
  return {
    value: errors.length ? null : { connectionId, bcId: input.bcId, advertiserId: input.advertiserId, type: input.type, amount, operationId: input.operationId, password: input.password },
    errors,
  };
}

const amountOf = (row, key) => row.amounts?.find((a) => a.key === key)?.value;

/**
 * Esta conta pode receber/devolver saldo por aqui? `{ ok, reason, maxRecharge, maxRefund }`.
 *  - maxRecharge: quanto dá para tirar da BC (saldo disponível da BC); maxRefund: quanto dá para devolver da conta (o "valor transferível" que o
 *    TikTok informa, que já exclui o bloqueado; sem ele, o saldo disponível).
 * Bloqueia o que a documentação não permite ou o que não daria para conferir: portfólio compartilhado (Balance Sharing não aceita dinheiro em
 * espécie por esta chamada), conta que gasta do saldo da BC por orçamento, moedas diferentes ou saldo desconhecido.
 */
export function transferEligibility(account, bc) {
  const no = (reason) => ({ ok: false, reason, maxRecharge: 0, maxRefund: 0 });
  if (!account || account.status !== 'ok') return no('O TikTok não informou o saldo desta conta.');
  if (!bc || bc.status !== 'ok') return no('Não foi possível ler o saldo da Business Center.');
  if (account.mainSource === 'portfolio' || bc.portfolioType === 'SHARED') return no('Saldo compartilhado (portfólio de pagamento): o dinheiro é do portfólio e não se transfere por aqui. Use o portal do TikTok.');
  if (account.mainSource === 'budget') return no('Esta conta gasta do saldo da Business Center dentro de um orçamento: não há saldo próprio para transferir. Ajuste o orçamento no TikTok.');
  if (!account.currency || !bc.currency) return no('Moeda desconhecida: não dá para conferir a transferência.');
  if (account.currency !== bc.currency) return no(`A conta usa ${account.currency} e a Business Center ${bc.currency}: o TikTok não transfere entre moedas diferentes.`);
  if (bc.main === null || account.main === null) return no('Saldo desconhecido: não dá para conferir a transferência.');
  const transferable = amountOf(account, 'transferable_amount');
  return { ok: true, reason: null, maxRecharge: Math.max(0, bc.main), maxRefund: Math.max(0, transferable ?? account.main) };
}

/** Resumo em uma frase (a mesma na revisão da tela e no histórico). `formatMoney(valor, moeda)` formata o valor. */
export function describeTransfer({ type, amount, currency, bcId, advertiserName, advertiserId }, formatMoney) {
  const value = formatMoney(amount, currency);
  const account = advertiserName ? `${advertiserName} (${advertiserId})` : advertiserId;
  return type === 'RECHARGE' ? `${value} da BC ${bcId} para a conta ${account}` : `${value} da conta ${account} para a BC ${bcId}`;
}
