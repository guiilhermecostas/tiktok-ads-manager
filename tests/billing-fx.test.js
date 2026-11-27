import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadFxConfig } from '../src/config.js';
import { createFxService } from '../src/modules/billing/fx.service.js';
import { createBillingRepository } from '../src/modules/billing/billing.repository.js';
import { all, createUser, loginAdmin, one, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, billingRead: 10000, billingAdminRead: 10000, billingAdminWrite: 10000, billingFxRefresh: 10000 };
const silent = { info() {}, warn() {}, error() {} };

/** Fonte de cotações simulada no formato da API (Frankfurter v2): uma lista de { date, base, quote, rate } com "1 BRL = X moeda". */
const source = (perBrl, { ok = true, status = 200, raw = null } = {}) => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url: String(url), options });
    if (!ok) return { ok: false, status, text: async () => '' };
    const quotes = new URL(url).searchParams.get('quotes').split(',');
    const body = raw ?? JSON.stringify(quotes.filter((q) => q in perBrl).map((quote) => ({ date: '2026-11-26', base: 'BRL', quote, rate: perBrl[quote] })));
    return { ok: true, status: 200, text: async () => body };
  };
  return { fetchFn, calls };
};

describe('Câmbio da cobrança em real', () => {
  let ctx;
  let repo;
  let admin;
  let nowMs = Date.parse('2026-11-26T12:00:00Z');
  before(async () => {
    ctx = await startTestServer({ limits: LIMITS, clock: () => new Date(nowMs) });
    repo = createBillingRepository(ctx.db);
    admin = await loginAdmin(ctx);
  });
  after(() => ctx.stop());

  const reset = async () => {
    for (const table of ['spend_ledger', 'billing_rates']) await run(ctx.db, `DELETE FROM ${table}`);
  };
  const fxWith = (perBrl, options, config = { enabled: true, baseUrl: 'https://api.frankfurter.dev/v2' }) => {
    const src = source(perBrl, options);
    return { fx: createFxService({ repo, config, fetchFn: src.fetchFn, log: silent, now: () => new Date(nowMs) }), calls: src.calls };
  };
  const rates = async () => Object.fromEntries((await repo.listRates()).map((r) => [r.currency, [r.brlPerUnit, r.source]]));

  describe('busca automática', () => {
    it('inverte a cotação da fonte: "1 BRL = 0,2 USD" vira "1 USD = R$ 5,00"', async () => {
      await reset();
      const { fx, calls } = fxWith({ USD: 0.2, EUR: 0.16 });
      const result = await fx.refresh();
      assert.equal(result.updated, 1, 'só o dólar (sem gasto em euro ainda, o EUR não é pedido)');
      assert.deepEqual(await rates(), { USD: [5, 'auto'] });
      assert.match(calls[0].url, /^https:\/\/api\.frankfurter\.dev\/v2\/rates\?base=BRL&quotes=USD$/);
      assert.equal(calls[0].options.redirect, 'error', 'nunca segue redirecionamento para outro endereço');
      assert.ok(calls[0].options.signal, 'tem limite de tempo');
    });

    it('busca as moedas que aparecem no livro de gasto e as que já têm cotação automática', async () => {
      await reset();
      const user = await createUser(ctx, { approve: true });
      await run(ctx.db, "INSERT INTO spend_ledger (owner_id, advertiser_id, hour_start, currency, spend) VALUES ($1, '9001', now(), 'EUR', 10), ($1, '9002', now(), 'UNKNOWN', 5), ($1, '9003', now(), 'BRL', 7)", [user.id]);
      const { fx, calls } = fxWith({ USD: 0.2, EUR: 0.16, GBP: 0.15 });
      await fx.refresh();
      assert.match(calls[0].url, /quotes=EUR,USD$/, 'dólar + euro; nunca BRL nem UNKNOWN');
      assert.deepEqual(Object.keys(await rates()).sort(), ['EUR', 'USD']);
      assert.equal((await rates()).EUR[0], 6.25);
    });

    it('guarda a cotação com precisão (moeda de valor pequeno não perde casas)', async () => {
      await reset();
      const user = await createUser(ctx, { approve: true });
      await run(ctx.db, "INSERT INTO spend_ledger (owner_id, advertiser_id, hour_start, currency, spend) VALUES ($1, '9001', now(), 'COP', 10)", [user.id]);
      const { fx } = fxWith({ USD: 0.185, COP: 700.7 });
      await fx.refresh();
      const stored = (await rates()).COP[0];
      assert.ok(Math.abs(stored - 1 / 700.7) < 1e-9, `COP ${stored}`);
    });

    it('cotação FIXADA pelo admin nunca é sobrescrita pela automática; removê-la devolve a moeda à automática', async () => {
      await reset();
      await repo.setManualRate('USD', 5.9, null);
      const { fx } = fxWith({ USD: 0.2 });
      await fx.refresh();
      assert.deepEqual(await rates(), { USD: [5.9, 'manual'] });
      await repo.deleteRate('USD');
      await fx.refresh();
      assert.deepEqual(await rates(), { USD: [5, 'auto'] });
    });

    it('fonte fora do ar, lenta ou com resposta ruim: as cotações guardadas continuam valendo e o erro fica registrado sem expor endereços', async () => {
      await reset();
      await repo.upsertAutoRates([{ currency: 'USD', brlPerUnit: 5.1 }]);
      const cases = [
        [{ ok: false, status: 503 }, /respondeu 503/],
        [{ raw: '<html>erro</html>' }, /./],
        [{ raw: '{"rates":{"USD":0.2}}' }, /inesperada/],
        [{ raw: '[]' }, /nenhuma moeda pedida/],
        [{ raw: JSON.stringify([{ base: 'BRL', quote: 'USD', rate: 0 }, { base: 'BRL', quote: 'USD', rate: -1 }, { base: 'BRL', quote: 'USD', rate: '0.2' }, { base: 'BRL', quote: 'USD', rate: null }]) }, /nenhuma moeda pedida/],
        [{ raw: JSON.stringify([{ base: 'EUR', quote: 'USD', rate: 0.2 }]) }, /nenhuma moeda pedida/],
        [{ raw: `[${'{"base":"BRL","quote":"USD","rate":0.2},'.repeat(10_000)}{"base":"BRL","quote":"USD","rate":0.2}]` }, /grande demais/],
      ];
      for (const [options, message] of cases) {
        const { fx } = fxWith({ USD: 0.2 }, options);
        await assert.rejects(() => fx.refresh(), message);
        assert.deepEqual(await rates(), { USD: [5.1, 'auto'] }, JSON.stringify(options).slice(0, 60));
        assert.ok(fx.status().lastError && !/https?:\/\//.test(fx.status().lastError), 'o erro guardado não mostra endereço');
        assert.equal(fx.status().lastOkAt, null);
      }
    });

    it('só aceita moedas que foram pedidas e ignora o resto da resposta', async () => {
      await reset();
      const { fx } = fxWith({}, { raw: JSON.stringify([{ base: 'BRL', quote: 'USD', rate: 0.25 }, { base: 'BRL', quote: 'XXX', rate: 0.5 }, { base: 'BRL', quote: 'BRL', rate: 1 }]) });
      await fx.refresh();
      assert.deepEqual(await rates(), { USD: [4, 'auto'] });
    });

    it('guarda o horário da última atualização e limpa o erro quando volta a funcionar', async () => {
      await reset();
      const bad = fxWith({ USD: 0.2 }, { ok: false, status: 500 });
      await assert.rejects(() => bad.fx.refresh());
      assert.ok(bad.fx.status().lastError);
      const good = fxWith({ USD: 0.2 });
      await good.fx.refresh();
      assert.deepEqual(good.fx.status(), { enabled: true, lastOkAt: '2026-11-26T12:00:00.000Z', lastError: null });
    });

    it('pedidos simultâneos compartilham uma única consulta à fonte', async () => {
      await reset();
      const { fx, calls } = fxWith({ USD: 0.2 });
      await Promise.all([fx.refresh(), fx.refresh(), fx.refresh()]);
      assert.equal(calls.length, 1);
      await fx.refresh();
      assert.equal(calls.length, 2, 'depois de terminar, um novo pedido consulta de novo');
    });

    it('desligada: não consulta a internet', async () => {
      await reset();
      const { fx, calls } = fxWith({ USD: 0.2 }, {}, { enabled: false, baseUrl: 'https://api.frankfurter.dev/v2' });
      assert.deepEqual(await fx.refresh(), { updated: 0, requested: 0, missing: [], disabled: true });
      assert.equal(calls.length, 0);
    });
  });

  describe('configuração (só o domínio do câmbio, só https)', () => {
    const withEnv = (env, fn) => {
      const old = { ...process.env };
      Object.assign(process.env, env);
      try { return fn(); } finally { for (const k of Object.keys(env)) { if (k in old) process.env[k] = old[k]; else delete process.env[k]; } }
    };
    it('o padrão é a API pública e a atualização vem ligada', () => {
      withEnv({ BILLING_FX_URL: '', BILLING_FX_AUTO: '' }, () => assert.deepEqual(loadFxConfig(), { enabled: true, baseUrl: 'https://api.frankfurter.dev/v2' }));
      withEnv({ BILLING_FX_AUTO: 'false' }, () => assert.equal(loadFxConfig().enabled, false));
    });
    it('recusa qualquer endereço que não seja https no domínio frankfurter.dev (o servidor não chama endereços quaisquer)', () => {
      for (const bad of ['http://api.frankfurter.dev/v2', 'https://evil.example.com/v2', 'https://api.frankfurter.dev.evil.com/v2', 'https://user:pw@api.frankfurter.dev/v2', 'https://api.frankfurter.dev/v1', 'https://api.frankfurter.dev/v2?x=1', 'https://127.0.0.1/v2', 'ftp://api.frankfurter.dev/v2']) {
        withEnv({ BILLING_FX_URL: bad }, () => assert.throws(() => loadFxConfig(), /BILLING_FX_URL inválida/, bad));
      }
      withEnv({ BILLING_FX_URL: 'https://frankfurter.dev/v2/' }, () => assert.equal(loadFxConfig().baseUrl, 'https://frankfurter.dev/v2'));
    });
  });

  describe('painel do admin', () => {
    it('"Atualizar agora" busca as cotações (com a fonte simulada) e devolve a lista e o estado', async () => {
      await reset();
      const res = await admin.post('/api/admin/billing/rates/refresh', {});
      assert.equal(res.status, 502, 'nos testes não há internet: a fonte falha e as cotações guardadas continuam valendo');
      assert.equal(res.json.error.code, 'fx_unavailable');
      assert.doesNotMatch(res.json.error.message, /https?:\/\//);
      assert.match(res.json.error.message, /As cotações guardadas continuam valendo/);
    });

    it('só o admin (403 para usuário, 401 para visitante), com token CSRF e limite de pedidos', async () => {
      const user = await createUser(ctx, { approve: true });
      assert.equal((await user.client.post('/api/admin/billing/rates/refresh', {})).status, 403);
      assert.equal((await ctx.client().post('/api/admin/billing/rates/refresh', {})).status, 401);
      assert.equal((await admin.post('/api/admin/billing/rates/refresh', {}, { withCsrf: false })).status, 403);
      assert.equal((await user.client.delete('/api/admin/billing/rates/USD')).status, 403);
      assert.equal((await admin.delete('/api/admin/billing/rates/USD', { withCsrf: false })).status, 403);
    });

    it('fixar e remover cotação ficam na auditoria', async () => {
      await reset();
      await run(ctx.db, 'DELETE FROM admin_audit_log');
      await admin.put('/api/admin/billing/rates/USD', { brlPerUnit: '5,25' });
      await admin.delete('/api/admin/billing/rates/USD');
      const actions = (await all(ctx.db, "SELECT action, detail FROM admin_audit_log WHERE action LIKE 'billing_rate%' ORDER BY id")).map((r) => [r.action, r.detail]);
      assert.equal(actions[0][0], 'billing_rate');
      assert.match(actions[0][1], /1 USD = R\$ 5,25/);
      assert.deepEqual(actions[1], ['billing_rate_clear', 'Removeu a cotação de USD (volta para a automática)']);
    });
  });

  describe('conversão na cobrança', () => {
    it('a cobrança do mês usa a cotação vigente e o extrato mostra o gasto por moeda', async () => {
      await reset();
      const user = await createUser(ctx, { approve: true });
      await run(ctx.db, 'DELETE FROM billing_plans WHERE user_id = $1', [user.id]);
      await admin.put(`/api/admin/billing/users/${user.id}/plan`, { monthlyFee: '0', percent: '10' });
      await run(ctx.db, "INSERT INTO spend_ledger (owner_id, advertiser_id, hour_start, currency, spend) VALUES ($1, '9001', '2026-11-10T12:00:00Z', 'USD', 96), ($1, '9002', '2026-11-10T12:00:00Z', 'BRL', 100)", [user.id]);
      await repo.setManualRate('USD', 5.4321, null);
      const month = (await user.client.get('/api/billing/me')).json.months[0];
      assert.equal(month.spendCents, 52148 + 10000, 'US$ 96 × 5,4321 = R$ 521,48, mais R$ 100');
      assert.equal(month.totalCents, 6215, '10% de R$ 621,48 = R$ 62,15 (arredondado)');
      assert.deepEqual(month.breakdown.map((b) => b.currency).sort(), ['BRL', 'USD']);
    });

    it('o fechamento congela o câmbio do momento: mudar a cotação depois NÃO altera o mês fechado', async () => {
      await reset();
      const user = await createUser(ctx, { approve: true });
      await run(ctx.db, 'DELETE FROM billing_plans WHERE user_id = $1', [user.id]);
      await admin.put(`/api/admin/billing/users/${user.id}/plan`, { monthlyFee: '0', percent: '10' });
      await run(ctx.db, "INSERT INTO spend_ledger (owner_id, advertiser_id, hour_start, currency, spend) VALUES ($1, '9001', '2026-11-10T12:00:00Z', 'USD', 100)", [user.id]);
      await repo.setManualRate('USD', 5, null);
      nowMs = Date.parse('2026-12-03T00:00:01Z');
      await ctx.billing.closeDueMonths();
      await repo.setManualRate('USD', 9, null);
      const closed = (await user.client.get('/api/billing/me')).json.months.find((m) => m.closed);
      assert.equal(closed.spendCents, 50000);
      assert.deepEqual(closed.breakdown, [{ currency: 'USD', spend: 100, rate: 5, cents: 50000 }]);
      assert.equal(Number((await one(ctx.db, 'SELECT spend_cents FROM billing_statements WHERE user_id = $1', [user.id])).spend_cents), 50000);
      nowMs = Date.parse('2026-11-26T12:00:00Z');
    });
  });

  describe('nível de gasto (em dólar) usa as cotações para real', () => {
    it('converte real e outras moedas para dólar pela cotação do dólar; sem a cotação do dólar, só o dólar entra', async () => {
      await reset();
      assert.deepEqual(await ctx.billing.toUsd([{ currency: 'USD', spend: 10 }, { currency: 'BRL', spend: 550 }]), { spendCents: 1000, unconverted: [{ currency: 'BRL', spend: 550 }] });
      await repo.setManualRate('USD', 5.5, null);
      await repo.setManualRate('EUR', 6.05, null);
      const out = await ctx.billing.toUsd([{ currency: 'USD', spend: 10 }, { currency: 'BRL', spend: 550 }, { currency: 'EUR', spend: 100 }, { currency: 'ARS', spend: 3 }]);
      assert.equal(out.spendCents, 1000 + 10000 + 11000, '10 + 550/5,5 (=100) + 100×6,05/5,5 (=110)');
      assert.deepEqual(out.unconverted, [{ currency: 'ARS', spend: 3 }]);
    });
  });
});
