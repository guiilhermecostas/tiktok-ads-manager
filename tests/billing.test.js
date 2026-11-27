import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createBillingService } from '../src/modules/billing/billing.service.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, loginAdmin, one, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, adminImpersonate: 1000, tiktokRead: 1000, tiktokWrite: 1000, billingRead: 10000, billingAdminRead: 10000, billingAdminWrite: 10000 };
const m = (spend) => ({ spend, impressions: spend * 100, clicks: spend * 3, conversion: 1 });

describe('Assinaturas (tudo em real): planos, gasto guardado, cobrança e bloqueio de BC com débito', () => {
  let ctx;
  let fake;
  let admin;
  let nowMs;
  const setNow = (iso) => { nowMs = Date.parse(iso); };
  before(async () => {
    fake = createFakeTiktok();
    setNow('2026-11-25T17:20:00Z');
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn, clock: () => new Date(nowMs) });
    admin = await loginAdmin(ctx);
  });
  after(() => ctx.stop());

  const reset = async () => {
    for (const table of ['spend_ledger', 'billing_locks', 'billing_payments', 'billing_invoices', 'billing_statements', 'billing_plans', 'billing_rates', 'tiktok_hourly_spend', 'tiktok_business_centers']) await run(ctx.db, `DELETE FROM ${table}`);
    setNow('2026-11-25T17:20:00Z');
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9001', '9777'], 333: ['9301'] };
    fake.state.currencies = { 9001: 'BRL', 9002: 'BRL', 9777: 'BRL', 9301: 'BRL' };
    fake.state.validTokens.add(GOOD_TOKEN);
    fake.state.validTokens.add(OTHER_TOKEN);
    fake.state.hourly = {};
    fake.state.failHourlyFor = new Set();
    fake.state.hourlyDelayMs = 0;
  };
  /** Pessoa nova SEM plano: o cadastro já dá o plano padrão (R$ 0 + 10%), que aqui é removido para cada teste partir do zero. */
  const person = async (name) => {
    const user = await createUser(ctx, { approve: true, name });
    await run(ctx.db, 'DELETE FROM billing_plans WHERE user_id = $1', [user.id]);
    return user;
  };
  const plan = (who, monthlyFee, percent, extra = {}) => admin.put(`/api/admin/billing/users/${who.id}/plan`, { monthlyFee, percent, ...extra });
  /** Gasto direto no livro (em real por padrão). `hour`: ISO em UTC. */
  const seed = (who, advertiser, hour, spend, currency = 'BRL') => run(ctx.db, 'INSERT INTO spend_ledger (owner_id, advertiser_id, hour_start, currency, spend) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (owner_id, advertiser_id, hour_start) DO UPDATE SET spend = EXCLUDED.spend', [who.id, advertiser, hour, currency, spend]);
  const mine = async (who) => (await who.client.get('/api/billing/me')).json;
  const overviewRow = async (who) => (await admin.get('/api/admin/billing')).json.users.find((u) => u.id === who.id);
  const connect = async (who, bcId, token = GOOD_TOKEN) => who.client.post('/api/tiktok/business-centers', { name: `BC ${bcId}`, bcId, accessToken: token });

  describe('permissões', () => {
    it('só o admin gerencia planos e cobrança; visitante recebe 401; a conta vê só o próprio extrato', async () => {
      await reset();
      const a = await person('Pessoa A');
      const visitor = ctx.client();
      for (const [method, path, body] of [['get', '/api/admin/billing'], ['get', `/api/admin/billing/users/${a.id}`], ['put', `/api/admin/billing/users/${a.id}/plan`, { monthlyFee: '1', percent: '1' }], ['post', `/api/admin/billing/users/${a.id}/payments`, { amount: '5' }], ['get', '/api/admin/billing/locks'], ['post', '/api/admin/billing/locks/1/release'], ['put', '/api/admin/billing/rates/BRL', { usdPerUnit: '0.2' }]]) {
        assert.equal((await a.client[method](path, body)).status, 403, `usuário ${method} ${path}`);
        assert.equal((await visitor[method](path, body)).status, 401, `visitante ${method} ${path}`);
      }
      assert.equal((await visitor.get('/api/billing/me')).status, 401);
      assert.equal((await a.client.get('/api/billing/me')).status, 200);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_plans')).c, 0);
    });

    it('exige o token CSRF nas alterações', async () => {
      await reset();
      const a = await person('Pessoa A');
      assert.equal((await admin.put(`/api/admin/billing/users/${a.id}/plan`, { monthlyFee: '1', percent: '1' }, { withCsrf: false })).status, 403);
      assert.equal((await admin.post(`/api/admin/billing/users/${a.id}/payments`, { amount: '5' }, { withCsrf: false })).status, 403);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_plans')).c, 0);
    });

    it('colaborador e conta pendente não veem a cobrança do espaço', async () => {
      await reset();
      const owner = await person('Dono');
      const member = await person('Colaborador');
      await run(ctx.db, "INSERT INTO workspace_members (owner_id, user_id, areas) VALUES ($1, $2, ARRAY['reports'])", [owner.id, member.id]);
      const res = await member.client.get('/api/billing/me');
      assert.equal(res.status, 403);
      assert.equal(res.json.error.code, 'owner_only');
      const pending = await createUser(ctx);
      assert.equal((await pending.client.get('/api/billing/me')).json.error.code, 'account_pending');
    });

    it('não dá para definir plano, cobrar nem pagar por um admin ou por conta que não existe', async () => {
      await reset();
      const adminId = (await one(ctx.db, "SELECT id FROM users WHERE role = 'admin'")).id;
      assert.equal((await admin.put(`/api/admin/billing/users/${adminId}/plan`, { monthlyFee: '1', percent: '1' })).status, 404);
      assert.equal((await admin.put('/api/admin/billing/users/999999/plan', { monthlyFee: '1', percent: '1' })).status, 404);
      assert.equal((await admin.post('/api/admin/billing/users/999999/payments', { amount: '5' })).status, 404);
      assert.equal((await admin.get('/api/admin/billing/users/abc')).status, 400);
    });

    it('o admin vendo a conta de alguém (somente leitura) consegue consultar o extrato, mas não alterar', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '10', '5');
      const watcher = await loginAdmin(ctx);
      const entered = await watcher.post(`/api/admin/users/${a.id}/impersonate`);
      watcher.csrf = entered.json.csrfToken;
      const res = await watcher.get('/api/billing/me');
      assert.equal(res.status, 200);
      assert.equal(res.json.plan.monthlyFeeCents, 1000);
      assert.equal((await watcher.put(`/api/admin/billing/users/${a.id}/plan`, { monthlyFee: '0', percent: '0' })).status, 403);
    });
  });

  describe('planos negociáveis por pessoa (os 3 exemplos)', () => {
    it('A: R$ 0 + 10% · B: R$ 99,90 + 5% · C: R$ 199,90 + 0% — com gasto de R$ 1.000 cada', async () => {
      await reset();
      const [a, b, c] = [await person('Pessoa A'), await person('Pessoa B'), await person('Pessoa C')];
      assert.equal((await plan(a, '0', '10')).status, 200);
      assert.equal((await plan(b, '99,90', '5')).status, 200);
      assert.equal((await plan(c, '199,90', '0')).status, 200);
      for (const who of [a, b, c]) await seed(who, '9001', '2026-11-10T12:00:00Z', 1000);
      assert.deepEqual([(await mine(a)).months[0].totalCents, (await mine(b)).months[0].totalCents, (await mine(c)).months[0].totalCents], [10000, 14990, 19990]);
      const rows = (await admin.get('/api/admin/billing')).json;
      assert.deepEqual(rows.users.filter((u) => [a.id, b.id, c.id].includes(u.id)).map((u) => [u.name, u.monthSpendCents, u.monthChargeCents, u.debtCents]).sort(), [['Pessoa A', 100000, 10000, 10000], ['Pessoa B', 100000, 14990, 14990], ['Pessoa C', 100000, 19990, 19990]]);
      assert.equal(rows.totals.billed, 3);
      assert.equal(rows.totals.monthChargeCents, 10000 + 14990 + 19990);
      assert.equal(rows.currentMonth, '2026-11-01');
    });

    it('cada pessoa vê SÓ o próprio plano e gasto', async () => {
      await reset();
      const [a, b] = [await person('Pessoa A'), await person('Pessoa B')];
      await plan(a, '0', '10');
      await plan(b, '50', '2');
      await seed(a, '9001', '2026-11-10T12:00:00Z', 100);
      await seed(b, '9002', '2026-11-10T12:00:00Z', 7000);
      const ma = await mine(a);
      assert.equal(ma.plan.percentBp, 1000);
      assert.equal(ma.months[0].spendCents, 10000);
      assert.equal(JSON.stringify(ma).includes('"userId":' + b.id), false);
      assert.equal((await mine(b)).months[0].spendCents, 700000);
    });

    it('sem plano: nada é cobrado (mas o gasto continua guardado)', async () => {
      await reset();
      const a = await person('Pessoa A');
      await seed(a, '9001', '2026-11-10T12:00:00Z', 500);
      const res = await mine(a);
      assert.equal(res.plan, null);
      assert.deepEqual([res.months.length, res.chargedCents, res.debtCents], [0, 0, 0]);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM spend_ledger')).c, 1);
      const row = await overviewRow(a);
      assert.equal(row.plan, null);
      assert.deepEqual([row.monthSpendCents, row.monthChargeCents, row.debtCents], [50000, 0, 0], 'o admin vê o gasto do mês mesmo sem plano');
    });

    it('o plano vale o mês inteiro desde o dia 1 (o gasto do começo do mês também entra)', async () => {
      await reset();
      const a = await person('Pessoa A');
      await seed(a, '9001', '2026-11-01T00:00:00Z', 100);
      await seed(a, '9001', '2026-11-24T23:00:00Z', 100);
      await seed(a, '9001', '2026-10-31T23:00:00Z', 999); // mês anterior: fora
      await plan(a, '0', '10');
      assert.equal((await mine(a)).months[0].spendCents, 20000);
      assert.equal((await mine(a)).months.length, 1, 'só desde o mês do plano');
    });

    it('"próximo mês" não muda o mês atual; no mês seguinte o novo plano passa a valer, sem mexer no passado', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '10', '10');
      await seed(a, '9001', '2026-11-10T12:00:00Z', 100);
      await seed(a, '9001', '2026-12-05T12:00:00Z', 100);
      assert.equal((await plan(a, '20', '0', { effective: 'next' })).status, 200);
      let res = await mine(a);
      assert.equal(res.plan.monthlyFeeCents, 1000);
      assert.equal(res.nextPlan.monthlyFeeCents, 2000);
      assert.equal(res.nextPlan.effectiveMonth, '2026-12-01');
      assert.equal(res.months[0].totalCents, 1000 + 1000);
      setNow('2026-12-10T12:00:00Z');
      res = await mine(a);
      assert.deepEqual(res.months.map((x) => [x.period, x.totalCents]), [['2026-12-01', 2000], ['2026-11-01', 2000]], 'dezembro: 20 + 0%; novembro continua 10 + 10% de 100');
      assert.equal(res.plan.monthlyFeeCents, 2000);
    });

    it('trocar o plano no mesmo mês substitui o anterior (um plano por mês)', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '10', '10');
      await plan(a, '30', '3', { note: 'Renegociado' });
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_plans')).c, 1);
      const res = await mine(a);
      assert.deepEqual([res.plan.monthlyFeeCents, res.plan.percentBp, res.plan.note], [3000, 300, 'Renegociado']);
    });

    it('valida os valores: negativo, percentual > 100, mais de 2 casas e vigência inválida são 400', async () => {
      await reset();
      const a = await person('Pessoa A');
      for (const body of [{ monthlyFee: '-1', percent: '5' }, { monthlyFee: '5', percent: '101' }, { monthlyFee: '1,234', percent: '5' }, { monthlyFee: '5', percent: '5,555' }, { monthlyFee: '99999', percent: '5' }, { monthlyFee: '5', percent: '5', effective: 'ontem' }, { monthlyFee: 'x', percent: 'y' }]) {
        const res = await plan(a, body.monthlyFee, body.percent, { effective: body.effective });
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.json.error.code, 'validation_error');
      }
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_plans')).c, 0);
      assert.equal((await admin.put(`/api/admin/billing/users/${a.id}/plan`, [1])).status, 400);
    });

    it('o plano fica registrado na auditoria', async () => {
      await reset();
      await run(ctx.db, 'DELETE FROM admin_audit_log');
      const a = await person('Auditada');
      await plan(a, '99,90', '5');
      const log = await one(ctx.db, "SELECT action, detail FROM admin_audit_log WHERE action = 'billing_plan'");
      assert.match(log.detail, /Auditada: R\$ 99,90\/mês \+ 5% a partir de 2026-11/);
    });
  });

  describe('gasto guardado (livro)', () => {
    it('o valor de uma hora só SOBE: baixar o número depois não diminui a cobrança', async () => {
      await reset();
      const a = await person('Pessoa A');
      const { createBillingRepository } = await import('../src/modules/billing/billing.repository.js');
      const repo = createBillingRepository(ctx.db);
      const hour = new Date('2026-11-10T12:00:00Z');
      await repo.recordSpend(a.id, '9001', 'USD', [{ hourStart: hour, spend: 50 }]);
      await repo.recordSpend(a.id, '9001', 'USD', [{ hourStart: hour, spend: 20 }]);
      assert.equal(Number((await one(ctx.db, 'SELECT spend FROM spend_ledger')).spend), 50);
      await repo.recordSpend(a.id, '9001', 'USD', [{ hourStart: hour, spend: 80 }]);
      assert.equal(Number((await one(ctx.db, 'SELECT spend FROM spend_ledger')).spend), 80);
      assert.equal(await repo.recordSpend(a.id, '9001', 'USD', [{ hourStart: hour, spend: -5 }, { hourStart: 'x', spend: 1 }, { hourStart: hour, spend: NaN }]), 0, 'linhas inválidas são ignoradas');
    });

    it('gasto em outra moeda é CONVERTIDO para real pela cotação; sem cotação fica "não convertido" e é avisado', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '0', '10');
      await seed(a, '9001', '2026-11-10T12:00:00Z', 100, 'USD');
      await seed(a, '9002', '2026-11-10T12:00:00Z', 500, 'BRL');
      await seed(a, '9003', '2026-11-10T12:00:00Z', 40, 'UNKNOWN');
      let res = await mine(a);
      assert.equal(res.months[0].spendCents, 50000, 'só os R$ 500 entram: o dólar ainda não tem cotação');
      assert.deepEqual(res.months[0].unconverted.map((u) => [u.currency, u.spend]).sort(), [['UNKNOWN', 40], ['USD', 100]]);
      assert.deepEqual((await overviewRow(a)).unconverted.length, 2);
      assert.equal((await admin.put('/api/admin/billing/rates/USD', { brlPerUnit: '5,50' })).status, 200);
      res = await mine(a);
      assert.equal(res.months[0].spendCents, 50000 + 55000, '100 USD × 5,50 = R$ 550');
      assert.equal(res.months[0].percentFeeCents, 10500, '10% de R$ 1.050,00');
      assert.deepEqual(res.months[0].unconverted.map((u) => u.currency), ['UNKNOWN']);
      assert.deepEqual(res.months[0].breakdown.map((b) => [b.currency, b.spend, b.rate, b.cents]).sort(), [['BRL', 500, 1, 50000], ['USD', 100, 5.5, 55000]], 'o extrato mostra de onde veio cada real');
    });

    it('cotação: valida moeda e valor (BRL e valores ruins recusados); fixa à mão, lista no painel e pode ser removida', async () => {
      await reset();
      for (const [currency, body] of [['BRL', { brlPerUnit: '1' }], ['BR', { brlPerUnit: '1' }], ['USD', { brlPerUnit: '0' }], ['USD', { brlPerUnit: '-1' }], ['USD', {}], ['USD', { brlPerUnit: 'abc' }], ['USD', { usdPerUnit: '5' }]]) {
        assert.equal((await admin.put(`/api/admin/billing/rates/${currency}`, body)).status, 400, `${currency} ${JSON.stringify(body)}`);
      }
      assert.equal((await admin.put('/api/admin/billing/rates/eur', { brlPerUnit: 6.1 })).status, 200, 'aceita minúsculas na URL');
      const listed = (await admin.get('/api/admin/billing')).json;
      assert.deepEqual(listed.rates.map((r) => [r.currency, r.brlPerUnit, r.source]), [['EUR', 6.1, 'manual']]);
      assert.equal(listed.fx.enabled, true);
      assert.equal((await admin.delete('/api/admin/billing/rates/eur')).status, 200);
      assert.deepEqual((await admin.get('/api/admin/billing')).json.rates, []);
      assert.equal((await admin.delete('/api/admin/billing/rates/eur')).status, 404, 'remover o que não existe');
      assert.equal((await admin.delete('/api/admin/billing/rates/BRL')).status, 400);
    });

    it('a coleta por hora grava no livro (e a reconferência diária recupera horas perdidas)', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '0', '10');
      assert.equal((await connect(a, '111')).status, 201);
      fake.state.hourly = { 9001: { '2026-11-25': { 10: m(5.5), 11: m(2) }, '2026-11-24': { 20: m(7) } } };
      await ctx.hourly.collectAll();
      const rows = await all(ctx.db, 'SELECT advertiser_id, spend::float AS spend FROM spend_ledger ORDER BY hour_start');
      assert.ok(rows.length >= 2 && rows.every((r) => r.advertiser_id === '9001'));
      assert.equal((await mine(a)).months[0].spendCents, 1450);
    });
  });

  describe('fechamento dos meses', () => {
    it('o mês só fecha 2 dias depois de acabar, uma vez, e o fechamento não muda mais', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '10', '10');
      await seed(a, '9001', '2026-11-10T12:00:00Z', 100);
      setNow('2026-12-02T12:00:00Z');
      assert.equal(await ctx.billing.closeDueMonths(), 0, 'ainda dentro da folga');
      setNow('2026-12-03T00:00:01Z');
      assert.equal(await ctx.billing.closeDueMonths(), 1);
      assert.equal(await ctx.billing.closeDueMonths(), 0, 'idempotente');
      const stored = await one(ctx.db, 'SELECT monthly_fee_cents, percent_bp, spend_cents, total_cents FROM billing_statements');
      assert.deepEqual([stored.monthly_fee_cents, stored.percent_bp, Number(stored.spend_cents), Number(stored.total_cents)], [1000, 1000, 10000, 2000]);
      // depois do fechamento: mudar o plano, mudar a cotação ou chegar gasto atrasado NÃO altera novembro
      await plan(a, '500', '50');
      await seed(a, '9001', '2026-11-11T12:00:00Z', 99999);
      const res = await mine(a);
      const november = res.months.find((x) => x.period === '2026-11-01');
      assert.deepEqual([november.closed, november.totalCents, november.spendCents], [true, 2000, 10000]);
      const december = res.months.find((x) => x.period === '2026-12-01');
      assert.deepEqual([december.closed, december.monthlyFeeCents, december.percentBp], [false, 50000, 5000], 'o mês novo usa o plano novo');
    });

    it('vários meses sem fechar (servidor parado) fecham todos de uma vez, cada um com o plano da época', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '10', '0');
      await run(ctx.db, "INSERT INTO billing_plans (user_id, monthly_fee_cents, percent_bp, effective_month) VALUES ($1, 5000, 0, '2026-12-01')", [a.id]);
      setNow('2027-02-10T00:00:00Z');
      assert.equal(await ctx.billing.closeDueMonths(), 3, 'nov, dez e jan');
      assert.deepEqual((await all(ctx.db, "SELECT to_char(period, 'YYYY-MM') AS p, monthly_fee_cents AS fee FROM billing_statements ORDER BY period")).map((r) => [r.p, r.fee]), [['2026-11', 1000], ['2026-12', 5000], ['2027-01', 5000]]);
    });

    it('uma pessoa sem plano nunca tem fechamento', async () => {
      await reset();
      const a = await person('Pessoa A');
      await seed(a, '9001', '2026-10-10T12:00:00Z', 100);
      setNow('2027-01-10T00:00:00Z');
      assert.equal(await ctx.billing.closeDueMonths(), 0);
    });
  });

  describe('pagamentos e saldo', () => {
    it('o pagamento reduz o que está em aberto; pagar a mais vira crédito e o débito nunca fica negativo', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '100', '0');
      assert.equal((await mine(a)).debtCents, 10000);
      const res = await admin.post(`/api/admin/billing/users/${a.id}/payments`, { amount: '40,50', paidAt: '2026-11-20', note: 'PIX convertido' });
      assert.equal(res.status, 201);
      assert.deepEqual([res.json.paidCents, res.json.debtCents, res.json.balanceCents], [4050, 5950, 5950]);
      assert.equal(res.json.payments[0].note, 'PIX convertido');
      await admin.post(`/api/admin/billing/users/${a.id}/payments`, { amount: '100' });
      const settled = await mine(a);
      assert.deepEqual([settled.debtCents, settled.balanceCents], [0, -4050]);
      assert.equal(settled.payments.length, 2);
    });

    it('valida o pagamento: zero, negativo, mais de 2 casas, data falsa ou futura são 400', async () => {
      await reset();
      const a = await person('Pessoa A');
      for (const body of [{ amount: '0' }, { amount: '-5' }, { amount: '1,234' }, {}, { amount: '5', paidAt: '2026-02-30' }, { amount: '5', paidAt: '2027-12-31' }, { amount: '5', note: 'x'.repeat(201) }, { amount: '9999999' }]) {
        assert.equal((await admin.post(`/api/admin/billing/users/${a.id}/payments`, body)).status, 400, JSON.stringify(body));
      }
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_payments')).c, 0);
    });

    it('os pagamentos ficam na auditoria e o banco recusa valores incoerentes', async () => {
      await reset();
      await run(ctx.db, 'DELETE FROM admin_audit_log');
      const a = await person('Pessoa A');
      await admin.post(`/api/admin/billing/users/${a.id}/payments`, { amount: '12,34' });
      assert.match((await one(ctx.db, "SELECT detail FROM admin_audit_log WHERE action = 'billing_payment'")).detail, /R\$ 12,34 recebido/);
      const bad = [
        `INSERT INTO billing_payments (user_id, amount_cents) VALUES (${a.id}, 0)`,
        `INSERT INTO billing_payments (user_id, amount_cents) VALUES (${a.id}, -5)`,
        `INSERT INTO billing_plans (user_id, monthly_fee_cents, percent_bp, effective_month) VALUES (${a.id}, 100, 10001, '2026-11-01')`,
        `INSERT INTO billing_plans (user_id, monthly_fee_cents, percent_bp, effective_month) VALUES (${a.id}, -1, 100, '2026-11-01')`,
        `INSERT INTO billing_plans (user_id, monthly_fee_cents, percent_bp, effective_month) VALUES (${a.id}, 100, 100, '2026-11-15')`,
        `INSERT INTO spend_ledger (owner_id, advertiser_id, hour_start, spend) VALUES (${a.id}, '9001', now(), -1)`,
        `INSERT INTO spend_ledger (owner_id, advertiser_id, hour_start, currency, spend) VALUES (${a.id}, '9001', now(), 'real', 1)`,
        "INSERT INTO billing_rates (currency, brl_per_unit, source) VALUES ('BRL', 1, 'manual')",
        "INSERT INTO billing_rates (currency, brl_per_unit, source) VALUES ('USD', 0, 'manual')",
        "INSERT INTO billing_rates (currency, brl_per_unit, source) VALUES ('USD', 5, 'outra')",
        `INSERT INTO billing_invoices (user_id, amount_cents, period_from, period_to, due_date) VALUES (${a.id}, 0, '2026-10-01', '2026-10-01', '2026-11-05')`,
        `INSERT INTO billing_invoices (user_id, amount_cents, period_from, period_to, due_date) VALUES (${a.id}, 5000, '2026-11-01', '2026-10-01', '2026-11-05')`,
        `INSERT INTO billing_invoices (user_id, amount_cents, period_from, period_to, due_date) VALUES (${a.id}, 5000, '2026-10-15', '2026-10-01', '2026-11-05')`,
        `INSERT INTO billing_locks (owner_id, kind, value, debt_cents) VALUES (${a.id}, 'outro', '1', 0)`,
        `INSERT INTO billing_locks (owner_id, kind, value, debt_cents) VALUES (${a.id}, 'bc', 'abc', 0)`,
      ];
      for (const sql of bad) await assert.rejects(() => run(ctx.db, sql), sql);
    });

    it('o extrato mostra meses, pagamentos e saldo; o admin vê o de qualquer pessoa', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '10', '10');
      await seed(a, '9001', '2026-11-10T12:00:00Z', 100);
      const detail = (await admin.get(`/api/admin/billing/users/${a.id}`)).json;
      assert.equal(detail.user.name, 'Pessoa A');
      assert.deepEqual([detail.months[0].totalCents, detail.chargedCents, detail.balanceCents], [2000, 2000, 2000]);
    });

    it('o livro do gasto não deixa excluir a pessoa que tem histórico (anti-fuga)', async () => {
      await reset();
      const a = await person('Pessoa A');
      await seed(a, '9001', '2026-11-10T12:00:00Z', 100);
      await assert.rejects(() => run(ctx.db, 'DELETE FROM users WHERE id = $1', [a.id]));
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM spend_ledger')).c, 1);
    });
  });

  describe('remover a BC não apaga o gasto e, com débito, bloqueia a BC', () => {
    it('o gasto continua cobrado depois de remover a BC, e a última coleta antes de remover entra no livro', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '0', '10');
      const bc = (await connect(a, '111')).json.businessCenter;
      fake.state.hourly = { 9001: { '2026-11-25': { 10: m(100) } } };
      await ctx.hourly.collectAll();
      assert.equal((await mine(a)).months[0].spendCents, 10000);
      fake.state.hourly = { 9001: { '2026-11-25': { 10: m(100), 11: m(50) } } }; // chegou mais gasto antes da próxima coleta
      assert.equal((await a.client.delete(`/api/tiktok/business-centers/${bc.id}`)).status, 204);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_business_centers')).c, 0);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_hourly_spend')).c, 0, 'o gasto por hora da tela some com a conexão');
      const res = await mine(a);
      assert.equal(res.months[0].spendCents, 15000, 'mas o livro guardou tudo, inclusive a última coleta');
      assert.equal(res.months[0].totalCents, 1500);
    });

    it('removida COM débito: bloqueia a BC e as contas; outra pessoa não consegue conectar a mesma BC nem uma BC com as mesmas contas', async () => {
      await reset();
      const [a, b] = [await person('Devedora'), await person('Outra')];
      await plan(a, '50', '10');
      const bc = (await connect(a, '111')).json.businessCenter;
      assert.equal((await a.client.delete(`/api/tiktok/business-centers/${bc.id}`)).status, 204);
      assert.deepEqual((await all(ctx.db, 'SELECT kind, value FROM billing_locks WHERE released_at IS NULL ORDER BY kind, value')).map((l) => `${l.kind}:${l.value}`), ['advertiser:9001', 'advertiser:9002', 'bc:111']);
      assert.equal((await overviewRow(a)).locks, 3);

      const sameBc = await connect(b, '111');
      assert.equal(sameBc.status, 409);
      assert.equal(sameBc.json.error.code, 'billing_locked');
      assert.doesNotMatch(sameBc.text, /Devedora|@example\.com/, 'não revela de quem é a dívida');
      const sameAccount = await connect(b, '222'); // BC diferente, mas com a conta 9001
      assert.equal(sameAccount.status, 409);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_business_centers')).c, 0, 'nada foi gravado');
      assert.equal((await connect(b, '333')).status, 201, 'uma BC sem relação conecta normalmente');
    });

    it('pagar a dívida libera o bloqueio sozinho: a outra pessoa conecta e o bloqueio fica "paid"', async () => {
      await reset();
      const [a, b] = [await person('Pessoa A'), await person('Pessoa B')];
      await plan(a, '50', '0');
      const bc = (await connect(a, '111')).json.businessCenter;
      await a.client.delete(`/api/tiktok/business-centers/${bc.id}`);
      assert.equal((await connect(b, '111')).status, 409);
      const partial = await admin.post(`/api/admin/billing/users/${a.id}/payments`, { amount: '10' });
      assert.equal(partial.status, 201);
      assert.equal((await connect(b, '111')).status, 409, 'pagamento parcial não libera');
      await admin.post(`/api/admin/billing/users/${a.id}/payments`, { amount: '40' });
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_locks WHERE released_at IS NULL')).c, 0);
      assert.deepEqual([...new Set((await all(ctx.db, 'SELECT release_reason FROM billing_locks')).map((l) => l.release_reason))], ['paid']);
      assert.equal((await connect(b, '111')).status, 201);
    });

    it('a própria pessoa pode reconectar a mesma BC (o bloqueio cai) e continua devendo', async () => {
      await reset();
      const a = await person('Pessoa A');
      await plan(a, '50', '0');
      const bc = (await connect(a, '111')).json.businessCenter;
      await a.client.delete(`/api/tiktok/business-centers/${bc.id}`);
      assert.equal((await connect(a, '111')).status, 201);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_locks WHERE released_at IS NULL')).c, 0);
      assert.deepEqual([...new Set((await all(ctx.db, 'SELECT release_reason FROM billing_locks')).map((l) => l.release_reason))], ['owner_reconnected']);
      assert.equal((await mine(a)).debtCents, 5000);
    });

    it('removida SEM débito (plano pago, ou sem plano): nenhum bloqueio', async () => {
      await reset();
      const [paid, free] = [await person('Paga'), await person('Livre')];
      await plan(paid, '50', '0');
      await admin.post(`/api/admin/billing/users/${paid.id}/payments`, { amount: '50' });
      const bc1 = (await connect(paid, '111')).json.businessCenter;
      assert.equal((await paid.client.delete(`/api/tiktok/business-centers/${bc1.id}`)).status, 204);
      const bc2 = (await connect(free, '333')).json.businessCenter;
      assert.equal((await free.client.delete(`/api/tiktok/business-centers/${bc2.id}`)).status, 204);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_locks')).c, 0);
      assert.equal((await connect(free, '111')).status, 201, 'e a mesma BC fica livre para qualquer pessoa');
    });

    it('o admin pode liberar um bloqueio à mão (só uma vez); id inexistente é 404', async () => {
      await reset();
      const [a, b] = [await person('Pessoa A'), await person('Pessoa B')];
      await plan(a, '50', '0');
      const bc = (await connect(a, '111')).json.businessCenter;
      await a.client.delete(`/api/tiktok/business-centers/${bc.id}`);
      const locks = (await admin.get('/api/admin/billing/locks')).json.locks;
      assert.equal(locks.length, 3);
      assert.deepEqual([locks[0].ownerName, locks[0].debtCentsAtLock], ['Pessoa A', 5000]);
      for (const lock of locks) assert.equal((await admin.post(`/api/admin/billing/locks/${lock.id}/release`)).status, 200);
      assert.equal((await admin.post(`/api/admin/billing/locks/${locks[0].id}/release`)).status, 409);
      assert.equal((await admin.post('/api/admin/billing/locks/999999/release')).status, 404);
      assert.equal((await connect(b, '111')).status, 201);
      assert.equal((await one(ctx.db, "SELECT COUNT(*)::int c FROM admin_audit_log WHERE action = 'billing_lock_release'")).c, 3);
    });

    it('administrador removendo a BC de uma pessoa (supervisão) bloqueia em nome da DONA da conexão', async () => {
      await reset();
      const [a, b] = [await person('Dona'), await person('Outra')];
      await plan(a, '50', '0');
      const bc = (await connect(a, '111')).json.businessCenter;
      assert.equal((await admin.delete(`/api/tiktok/business-centers/${bc.id}`)).status, 204);
      assert.equal((await one(ctx.db, 'SELECT owner_id FROM billing_locks LIMIT 1')).owner_id, a.id);
      assert.equal((await connect(b, '111')).status, 409);
    });
  });

  describe('regras do serviço (sem banco)', () => {
    const stubRepo = (extra = {}) => ({ listPlans: async () => [], listStatements: async () => [], listPayments: async () => [], listRates: async () => [], listInvoices: async () => [], spendByMonth: async () => [], ...extra });

    it('se não der para gravar o bloqueio, o erro sobe (a remoção da BC não pode acontecer)', async () => {
      const service = createBillingService({
        repo: stubRepo({ listPlans: async () => [{ effectiveMonth: '2026-11-01', monthlyFeeCents: 5000, percentBp: 0 }], createLocks: async () => { throw new Error('banco fora do ar'); } }),
        users: {},
        now: () => new Date('2026-11-25T00:00:00Z'),
      });
      await assert.rejects(() => service.onRemoving(1, { bcIds: ['1'], advertiserIds: ['2'] }), /banco fora do ar/);
    });

    it('sem débito não cria bloqueio nem chama o banco', async () => {
      const service = createBillingService({ repo: stubRepo({ createLocks: async () => { throw new Error('não devia chamar'); } }), users: {}, now: () => new Date('2026-11-25T00:00:00Z') });
      assert.deepEqual(await service.onRemoving(1, { bcIds: ['1'], advertiserIds: ['2'] }), { locked: 0, debtCents: 0 });
    });

    it('sem nada bloqueado, conectar passa direto', async () => {
      const service = createBillingService({ repo: stubRepo({ findActiveMatching: async () => [] }), users: {}, now: () => new Date('2026-11-25T00:00:00Z') });
      await service.assertConnectable(5, { bcIds: ['1', null], advertiserIds: [] });
    });
  });

  describe('limites', () => {
    it('as alterações do admin têm limite por hora', async () => {
      const limited = await startTestServer({ limits: { ...LIMITS, billingAdminWrite: 2 }, isolated: true });
      try {
        const boss = await loginAdmin(limited);
        const a = await createUser(limited, { approve: true });
        await run(limited.db, 'DELETE FROM billing_plans WHERE user_id = $1', [a.id]);
        const statuses = [];
        for (let i = 0; i < 3; i += 1) statuses.push((await boss.put(`/api/admin/billing/users/${a.id}/plan`, { monthlyFee: String(i), percent: '1' })).status);
        assert.deepEqual(statuses, [200, 200, 429]);
      } finally {
        await limited.stop();
      }
    });
  });
});
