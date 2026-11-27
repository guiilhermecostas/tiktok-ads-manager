import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BASE_CURRENCY, CLOSE_GRACE_MS, INVOICE_DUE_DAYS, INVOICE_MIN_CENTS, allocateInvoices, canClose, canIssueInvoice, chargeFor, convertToBrlCents, dueDateOf, formatBrl, formatPercentBp, isMonthStart,
  monthLabel, monthOf, monthsBetween, nextMonth, parseBrlToCents, parsePercentToBp, planSummary, validateInvoicePayInput, validatePaymentInput, validatePlanInput, validateRateInput,
} from '../shared/billing.js';

describe('Assinaturas (regras compartilhadas, tudo em real)', () => {
  it('real vira centavos inteiros, sem arredondar em silêncio', () => {
    assert.equal(parseBrlToCents('99,90'), 9990);
    assert.equal(parseBrlToCents('99.9'), 9990);
    assert.equal(parseBrlToCents(199.9), 19990);
    assert.equal(parseBrlToCents('0'), 0);
    assert.equal(parseBrlToCents(0), 0);
    assert.equal(parseBrlToCents(' 12 '), 1200);
    for (const bad of ['1,234', '-5', '1e3', 'abc', '', '1.000,50', '12.', NaN, Infinity, null, undefined, {}, [], 0.001, -1, '1,5,5']) assert.equal(parseBrlToCents(bad), null, String(bad));
  });

  it('percentual vira pontos-base (de 0 a 100, até 2 casas)', () => {
    assert.equal(parsePercentToBp('10'), 1000);
    assert.equal(parsePercentToBp('5,5'), 550);
    assert.equal(parsePercentToBp(7.25), 725);
    assert.equal(parsePercentToBp('0'), 0);
    assert.equal(parsePercentToBp('100'), 10000);
    for (const bad of ['100,01', '101', '-1', '1,234', 'dez', '', null, undefined, 100.01, 150]) assert.equal(parsePercentToBp(bad), null, String(bad));
  });

  it('mensalidade + percentual do gasto, em aritmética inteira (os 3 exemplos do negócio)', () => {
    // usuário A: R$ 0 + 10%; B: R$ 99,90 + 5%; C: R$ 199,90 + 0%  — gasto de R$ 1.000,00
    assert.deepEqual(chargeFor({ spendCents: 100000, monthlyFeeCents: 0, percentBp: 1000 }), { percentFeeCents: 10000, totalCents: 10000 });
    assert.deepEqual(chargeFor({ spendCents: 100000, monthlyFeeCents: 9990, percentBp: 500 }), { percentFeeCents: 5000, totalCents: 14990 });
    assert.deepEqual(chargeFor({ spendCents: 100000, monthlyFeeCents: 19990, percentBp: 0 }), { percentFeeCents: 0, totalCents: 19990 });
    assert.deepEqual(chargeFor({ spendCents: 0, monthlyFeeCents: 9990, percentBp: 500 }), { percentFeeCents: 0, totalCents: 9990 });
  });

  it('arredonda ao centavo (meio centavo sobe) e aguenta valores enormes sem perder precisão', () => {
    assert.equal(chargeFor({ spendCents: 105, monthlyFeeCents: 0, percentBp: 500 }).percentFeeCents, 5, '5,25 c → 5');
    assert.equal(chargeFor({ spendCents: 110, monthlyFeeCents: 0, percentBp: 500 }).percentFeeCents, 6, '5,5 c → 6');
    assert.equal(chargeFor({ spendCents: 99, monthlyFeeCents: 0, percentBp: 1 }).percentFeeCents, 0);
    const huge = chargeFor({ spendCents: 9_000_000_000_000, monthlyFeeCents: 0, percentBp: 10_000 });
    assert.equal(huge.percentFeeCents, 9_000_000_000_000, '100% de R$ 90 bilhões');
    assert.equal(chargeFor({ spendCents: -50, monthlyFeeCents: 100, percentBp: 1000 }).totalCents, 100, 'gasto negativo vale zero');
  });

  it('formatos e resumo do plano', () => {
    assert.match(formatBrl(9990), /^R\$\s99,90$/);
    assert.match(formatBrl(123456789), /^R\$\s1\.234\.567,89$/);
    assert.equal(formatPercentBp(1000), '10%');
    assert.equal(formatPercentBp(550), '5,5%');
    assert.match(planSummary({ monthlyFeeCents: 9990, percentBp: 500 }), /^R\$\s99,90\/mês \+ 5% do gasto$/);
    assert.equal(planSummary({ monthlyFeeCents: 0, percentBp: 1000 }), '10% do gasto');
    assert.match(planSummary({ monthlyFeeCents: 19990, percentBp: 0 }), /^R\$\s199,90\/mês$/);
    assert.match(planSummary({ monthlyFeeCents: 0, percentBp: 0 }), /Gratuito/);
    assert.equal(planSummary(null), 'Sem plano definido');
  });

  it('meses em UTC: início, próximo, intervalo, rótulo e fechamento com 2 dias de folga', () => {
    assert.equal(monthOf(new Date('2026-11-25T23:59:59Z')), '2026-11-01');
    assert.equal(monthOf(new Date('2026-12-01T00:00:00Z')), '2026-12-01');
    assert.equal(nextMonth('2026-11-01'), '2026-12-01');
    assert.equal(nextMonth('2026-12-01'), '2027-01-01');
    assert.deepEqual(monthsBetween('2026-10-01', '2027-01-01'), ['2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01']);
    assert.deepEqual(monthsBetween('2026-12-01', '2026-11-01'), []);
    assert.equal(monthLabel('2026-03-01'), 'março de 2026');
    assert.ok(isMonthStart('2026-11-01') && !isMonthStart('2026-11-02') && !isMonthStart('2026-13-01') && !isMonthStart(5));
    assert.equal(canClose('2026-10-01', new Date('2026-11-02T23:59:59Z')), false, 'ainda dentro da folga');
    assert.equal(canClose('2026-10-01', new Date(Date.parse('2026-11-01T00:00:00Z') + CLOSE_GRACE_MS)), true);
    assert.equal(canClose('2026-11-01', new Date('2026-11-25T00:00:00Z')), false, 'mês em andamento nunca fecha');
  });

  it('plano: valida mensalidade, percentual, vigência e observação', () => {
    const ok = validatePlanInput({ monthlyFee: '99,90', percent: '5', effective: 'next', note: '  Acordo  de  janeiro  ' });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.value, { monthlyFeeCents: 9990, percentBp: 500, effective: 'next', note: 'Acordo de janeiro' });
    assert.deepEqual(validatePlanInput({}).value, { monthlyFeeCents: 0, percentBp: 0, effective: 'current', note: null });
    const paths = (raw) => validatePlanInput(raw).errors.map((e) => e.path).sort();
    assert.deepEqual(paths({ monthlyFee: '-1', percent: '101' }), ['monthlyFee', 'percent']);
    assert.deepEqual(paths({ monthlyFee: '50001' }), ['monthlyFee']);
    assert.deepEqual(paths({ monthlyFee: '50000' }), [], 'o teto é R$ 50.000,00');
    assert.deepEqual(paths({ effective: 'ontem' }), ['effective']);
    assert.deepEqual(paths({ note: 'x'.repeat(201) }), ['note']);
    assert.deepEqual(paths({ note: 'a\u0000b' }), ['note']);
    assert.ok(validatePlanInput(null).errors.length === 0 && validatePlanInput('x').value !== null, 'entrada sem forma vira o plano zerado, sem quebrar');
  });

  it('pagamento: valor maior que zero, data real e não futura', () => {
    const now = new Date('2026-11-25T12:00:00Z');
    assert.deepEqual(validatePaymentInput({ amount: '150,50', paidAt: '2026-11-20', note: 'PIX' }, now).value, { amountCents: 15050, paidAt: '2026-11-20', note: 'PIX' });
    assert.deepEqual(validatePaymentInput({ amount: 10 }, now).value, { amountCents: 1000, paidAt: null, note: null });
    const paths = (raw) => validatePaymentInput(raw, now).errors.map((e) => e.path).sort();
    assert.deepEqual(paths({}), ['amount']);
    assert.deepEqual(paths({ amount: '0' }), ['amount']);
    assert.deepEqual(paths({ amount: '5000001' }), ['amount']);
    assert.deepEqual(paths({ amount: '5', paidAt: '2026-02-30' }), ['paidAt']);
    assert.deepEqual(paths({ amount: '5', paidAt: '25/11/2026' }), ['paidAt']);
    assert.deepEqual(paths({ amount: '5', paidAt: '2027-01-01' }), ['paidAt']);
    assert.deepEqual(paths({ amount: '5', note: 'x'.repeat(201) }), ['note']);
  });

  it('cotação: só moeda estrangeira (o real vale 1) e valor positivo, em reais por unidade', () => {
    assert.deepEqual(validateRateInput('USD', { brlPerUnit: '5,43' }).value, { currency: 'USD', brlPerUnit: 5.43 });
    assert.deepEqual(validateRateInput('EUR', { brlPerUnit: 6.1234 }).value, { currency: 'EUR', brlPerUnit: 6.1234 });
    assert.deepEqual(validateRateInput('COP', { brlPerUnit: '0.001428' }).value, { currency: 'COP', brlPerUnit: 0.001428 });
    for (const [currency, body] of [['BRL', { brlPerUnit: 1 }], ['usd', { brlPerUnit: 5 }], ['US', { brlPerUnit: 5 }], ['USD', { brlPerUnit: 0 }], ['USD', { brlPerUnit: -1 }], ['USD', { brlPerUnit: 'x' }], ['USD', {}], ['USD', null], ['USD', { brlPerUnit: 1.1234567 }], ['USD', { brlPerUnit: 200000 }], ['USD', { usdPerUnit: 5 }]]) {
      assert.ok(validateRateInput(currency, body).errors.length > 0, `${currency} ${JSON.stringify(body)}`);
    }
    assert.equal(BASE_CURRENCY, 'BRL');
  });
});

