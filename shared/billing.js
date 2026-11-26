/**
 * Assinaturas: regras e contas usadas pelo servidor (validação, cálculo) e pela tela (formulários, textos), para os dois nunca divergirem.
 * TUDO é em DÓLAR (USD), em CENTAVOS inteiros (nunca número quebrado). Os meses são do calendário em UTC (o gasto por hora é guardado em UTC).
 * Cada pessoa tem o próprio plano: mensalidade + percentual do gasto em anúncios (ex.: US$ 99,90 + 5%). Módulo isomórfico: sem Node nem DOM.
 */
export const MAX_MONTHLY_FEE_CENTS = 1_000_000; // US$ 10.000,00 por mês
export const MAX_PERCENT_BP = 10_000; // 100,00% (pontos-base: 1 = 0,01%)
export const MAX_PAYMENT_CENTS = 100_000_000; // US$ 1.000.000,00 por pagamento
export const NOTE_MAX = 200;
/** O mês só fecha 2 dias depois de acabar (o TikTok ainda ajusta os números das últimas horas). */
export const CLOSE_GRACE_MS = 2 * 24 * 60 * 60 * 1000;
export const PLAN_EFFECTIVE = Object.freeze({ current: 'Este mês', next: 'Próximo mês' });
export const LOCK_KINDS = Object.freeze({ bc: 'Business Center', advertiser: 'Conta de anúncio' });

const USD_RE = /^\d{1,9}(?:[.,]\d{1,2})?$/;
const PERCENT_RE = /^\d{1,3}(?:[.,]\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** "99,90", "99.9", 99.9 → 9990 centavos. Mais de 2 casas, sinal, milhar ou texto → null (dinheiro nunca é arredondado em silêncio). */
export function parseUsdToCents(raw) {
  let cents = null;
  if (typeof raw === 'number') cents = Number.isFinite(raw) && Math.abs(raw * 100 - Math.round(raw * 100)) < 1e-7 ? Math.round(raw * 100) : null;
  else if (typeof raw === 'string' && USD_RE.test(raw.trim())) cents = Math.round(Number(raw.trim().replace(',', '.')) * 100);
  return cents !== null && cents >= 0 ? cents : null;
}

/** "10", "5,5", 7.25 → pontos-base (1000, 550, 725). De 0 a 100, até 2 casas. */
export function parsePercentToBp(raw) {
  let bp = null;
  if (typeof raw === 'number') bp = Number.isFinite(raw) && Math.abs(raw * 100 - Math.round(raw * 100)) < 1e-7 ? Math.round(raw * 100) : null;
  else if (typeof raw === 'string' && PERCENT_RE.test(raw.trim())) bp = Math.round(Number(raw.trim().replace(',', '.')) * 100);
  return bp !== null && bp >= 0 && bp <= MAX_PERCENT_BP ? bp : null;
}

export const formatUsd = (cents) => `US$ ${(Math.round(cents) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const formatPercentBp = (bp) => `${(bp / 100).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;

/** Cobrança de um mês: mensalidade + percentual do gasto (arredondado ao centavo, para cima a partir de meio centavo). Aritmética inteira (BigInt). */
export function chargeFor({ spendCents, monthlyFeeCents, percentBp }) {
  const spend = BigInt(Math.max(0, Math.round(spendCents)));
  const percentFeeCents = Number((spend * BigInt(percentBp) + 5000n) / 10000n);
  return { percentFeeCents, totalCents: monthlyFeeCents + percentFeeCents };
}

/** Texto curto do plano: "US$ 99,90/mês + 5% do gasto". */
export function planSummary(plan) {
  if (!plan) return 'Sem plano definido';
  const parts = [];
  if (plan.monthlyFeeCents > 0) parts.push(`${formatUsd(plan.monthlyFeeCents)}/mês`);
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

/** Plano de uma pessoa: `{ monthlyFee, percent, effective, note }` (valores em texto ou número) → `{ value, errors }`. */
export function validatePlanInput(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  const monthlyFeeCents = parseUsdToCents(input.monthlyFee ?? 0);
  if (monthlyFeeCents === null || monthlyFeeCents > MAX_MONTHLY_FEE_CENTS) fail('monthlyFee', `Informe a mensalidade em dólar (de 0 a ${formatUsd(MAX_MONTHLY_FEE_CENTS)}, até 2 casas).`);
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
  const amountCents = parseUsdToCents(input.amount);
  if (amountCents === null || amountCents <= 0 || amountCents > MAX_PAYMENT_CENTS) fail('amount', `Informe o valor recebido em dólar (maior que zero, até ${formatUsd(MAX_PAYMENT_CENTS)}, até 2 casas).`);
  let paidAt = null;
  if (input.paidAt !== undefined && input.paidAt !== null && input.paidAt !== '') {
    const time = typeof input.paidAt === 'string' && DATE_RE.test(input.paidAt) ? Date.parse(`${input.paidAt}T00:00:00Z`) : NaN;
    if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== input.paidAt) fail('paidAt', 'Informe a data do pagamento (AAAA-MM-DD).');
    else if (time > now.getTime() + 24 * 60 * 60 * 1000) fail('paidAt', 'A data do pagamento não pode ser no futuro.');
    else paidAt = input.paidAt;
  }
  const note = noteOf(input.note, fail);
  return { value: errors.length ? null : { amountCents, paidAt, note }, errors };
}

/** Cotação de uma moeda estrangeira para dólar: `{ usdPerUnit }` (número positivo, até 6 casas) → `{ value, errors }`. */
export function validateRateInput(currency, raw) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (typeof currency !== 'string' || !CURRENCY_RE.test(currency) || currency === 'USD') fail('currency', 'Moeda inválida (use o código de 3 letras, diferente de USD).');
  const text = typeof raw?.usdPerUnit === 'number' ? String(raw.usdPerUnit) : String(raw?.usdPerUnit ?? '').trim().replace(',', '.');
  const usdPerUnit = /^\d{1,6}(?:\.\d{1,6})?$/.test(text) ? Number(text) : null;
  if (usdPerUnit === null || usdPerUnit <= 0 || usdPerUnit > 100_000) fail('usdPerUnit', 'Informe quantos dólares vale 1 unidade da moeda (maior que zero, até 6 casas).');
  return { value: errors.length ? null : { currency, usdPerUnit }, errors };
}
