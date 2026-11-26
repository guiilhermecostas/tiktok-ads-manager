import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLOSE_GRACE_MS, canClose, chargeFor, formatPercentBp, formatUsd, isMonthStart, monthLabel, monthOf, monthsBetween, nextMonth, parsePercentToBp, parseUsdToCents, planSummary, validatePaymentInput, validatePlanInput, validateRateInput } from '../shared/billing.js';

describe('Assinaturas (regras compartilhadas, tudo em dólar)', () => {
  it('dólar vira centavos inteiros, sem arredondar em silêncio', () => {
    assert.equal(parseUsdToCents('99,90'), 9990);
    assert.equal(parseUsdToCents('99.9'), 9990);
    assert.equal(parseUsdToCents(199.9), 19990);
    assert.equal(parseUsdToCents('0'), 0);
    assert.equal(parseUsdToCents(0), 0);
    assert.equal(parseUsdToCents(' 12 '), 1200);
    for (const bad of ['1,234', '-5', '1e3', 'abc', '', '1.000,50', '12.', NaN, Infinity, null, undefined, {}, [], 0.001, -1, '1,5,5']) assert.equal(parseUsdToCents(bad), null, String(bad));
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
    // usuário A: US$ 0 + 10%; B: US$ 99,90 + 5%; C: US$ 199,90 + 0%  — gasto de US$ 1.000,00
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
    assert.equal(huge.percentFeeCents, 9_000_000_000_000, '100% de US$ 90 bilhões');
    assert.equal(chargeFor({ spendCents: -50, monthlyFeeCents: 100, percentBp: 1000 }).totalCents, 100, 'gasto negativo vale zero');
  });

  it('formatos e resumo do plano', () => {
    assert.match(formatUsd(9990), /^US\$\s99,90$/);
    assert.match(formatUsd(123456789), /^US\$\s1\.234\.567,89$/);
    assert.equal(formatPercentBp(1000), '10%');
    assert.equal(formatPercentBp(550), '5,5%');
    assert.match(planSummary({ monthlyFeeCents: 9990, percentBp: 500 }), /^US\$\s99,90\/mês \+ 5% do gasto$/);
    assert.equal(planSummary({ monthlyFeeCents: 0, percentBp: 1000 }), '10% do gasto');
    assert.match(planSummary({ monthlyFeeCents: 19990, percentBp: 0 }), /^US\$\s199,90\/mês$/);
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
    assert.deepEqual(paths({ monthlyFee: '10001' }), ['monthlyFee']);
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
    assert.deepEqual(paths({ amount: '1000001' }), ['amount']);
    assert.deepEqual(paths({ amount: '5', paidAt: '2026-02-30' }), ['paidAt']);
    assert.deepEqual(paths({ amount: '5', paidAt: '25/11/2026' }), ['paidAt']);
    assert.deepEqual(paths({ amount: '5', paidAt: '2027-01-01' }), ['paidAt']);
    assert.deepEqual(paths({ amount: '5', note: 'x'.repeat(201) }), ['note']);
  });

  it('cotação: só moeda estrangeira e valor positivo', () => {
    assert.deepEqual(validateRateInput('BRL', { usdPerUnit: '0,18' }).value, { currency: 'BRL', usdPerUnit: 0.18 });
    assert.deepEqual(validateRateInput('EUR', { usdPerUnit: 1.08 }).value, { currency: 'EUR', usdPerUnit: 1.08 });
    for (const [currency, body] of [['USD', { usdPerUnit: 1 }], ['brl', { usdPerUnit: 1 }], ['BR', { usdPerUnit: 1 }], ['BRL', { usdPerUnit: 0 }], ['BRL', { usdPerUnit: -1 }], ['BRL', { usdPerUnit: 'x' }], ['BRL', {}], ['BRL', null], ['BRL', { usdPerUnit: 1.1234567 }], ['BRL', { usdPerUnit: 200000 }]]) {
      assert.ok(validateRateInput(currency, body).errors.length > 0, `${currency} ${JSON.stringify(body)}`);
    }
  });
});