describe('Câmbio: o gasto em qualquer moeda vira centavos de real, sem erro de arredondamento', () => {
  const rates = new Map([['USD', 5.4321], ['EUR', 6.0], ['COP', 0.001428]]);

  it('converte cada moeda pela sua cotação e soma; o real passa direto', () => {
    const out = convertToBrlCents([{ currency: 'USD', spend: 96 }, { currency: 'BRL', spend: 10 }, { currency: 'EUR', spend: 2.5 }], rates);
    assert.deepEqual(out.breakdown, [
      { currency: 'USD', spend: 96, rate: 5.4321, cents: 52148 }, // 96 × 5,4321 = 521,4816
      { currency: 'BRL', spend: 10, rate: 1, cents: 1000 },
      { currency: 'EUR', spend: 2.5, rate: 6, cents: 1500 },
    ]);
    assert.equal(out.cents, 52148 + 1000 + 1500);
    assert.deepEqual(out.unconverted, []);
  });

  it('arredonda ao centavo (meio centavo sobe) e não sofre do erro do ponto flutuante', () => {
    assert.equal(convertToBrlCents([{ currency: 'BRL', spend: 10.005 }], rates).cents, 1001);
    assert.equal(convertToBrlCents([{ currency: 'BRL', spend: 0.004 }], rates).cents, 0);
    assert.equal(convertToBrlCents([{ currency: 'BRL', spend: 0.005 }], rates).cents, 1);
    // 1,15 × 100 em ponto flutuante dá 114,99999…: aqui continua exato
    assert.equal(convertToBrlCents([{ currency: 'BRL', spend: 1.15 }], rates).cents, 115);
    assert.equal(convertToBrlCents([{ currency: 'USD', spend: 0.1 }], new Map([['USD', 3]])).cents, 30);
    assert.equal(convertToBrlCents([{ currency: 'COP', spend: 1_000_000 }], rates).cents, 142_800, 'moeda de cotação pequena (COP) mantém a precisão');
  });

  it('aguenta valores enormes sem perder centavos', () => {
    assert.equal(convertToBrlCents([{ currency: 'USD', spend: 90_000_000 }], new Map([['USD', 5.5]])).cents, 49_500_000_000);
  });

  it('moeda sem cotação NÃO entra na conta e é avisada (nunca vira zero em silêncio nem é chutada)', () => {
    const out = convertToBrlCents([{ currency: 'ARS', spend: 1234.567 }, { currency: 'BRL', spend: 5 }, { currency: 'UNKNOWN', spend: 7 }], rates);
    assert.equal(out.cents, 500);
    assert.deepEqual(out.unconverted, [{ currency: 'ARS', spend: 1234.57 }, { currency: 'UNKNOWN', spend: 7 }]);
  });

  it('ignora linhas sem gasto e valores estranhos', () => {
    const out = convertToBrlCents([{ currency: 'USD', spend: 0 }, { currency: 'USD', spend: -3 }, { currency: 'USD', spend: NaN }, { currency: 'USD', spend: 'x' }, { currency: 'USD', spend: Infinity }], rates);
    assert.deepEqual(out, { cents: 0, breakdown: [], unconverted: [] });
    assert.deepEqual(convertToBrlCents([], rates), { cents: 0, breakdown: [], unconverted: [] });
  });
});

