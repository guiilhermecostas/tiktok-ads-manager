/**
 * Assinaturas: regras e contas usadas pelo servidor (validação, cálculo) e pela tela (formulários, textos), para os dois nunca divergirem.
 * TUDO que se cobra e se paga é em REAL (BRL), em CENTAVOS inteiros (nunca número quebrado). O gasto das contas de anúncio, que pode vir em qualquer
 * moeda (USD, EUR…), é CONVERTIDO para real pela cotação do dia (`convertToBrlCents`). Os meses são do calendário em UTC (o gasto por hora é guardado em UTC).
 * Cada pessoa tem o próprio plano: mensalidade + percentual do gasto em anúncios (ex.: R$ 99,90 + 5%). A cobrança vira FATURA: a plataforma só emite a fatura
 * quando o valor acumulado dos meses fechados chega ao mínimo (R$ 50,00); abaixo disso o valor passa para a fatura seguinte. Módulo isomórfico: sem Node nem DOM.
 */
export const BASE_CURRENCY = 'BRL';
export const MAX_MONTHLY_FEE_CENTS = 5_000_000; // R$ 50.000,00 por mês
export const MAX_PERCENT_BP = 10_000; // 100,00% (pontos-base: 1 = 0,01%)
export const MAX_PAYMENT_CENTS = 500_000_000; // R$ 5.000.000,00 por pagamento
/** A fatura só é emitida quando o acumulado a cobrar chega a este valor (R$ 50,00). */
export const INVOICE_MIN_CENTS = 5_000;
/** Prazo para pagar uma fatura, em dias corridos a partir da emissão. */
export const INVOICE_DUE_DAYS = 5;
export const NOTE_MAX = 200;
/** O mês só fecha 2 dias depois de acabar (o TikTok ainda ajusta os números das últimas horas). */
export const CLOSE_GRACE_MS = 2 * 24 * 60 * 60 * 1000;
/** Plano que toda conta nova recebe ao concluir o cadastro (o admin muda depois, por pessoa): R$ 0 de mensalidade + 10% do gasto em anúncios. */
export const DEFAULT_PLAN = Object.freeze({ monthlyFeeCents: 0, percentBp: 1000, note: 'Plano padrão do cadastro' });
export const PLAN_EFFECTIVE = Object.freeze({ current: 'Este mês', next: 'Próximo mês' });
export const LOCK_KINDS = Object.freeze({ bc: 'Business Center', advertiser: 'Conta de anúncio' });

