import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { INVOICE_MIN_CENTS } from '../shared/billing.js';
import { all, createUser, loginAdmin, one, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, adminImpersonate: 1000, billingRead: 10000, billingAdminRead: 10000, billingAdminWrite: 10000 };

describe('Faturas: emitidas no fechamento a partir de R$ 50,00, quitadas pelos pagamentos e marcadas como pagas pelo admin', () => {
  let ctx;
  let admin;
  let nowMs;
  const setNow = (iso) => { nowMs = Date.parse(iso); };
  before(async () => {
    setNow('2026-11-25T17:20:00Z');
    ctx = await startTestServer({ limits: LIMITS, clock: () => new Date(nowMs) });
    admin = await loginAdmin(ctx);
  });
  after(() => ctx.stop());

  const reset = async () => {
    for (const table of ['spend_ledger', 'billing_locks', 'billing_payments', 'billing_invoices', 'billing_statements', 'billing_plans', 'billing_rates', 'tiktok_hourly_spend', 'tiktok_business_centers']) await run(ctx.db, `DELETE FROM ${table}`);
    setNow('2026-11-25T17:20:00Z');
  };
  const person = async (name) => {
    const user = await createUser(ctx, { approve: true, name });
    await run(ctx.db, 'DELETE FROM billing_plans WHERE user_id = $1', [user.id]);
    return user;
  };
  const plan = (who, monthlyFee, percent) => admin.put(`/api/admin/billing/users/${who.id}/plan`, { monthlyFee, percent });
  const seed = (who, hour, spend, currency = 'BRL', advertiser = '9001') => run(ctx.db, 'INSERT INTO spend_ledger (owner_id, advertiser_id, hour_start, currency, spend) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (owner_id, advertiser_id, hour_start) DO UPDATE SET spend = EXCLUDED.spend', [who.id, advertiser, hour, currency, spend]);
  const mine = async (who) => (await who.client.get('/api/billing/me')).json;
  const payInvoice = (who, invoiceId, body = {}) => admin.post(`/api/admin/billing/users/${who.id}/invoices/${invoiceId}/pay`, body);
  const closeAll = async (iso) => { setNow(iso); return ctx.billing.closeDueMonths(); };

  describe('emissão', () => {
    it('mês fechado com R$ 50,00 ou mais vira fatura (vence em 5 dias) cobrindo aquele mês', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '0', '10');
      await seed(a, '2026-11-10T12:00:00Z', 1000); // 10% de R$ 1.000 = R$ 100
      await closeAll('2026-12-03T00:00:01Z');
      const res = await mine(a);
      assert.equal(res.invoices.length, 1);
      const [invoice] = res.invoices;
      assert.deepEqual([invoice.amountCents, invoice.periodFrom, invoice.periodTo, invoice.status, invoice.remainingCents], [10000, '2026-11-01', '2026-11-01', 'open', 10000]);
      assert.equal(invoice.dueDate, '2026-12-08');
      assert.equal(res.invoiceMinCents, INVOICE_MIN_CENTS);
      assert.equal(res.openInvoicesCents, 10000);
    });

    it('abaixo de R$ 50,00 NÃO emite fatura: o valor acumula e entra na fatura seguinte, com os meses cobertos', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '0', '10');
      await seed(a, '2026-11-10T12:00:00Z', 300); // R$ 30
      await closeAll('2026-12-03T00:00:01Z');
      let res = await mine(a);
      assert.deepEqual(res.invoices, [], 'R$ 30 ainda não dá fatura');
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_invoices')).c, 0);
      assert.equal(res.accruedCents, 3000, 'continua acumulando');
      await seed(a, '2026-12-10T12:00:00Z', 400); // + R$ 40 = R$ 70 acumulados
      await closeAll('2027-01-03T00:00:01Z');
      res = await mine(a);
      assert.equal(res.invoices.length, 1);
      assert.deepEqual([res.invoices[0].amountCents, res.invoices[0].periodFrom, res.invoices[0].periodTo], [7000, '2026-11-01', '2026-12-01']);
    });

    it('o limite é exato: R$ 49,99 espera e R$ 50,00 emite', async () => {
      await reset();
      const a = await person('Pessoa A');
      const b = await person('Pessoa B');
      await plan(a, '49,99', '0');
      await plan(b, '50', '0');
      await closeAll('2026-12-03T00:00:01Z');
      assert.equal((await mine(a)).invoices.length, 0);
      assert.deepEqual((await mine(b)).invoices.map((i) => i.amountCents), [5000]);
    });

    it('é idempotente: rodar o fechamento de novo nunca repete a fatura nem muda o valor', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '100', '0');
      await closeAll('2026-12-03T00:00:01Z');
      await ctx.billing.closeDueMonths();
      await ctx.billing.closeDueMonths();
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_invoices')).c, 1);
      assert.equal((await mine(a)).invoices[0].amountCents, 10000);
    });

    it('cada mês seguinte gera a sua fatura; os períodos nunca se sobrepõem e a soma bate com o cobrado', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '100', '0');
      await closeAll('2026-12-03T00:00:01Z');
      await closeAll('2027-01-03T00:00:01Z');
      await closeAll('2027-02-03T00:00:01Z');
      const { invoices, months } = await mine(a);
      assert.deepEqual(invoices.map((i) => [i.periodFrom, i.periodTo, i.amountCents]), [['2026-11-01', '2026-11-01', 10000], ['2026-12-01', '2026-12-01', 10000], ['2027-01-01', '2027-01-01', 10000]]);
      assert.equal(invoices.reduce((t, i) => t + i.amountCents, 0), months.filter((m) => m.closed).reduce((t, m) => t + m.totalCents, 0));
    });

    it('sem plano não há fatura, e o mês em andamento nunca vira fatura', async () => {
      await reset();
      const a = await person('Pessoa A');
      await seed(a, '2026-11-10T12:00:00Z', 5000);
      await closeAll('2026-12-03T00:00:01Z');
      assert.deepEqual((await mine(a)).invoices, []);
      await plan(a, '100', '0');
      setNow('2026-11-25T00:00:00Z');
      await ctx.billing.closeDueMonths();
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_invoices')).c, 0, 'novembro ainda não fechou');
    });

    it('o banco recusa fatura repetida para o mesmo período', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '100', '0');
      await closeAll('2026-12-03T00:00:01Z');
      await assert.rejects(() => run(ctx.db, "INSERT INTO billing_invoices (user_id, amount_cents, period_from, period_to, due_date) VALUES ($1, 5000, '2026-11-01', '2026-11-01', '2026-12-08')", [a.id]));
    });
  });

  describe('marcar como paga (admin)', () => {
    const withTwoInvoices = async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '100', '0');
      await closeAll('2026-12-03T00:00:01Z');
      await closeAll('2027-01-03T00:00:01Z');
      const { invoices } = await mine(a);
      return { a, first: invoices[0], second: invoices[1] };
    };

    it('registra o pagamento do que falta da fatura, ligado a ela, com a data e a observação', async () => {
      const { a, first } = await withTwoInvoices();
      const res = await payInvoice(a, first.id, { paidAt: '2026-12-05', note: 'PIX recebido' });
      assert.equal(res.status, 201, res.text);
      const payment = await one(ctx.db, 'SELECT amount_cents, to_char(paid_at, \'YYYY-MM-DD\') AS paid_at, note, invoice_id FROM billing_payments');
      assert.deepEqual([Number(payment.amount_cents), payment.paid_at, payment.note, payment.invoice_id], [10000, '2026-12-05', 'PIX recebido', first.id]);
      const view = await mine(a);
      assert.deepEqual(view.invoices.map((i) => i.status), ['paid', 'open']);
      assert.equal(view.openInvoicesCents, 10000);
      assert.equal(res.json.invoices[0].status, 'paid', 'o admin recebe o extrato já atualizado');
    });

    it('sem observação, o pagamento diz de qual fatura veio', async () => {
      const { a, first } = await withTwoInvoices();
      await payInvoice(a, first.id);
      assert.equal((await one(ctx.db, 'SELECT note FROM billing_payments')).note, `Fatura nº ${first.id}`);
    });

    it('só a fatura MAIS ANTIGA em aberto pode ser marcada (409); depois dela, a seguinte', async () => {
      const { a, first, second } = await withTwoInvoices();
      const skipped = await payInvoice(a, second.id);
      assert.equal(skipped.status, 409);
      assert.equal(skipped.json.error.code, 'pay_older_first');
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_payments')).c, 0);
      assert.equal((await payInvoice(a, first.id)).status, 201);
      assert.equal((await payInvoice(a, second.id)).status, 201);
      assert.deepEqual((await mine(a)).invoices.map((i) => i.status), ['paid', 'paid']);
    });

    it('marcar de novo uma fatura já paga é 409 e não duplica o pagamento', async () => {
      const { a, first } = await withTwoInvoices();
      await payInvoice(a, first.id);
      const again = await payInvoice(a, first.id);
      assert.equal(again.status, 409);
      assert.equal(again.json.error.code, 'already_paid');
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_payments')).c, 1);
    });

    it('duas marcações ao mesmo tempo pagam UMA vez só', async () => {
      const { a, first } = await withTwoInvoices();
      const results = await Promise.all([payInvoice(a, first.id), payInvoice(a, first.id)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_payments')).c, 1);
    });

    it('um pagamento avulso já pode ter quitado a fatura: nesse caso ela aparece paga e não dá para pagar duas vezes', async () => {
      const { a, first } = await withTwoInvoices();
      assert.equal((await admin.post(`/api/admin/billing/users/${a.id}/payments`, { amount: '100' })).status, 201);
      assert.equal((await mine(a)).invoices[0].status, 'paid');
      assert.equal((await payInvoice(a, first.id)).status, 409);
    });

    it('pagamento parcial avulso: a fatura fica "parcial" e marcar como paga cobra só o que falta', async () => {
      const { a, first } = await withTwoInvoices();
      await admin.post(`/api/admin/billing/users/${a.id}/payments`, { amount: '40' });
      const partial = (await mine(a)).invoices[0];
      assert.deepEqual([partial.status, partial.paidCents, partial.remainingCents], ['overdue', 4000, 6000], 'já vencida (fechou em jan): "vencida" tem prioridade, mas o parcial aparece nos valores');
      setNow('2026-12-04T00:00:00Z');
      assert.equal((await mine(a)).invoices[0].status, 'partial', 'dentro do prazo, a fatura parcialmente paga é "parcial"');
      setNow('2027-01-03T00:00:01Z');
      assert.equal((await payInvoice(a, first.id)).status, 201);
      assert.equal(Number((await one(ctx.db, 'SELECT amount_cents FROM billing_payments WHERE invoice_id IS NOT NULL')).amount_cents), 6000);
    });

    it('fatura vencida aparece como "vencida" até ser paga', async () => {
      const { a, first } = await withTwoInvoices();
      setNow('2027-01-10T00:00:00Z');
      assert.equal((await mine(a)).invoices[0].status, 'overdue');
      await payInvoice(a, first.id);
      assert.equal((await mine(a)).invoices[0].status, 'paid');
    });

    it('fatura de outra pessoa ou inexistente: 404; ids inválidos: 400; data futura ou observação enorme: 400', async () => {
      const { a, first } = await withTwoInvoices();
      const other = await person('Pessoa B');
      assert.equal((await payInvoice(other, first.id)).status, 404, 'fatura da Pessoa A não vale para a B');
      assert.equal((await payInvoice(a, 999999)).status, 404);
      assert.equal((await admin.post('/api/admin/billing/users/999999/invoices/1/pay', {})).status, 404);
      for (const bad of ['abc', '0', '-1']) assert.equal((await payInvoice(a, bad)).status, 400, bad);
      assert.equal((await payInvoice(a, first.id, { paidAt: '2099-01-01' })).status, 400);
      assert.equal((await payInvoice(a, first.id, { note: 'x'.repeat(201) })).status, 400);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_payments')).c, 0);
    });

    it('o valor nunca vem do cliente: um "amount" enviado é ignorado', async () => {
      const { a, first } = await withTwoInvoices();
      await payInvoice(a, first.id, { amount: '1' });
      assert.equal(Number((await one(ctx.db, 'SELECT amount_cents FROM billing_payments')).amount_cents), 10000);
    });

    it('só o admin marca (usuário 403, visitante 401) e exige o token CSRF', async () => {
      const { a, first } = await withTwoInvoices();
      assert.equal((await a.client.post(`/api/admin/billing/users/${a.id}/invoices/${first.id}/pay`, {})).status, 403);
      assert.equal((await ctx.client().post(`/api/admin/billing/users/${a.id}/invoices/${first.id}/pay`, {})).status, 401);
      assert.equal((await admin.post(`/api/admin/billing/users/${a.id}/invoices/${first.id}/pay`, {}, { withCsrf: false })).status, 403);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_payments')).c, 0);
    });

    it('fica na auditoria, com o valor em reais e sem dado sensível', async () => {
      const { a, first } = await withTwoInvoices();
      await run(ctx.db, 'DELETE FROM admin_audit_log');
      await payInvoice(a, first.id);
      const log = await one(ctx.db, "SELECT detail FROM admin_audit_log WHERE action = 'billing_invoice_paid'");
      assert.match(log.detail, new RegExp(`fatura nº ${first.id} marcada como paga \\(R\\$ 100,00\\)`));
    });

    it('quitar a dívida libera os bloqueios de BC da pessoa', async () => {
      const { a, first, second } = await withTwoInvoices();
      await run(ctx.db, "INSERT INTO billing_locks (owner_id, kind, value, debt_cents) VALUES ($1, 'bc', '777', 20000)", [a.id]);
      await payInvoice(a, first.id);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_locks WHERE released_at IS NULL')).c, 1, 'ainda deve a segunda fatura');
      await payInvoice(a, second.id);
      // sobra a mensalidade do mês em andamento (janeiro): o bloqueio só cai quando TUDO estiver pago
      const left = (await mine(a)).debtCents;
      if (left === 0) assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_locks WHERE released_at IS NULL')).c, 0);
      else assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_locks WHERE released_at IS NULL')).c, 1, 'ainda há o mês em andamento a pagar');
    });
  });

  describe('o que cada lado enxerga', () => {
    it('o admin vê, por pessoa, quanto há em faturas abertas; o total do painel soma tudo', async () => {
      await reset();
      const a = await person('Pessoa A');
      const b = await person('Pessoa B');
      await plan(a, '100', '0');
      await plan(b, '70', '0');
      await closeAll('2026-12-03T00:00:01Z');
      const overview = (await admin.get('/api/admin/billing')).json;
      const row = (who) => overview.users.find((u) => u.id === who.id);
      assert.deepEqual([row(a).openInvoicesCents, row(a).openInvoices], [10000, 1]);
      assert.deepEqual([row(b).openInvoicesCents, row(b).openInvoices], [7000, 1]);
      assert.equal(overview.totals.openInvoicesCents, 17000);
    });

    it('cada pessoa vê só as próprias faturas', async () => {
      await reset();
      const a = await person('Pessoa A');
      const b = await person('Pessoa B');
      await plan(a, '100', '0');
      await closeAll('2026-12-03T00:00:01Z');
      assert.equal((await mine(a)).invoices.length, 1);
      assert.deepEqual((await mine(b)).invoices, []);
    });

    it('o extrato do admin traz as faturas e o vínculo do pagamento com a fatura', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '100', '0');
      await closeAll('2026-12-03T00:00:01Z');
      const [invoice] = (await mine(a)).invoices;
      await payInvoice(a, invoice.id);
      const detail = (await admin.get(`/api/admin/billing/users/${a.id}`)).json;
      assert.equal(detail.invoices[0].status, 'paid');
      assert.equal(detail.payments[0].invoiceId, invoice.id);
    });

    it('apagar a pessoa apaga as faturas dela; os pagamentos ligados a uma fatura nunca ficam apontando para o vazio', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '100', '0');
      await closeAll('2026-12-03T00:00:01Z');
      const [invoice] = (await mine(a)).invoices;
      await payInvoice(a, invoice.id);
      await run(ctx.db, 'DELETE FROM users WHERE id = $1', [a.id]);
      assert.deepEqual(await all(ctx.db, 'SELECT id FROM billing_invoices'), []);
      assert.deepEqual(await all(ctx.db, 'SELECT id FROM billing_payments'), []);
    });
  });
});