describe('Faturas: valor mínimo, vencimento e situação calculada pelos pagamentos', () => {
  it('a fatura só é emitida a partir de R$ 50,00 acumulados (abaixo disso o valor espera)', () => {
    assert.equal(INVOICE_MIN_CENTS, 5000);
    assert.equal(canIssueInvoice(4999), false);
    assert.equal(canIssueInvoice(5000), true);
    assert.equal(canIssueInvoice(0), false);
    assert.equal(canIssueInvoice(-100), false);
  });

  it('vence em 5 dias corridos (UTC), inclusive virando o mês e o ano', () => {
    assert.equal(INVOICE_DUE_DAYS, 5);
    assert.equal(dueDateOf(new Date('2026-11-25T15:00:00Z')), '2026-11-30');
    assert.equal(dueDateOf(new Date('2026-11-28T23:59:59Z')), '2026-12-03');
    assert.equal(dueDateOf(new Date('2026-12-30T00:00:00Z')), '2027-01-04');
  });

  const invoices = [
    { id: 1, amountCents: 5000, dueDate: '2026-11-05' },
    { id: 2, amountCents: 7000, dueDate: '2026-12-05' },
    { id: 3, amountCents: 9000, dueDate: '2027-01-05' },
  ];
  const status = (paid, today = '2026-11-01') => allocateInvoices(invoices, paid, today).map((i) => [i.status, i.remainingCents]);

  it('os pagamentos quitam da fatura mais antiga para a mais nova', () => {
    assert.deepEqual(status(0), [['open', 5000], ['open', 7000], ['open', 9000]]);
    assert.deepEqual(status(5000), [['paid', 0], ['open', 7000], ['open', 9000]]);
    assert.deepEqual(status(8000), [['paid', 0], ['partial', 4000], ['open', 9000]]);
    assert.deepEqual(status(21000), [['paid', 0], ['paid', 0], ['paid', 0]]);
    assert.deepEqual(status(99999), [['paid', 0], ['paid', 0], ['paid', 0]], 'pagar a mais não passa de pago');
    assert.deepEqual(status(-50), [['open', 5000], ['open', 7000], ['open', 9000]], 'valor negativo vale zero');
  });

  it('fatura em aberto depois do vencimento fica "vencida"; a paga nunca', () => {
    assert.deepEqual(status(0, '2026-11-06').map(([s]) => s), ['overdue', 'open', 'open']);
    assert.deepEqual(status(5000, '2026-12-06').map(([s]) => s), ['paid', 'overdue', 'open']);
    assert.deepEqual(status(5000, '2026-11-05').map(([s]) => s), ['paid', 'open', 'open'], 'no próprio dia do vencimento ainda não venceu');
    assert.deepEqual(allocateInvoices([], 5000, '2026-11-01'), []);
  });

  it('marcar como paga: data real e não futura, observação curta; o valor nunca vem do cliente', () => {
    const now = new Date('2026-11-25T12:00:00Z');
    assert.deepEqual(validateInvoicePayInput({ paidAt: '2026-11-20', note: ' PIX  recebido ' }, now).value, { paidAt: '2026-11-20', note: 'PIX recebido' });
    assert.deepEqual(validateInvoicePayInput({}, now).value, { paidAt: null, note: null });
    assert.deepEqual(validateInvoicePayInput({ amount: 1, paidAt: '' }, now).value, { paidAt: null, note: null }, 'um "amount" enviado é simplesmente ignorado');
    const paths = (raw) => validateInvoicePayInput(raw, now).errors.map((e) => e.path).sort();
    assert.deepEqual(paths({ paidAt: '2027-01-01' }), ['paidAt']);
    assert.deepEqual(paths({ paidAt: '2026-02-30' }), ['paidAt']);
    assert.deepEqual(paths({ note: 'x'.repeat(201) }), ['note']);
    assert.equal(validateInvoicePayInput(null, now).value.paidAt, null);
  });
});

describe('Cotação em reais (texto)', () => {
  it('mostra as casas que a cotação precisa', async () => {
    const { formatRate } = await import('../shared/billing.js');
    assert.match(formatRate(5.4321), /^R\$\s5,4321$/);
    assert.match(formatRate(6), /^R\$\s6,00$/);
    assert.match(formatRate(0.001428), /^R\$\s0,001428$/);
    assert.match(formatRate(1234.5), /^R\$\s1\.234,50$/);
    assert.match(formatRate(1 / 0.18), /^R\$\s5,5556$/, 'cotação com muitas casas: 4 casas de R$ 1 para cima');
    assert.match(formatRate(0.5555555), /^R\$\s0,555556$/, 'abaixo de R$ 1 mantém 6 casas');
  });
});