const MONEY_RE = /^\d{1,9}(?:[.,]\d{1,2})?$/;
const PERCENT_RE = /^\d{1,3}(?:[.,]\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** "99,90", "99.9", 99.9 → 9990 centavos (de real). Mais de 2 casas, sinal, milhar ou texto → null (dinheiro nunca é arredondado em silêncio). */
export function parseBrlToCents(raw) {
  let cents = null;
  if (typeof raw === 'number') cents = Number.isFinite(raw) && Math.abs(raw * 100 - Math.round(raw * 100)) < 1e-7 ? Math.round(raw * 100) : null;
  else if (typeof raw === 'string' && MONEY_RE.test(raw.trim())) cents = Math.round(Number(raw.trim().replace(',', '.')) * 100);
  return cents !== null && cents >= 0 ? cents : null;
}

/** "10", "5,5", 7.25 → pontos-base (1000, 550, 725). De 0 a 100, até 2 casas. */
export function parsePercentToBp(raw) {
  let bp = null;
  if (typeof raw === 'number') bp = Number.isFinite(raw) && Math.abs(raw * 100 - Math.round(raw * 100)) < 1e-7 ? Math.round(raw * 100) : null;
  else if (typeof raw === 'string' && PERCENT_RE.test(raw.trim())) bp = Math.round(Number(raw.trim().replace(',', '.')) * 100);
  return bp !== null && bp >= 0 && bp <= MAX_PERCENT_BP ? bp : null;
}

/** Centavos → "R$ 1.234,56". */
export const formatBrl = (cents) => `R$ ${(Math.round(cents) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Cotação em reais, com as casas que ela precisa: 5,43212 → "R$ 5,4321" (até 4 casas de R$ 1 para cima); 6 → "R$ 6,00"; 0,001428 → "R$ 0,001428" (até 6 abaixo de R$ 1). */
export const formatRate = (brlPerUnit) => `R$ ${brlPerUnit.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: brlPerUnit >= 1 ? 4 : 6 })}`;
export const formatPercentBp = (bp) => `${(bp / 100).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;

/** Cobrança de um mês: mensalidade + percentual do gasto (arredondado ao centavo, para cima a partir de meio centavo). Aritmética inteira (BigInt). */
export function chargeFor({ spendCents, monthlyFeeCents, percentBp }) {
  const spend = BigInt(Math.max(0, Math.round(spendCents)));
  const percentFeeCents = Number((spend * BigInt(percentBp) + 5000n) / 10000n);
  return { percentFeeCents, totalCents: monthlyFeeCents + percentFeeCents };
}

/** Texto curto do plano: "R$ 99,90/mês + 5% do gasto". */
export function planSummary(plan) {
  if (!plan) return 'Sem plano definido';
  const parts = [];
  if (plan.monthlyFeeCents > 0) parts.push(`${formatBrl(plan.monthlyFeeCents)}/mês`);
  if (plan.percentBp > 0) parts.push(`${formatPercentBp(plan.percentBp)} do gasto`);
  return parts.length ? parts.join(' + ') : 'Gratuito (sem mensalidade nem percentual)';
}

// ---------- meses (UTC) ----------
const pad = (n) => String(n).padStart(2, '0');
/** Primeiro dia do mês (UTC) de uma data: 'YYYY-MM-01'. */
export const monthOf = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-01`;
export const isMonthStart = (text) => typeof text === 'string' && /^\d{4}-\d{2}-01$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));
export function nextMonth(text) {
  const [y, m] = text.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}
export const monthStartDate = (text) => new Date(`${text}T00:00:00Z`);
/** Meses de `from` até `to` (inclusive), do mais antigo ao mais novo. */
export function monthsBetween(from, to) {
  const list = [];
  for (let m = from; m <= to && list.length < 600; m = nextMonth(m)) list.push(m);
  return list;
}
export function monthLabel(text) {
  const [y, m] = text.split('-').map(Number);
  const names = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  return `${names[m - 1]} de ${y}`;
}
/** O mês `period` já pode ser fechado em `now`? (depois do fim do mês + 2 dias) */
export const canClose = (period, now) => now.getTime() >= monthStartDate(nextMonth(period)).getTime() + CLOSE_GRACE_MS;

// ---------- validações do que o admin envia ----------
const noteOf = (raw, fail) => {
  const text = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  // eslint-disable-next-line no-control-regex
  if (text.length > NOTE_MAX || /[\u0000-\u001f\u007f]/.test(text)) fail('note', `A observação pode ter até ${NOTE_MAX} caracteres, sem caracteres de controle.`);
  return text || null;
};

/** Data do pagamento (opcional): AAAA-MM-DD real e não futura; vazio vira null (o servidor usa o dia de hoje). */
function paidAtOf(raw, now, fail) {
  if (raw === undefined || raw === null || raw === '') return null;
  const time = typeof raw === 'string' && DATE_RE.test(raw) ? Date.parse(`${raw}T00:00:00Z`) : NaN;
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== raw) {
    fail('paidAt', 'Informe a data do pagamento (AAAA-MM-DD).');
    return null;
  }
  if (time > now.getTime() + DAY_MS) {
    fail('paidAt', 'A data do pagamento não pode ser no futuro.');
    return null;
  }
  return raw;
}

/** Plano de uma pessoa: `{ monthlyFee, percent, effective, note }` (valores em texto ou número) → `{ value, errors }`. */
export function validatePlanInput(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  const monthlyFeeCents = parseBrlToCents(input.monthlyFee ?? 0);
  if (monthlyFeeCents === null || monthlyFeeCents > MAX_MONTHLY_FEE_CENTS) fail('monthlyFee', `Informe a mensalidade em reais (de 0 a ${formatBrl(MAX_MONTHLY_FEE_CENTS)}, até 2 casas).`);
  const percentBp = parsePercentToBp(input.percent ?? 0);
  if (percentBp === null) fail('percent', 'Informe o percentual do gasto (de 0 a 100, até 2 casas).');
  const effective = input.effective ?? 'current';
  if (!Object.keys(PLAN_EFFECTIVE).includes(effective)) fail('effective', 'Escolha a partir de quando vale.');
  const note = noteOf(input.note, fail);
  return { value: errors.length ? null : { monthlyFeeCents, percentBp, effective, note }, errors };
}

/** Pagamento recebido: `{ amount, paidAt?, note? }` → `{ value: { amountCents, paidAt|null, note }, errors }`. */
export function validatePaymentInput(raw, now = new Date()) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  const amountCents = parseBrlToCents(input.amount);
  if (amountCents === null || amountCents <= 0 || amountCents > MAX_PAYMENT_CENTS) fail('amount', `Informe o valor recebido em reais (maior que zero, até ${formatBrl(MAX_PAYMENT_CENTS)}, até 2 casas).`);
  const paidAt = paidAtOf(input.paidAt, now, fail);
  const note = noteOf(input.note, fail);
  return { value: errors.length ? null : { amountCents, paidAt, note }, errors };
}

/** Cotação de uma moeda estrangeira para REAL: `{ brlPerUnit }` (quantos reais vale 1 unidade; número positivo, até 6 casas) → `{ value, errors }`. */
export function validateRateInput(currency, raw) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (typeof currency !== 'string' || !CURRENCY_RE.test(currency) || currency === BASE_CURRENCY) fail('currency', 'Moeda inválida (use o código de 3 letras, diferente de BRL).');
  const text = typeof raw?.brlPerUnit === 'number' ? String(raw.brlPerUnit) : String(raw?.brlPerUnit ?? '').trim().replace(',', '.');
  const brlPerUnit = /^\d{1,6}(?:\.\d{1,6})?$/.test(text) ? Number(text) : null;
  if (brlPerUnit === null || brlPerUnit <= 0 || brlPerUnit > 100_000) fail('brlPerUnit', 'Informe quantos reais vale 1 unidade da moeda (maior que zero, até 6 casas).');
  return { value: errors.length ? null : { currency, brlPerUnit }, errors };
}

/** Marcar uma fatura como paga: `{ paidAt?, note? }` → `{ value: { paidAt|null, note }, errors }` (o valor é sempre o que falta da própria fatura). */
export function validateInvoicePayInput(raw, now = new Date()) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  const paidAt = paidAtOf(input.paidAt, now, fail);
  const note = noteOf(input.note, fail);
  return { value: errors.length ? null : { paidAt, note }, errors };
}

// ---------- câmbio: gasto em qualquer moeda → centavos de real ----------
const SPEND_SCALE = 10_000n; // o gasto guardado tem até 4 casas decimais
const RATE_SCALE = 10_000_000_000n; // cotações têm até 10 casas decimais

/**
 * Converte o gasto por moeda ({ currency, spend }) em centavos de real com aritmética inteira (BigInt: sem erro de ponto flutuante), arredondando
 * ao centavo (meio centavo sobe). `rates`: Map moeda → quantos reais vale 1 unidade (o real vale 1 e não precisa constar). Moeda sem cotação NÃO
 * entra na conta: volta em `unconverted`. Devolve { cents, breakdown: [{ currency, spend, rate, cents }], unconverted: [{ currency, spend }] }.
 */
export function convertToBrlCents(rows, rates) {
  let total = 0;
  const breakdown = [];
  const unconverted = [];
  for (const row of rows) {
    const spend = Number(row.spend);
    if (!Number.isFinite(spend) || spend <= 0) continue;
    const shownSpend = Math.round(spend * 100) / 100;
    const rate = row.currency === BASE_CURRENCY ? 1 : rates.get(row.currency);
    if (!(rate > 0)) {
      unconverted.push({ currency: row.currency, spend: shownSpend });
      continue;
    }
    const scaled = BigInt(Math.round(spend * 1e4)) * BigInt(Math.round(rate * 1e10)) * 100n;
    const cents = Number((scaled + (SPEND_SCALE * RATE_SCALE) / 2n) / (SPEND_SCALE * RATE_SCALE));
    total += cents;
    breakdown.push({ currency: row.currency, spend: shownSpend, rate, cents });
  }
  return { cents: total, breakdown, unconverted };
}

// ---------- faturas ----------
const DAY_MS = 24 * 60 * 60 * 1000;
/** Vencimento (AAAA-MM-DD, UTC): a data de emissão + o prazo da fatura. */
export const dueDateOf = (issuedAt) => new Date(issuedAt.getTime() + INVOICE_DUE_DAYS * DAY_MS).toISOString().slice(0, 10);
/** O valor acumulado já dá uma fatura? */
export const canIssueInvoice = (uninvoicedCents) => uninvoicedCents >= INVOICE_MIN_CENTS;

/**
 * Situação de cada fatura a partir do TOTAL já pago: os pagamentos quitam as faturas da mais antiga para a mais nova (FIFO), então não existe
 * "marcador de pago" que possa ficar fora de sincronia com os pagamentos. `invoices`: [{ id, amountCents, dueDate }] em ordem de emissão;
 * `today`: 'AAAA-MM-DD'. Devolve cada fatura com { paidCents, remainingCents, status: 'paid' | 'partial' | 'overdue' | 'open' }.
 */
export function allocateInvoices(invoices, paidCents, today) {
  let left = Math.max(0, paidCents);
  return invoices.map((invoice) => {
    const paid = Math.min(left, invoice.amountCents);
    left -= paid;
    const remainingCents = invoice.amountCents - paid;
    let status = 'open';
    if (remainingCents === 0) status = 'paid';
    else if (invoice.dueDate < today) status = 'overdue';
    else if (paid > 0) status = 'partial';
    return { ...invoice, paidCents: paid, remainingCents, status };
  });
}
