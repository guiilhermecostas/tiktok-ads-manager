import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, loginAdmin, one, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000 };
const bcPayload = (over = {}) => ({ name: 'Loja Principal', bcId: '111', accessToken: GOOD_TOKEN, shared: true, ...over });

describe('Integração TikTok: Business Centers', () => {
  let ctx;
  let fake;
  let admin;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn });
    admin = await loginAdmin(ctx);
  });
  after(() => ctx.stop());

  const reset = async () => {
    (await run(ctx.db, 'DELETE FROM tiktok_business_centers'));
    fake.state.calls.length = 0;
    fake.state.validTokens = new Set([GOOD_TOKEN, OTHER_TOKEN]);
    fake.state.failReportFor.clear();
    fake.state.bcs = { 111: ['9001', '9002'] };
  };

  it('exige login e conta aprovada; usuário aprovado pode conectar a própria BC', async () => {
    await reset();
    assert.equal((await ctx.client().get('/api/tiktok/business-centers')).status, 401);
    assert.equal((await ctx.client().post('/api/tiktok/business-centers', bcPayload({ shared: false }))).status, 401);

    const pending = await createUser(ctx);
    const res = await pending.client.get('/api/tiktok/business-centers');
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'account_pending');
    assert.equal((await pending.client.post('/api/tiktok/business-centers', bcPayload({ shared: false }))).status, 403);
    assert.equal((await pending.client.get('/api/tiktok/advertisers')).status, 403);
    assert.equal((await pending.client.get('/api/tiktok/overview')).status, 403);
    assert.equal(fake.state.calls.length, 0, 'pendente não aciona o TikTok');

    const user = await createUser(ctx, { approve: true });
    assert.equal((await user.client.get('/api/tiktok/business-centers')).status, 200);
    assert.equal((await user.client.post('/api/tiktok/business-centers', bcPayload({ shared: false }))).status, 201);
  });

  it('cadastra a BC validando o token, sincroniza contas e NUNCA devolve/guarda o token em texto puro', async () => {
    await reset();
    const res = await admin.post('/api/tiktok/business-centers', bcPayload());
    assert.equal(res.status, 201);
    assert.equal(res.json.businessCenter.bcId, '111');
    assert.equal(res.json.businessCenter.advertiserCount, 2);
    assert.equal(res.json.businessCenter.status, 'active');
    assert.ok(!res.text.includes(GOOD_TOKEN));

    const row = (await one(ctx.db, 'SELECT access_token FROM tiktok_business_centers'));
    assert.match(row.access_token, /^v1\./);
    assert.ok(!row.access_token.includes(GOOD_TOKEN));

    // o token foi enviado ao TikTok no cabeçalho correto
    const call = fake.callsTo('/bc/asset/get/')[0];
    assert.equal(call.token, GOOD_TOKEN);
    assert.equal(call.query.bc_id, '111');

    const list = await admin.get('/api/tiktok/business-centers');
    assert.ok(!list.text.includes(GOOD_TOKEN) && !list.text.includes('access_token') && !list.text.includes('accessToken'));
  });

  it('recusa token inválido sem gravar nada, BC sem permissão e duplicada', async () => {
    await reset();
    const bad = await admin.post('/api/tiktok/business-centers', bcPayload({ accessToken: 'revogado-xxxxxxxxxxxxxxxxx' }));
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'tiktok_token_invalid');
    assert.ok(!bad.text.includes('revogado-xxxxxxxxxxxxxxxxx'));

    const noPermission = await admin.post('/api/tiktok/business-centers', bcPayload({ bcId: '999' }));
    assert.equal(noPermission.status, 502);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*) c FROM tiktok_business_centers')).c, 0);

    assert.equal((await admin.post('/api/tiktok/business-centers', bcPayload())).status, 201);
    const dup = await admin.post('/api/tiktok/business-centers', bcPayload({ name: 'Outra' }));
    assert.equal(dup.status, 409);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*) c FROM tiktok_business_centers')).c, 1);
  });

  it('valida entradas do cadastro e exige CSRF', async () => {
    await reset();
    const bad = [
      bcPayload({ bcId: 'abc' }),
      bcPayload({ bcId: '1 OR 1=1' }),
      bcPayload({ bcId: 111 }),
      bcPayload({ accessToken: 'curto' }),
      bcPayload({ accessToken: 'token com espacos aaaaaaaaaaaa' }),
      bcPayload({ accessToken: 'tókén-acentuado-aaaaaaaaaaaaaa' }),
      bcPayload({ accessToken: { $ne: 1 } }),
      bcPayload({ name: '' }),
      bcPayload({ name: 'x'.repeat(200) }),
    ];
    for (const payload of bad) assert.equal((await admin.post('/api/tiktok/business-centers', payload)).status, 400, JSON.stringify(payload));
    assert.equal((await admin.post('/api/tiktok/business-centers', bcPayload(), { withCsrf: false })).json.error.code, 'bad_csrf');
    assert.equal(fake.state.calls.length, 0);
  });

  it('usuário aprovado consome anunciantes, campanhas e desempenho das BCs cadastradas', async () => {
    await reset();
    await admin.post('/api/tiktok/business-centers', bcPayload());
    const { client } = await createUser(ctx, { approve: true });

    const advertisers = await client.get('/api/tiktok/advertisers');
    assert.equal(advertisers.status, 200);
    assert.deepEqual(advertisers.json.advertisers.map((a) => [a.id, a.name, a.currency, a.businessCenterName]), [
      ['9001', 'Conta 9001', 'BRL', 'Loja Principal'],
      ['9002', 'Conta 9002', 'USD', 'Loja Principal'],
    ]);
    assert.ok(!advertisers.text.includes(GOOD_TOKEN));

    const campaigns = await client.get('/api/tiktok/advertisers/9001/campaigns');
    assert.equal(campaigns.status, 200);
    assert.equal(campaigns.json.total, 2);
    assert.deepEqual({ ...campaigns.json.campaigns[0], createdAt: undefined }, {
      id: '5001', name: 'Black <b>Friday</b>', objective: 'WEB_CONVERSIONS', status: 'ENABLE', budget: 150, budgetMode: 'BUDGET_MODE_DAY', createdAt: undefined,
    });

    const report = await client.get('/api/tiktok/advertisers/9001/report?days=7');
    assert.equal(report.status, 200);
    assert.deepEqual(report.json.days.map((d) => d.date), ['2026-11-18', '2026-11-19'], 'ordenado por data');
    assert.equal(report.json.totals.spend, 15);
    assert.equal(report.json.totals.impressions, 1500);
    assert.equal(report.json.totals.clicks, 60);
    assert.equal(report.json.totals.conversions, 3);
    assert.equal(report.json.totals.ctr, 4);
    assert.equal(report.json.totals.cpc, 0.25);

    const reportCall = fake.callsTo('/report/integrated/get/')[0];
    assert.match(reportCall.query.start_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(reportCall.token, GOOD_TOKEN);
  });

  it('valida parâmetros e não acessa contas de anúncio fora das BCs cadastradas (IDOR)', async () => {
    await reset();
    await admin.post('/api/tiktok/business-centers', bcPayload());
    const { client } = await createUser(ctx, { approve: true });
    fake.state.calls.length = 0;
    assert.equal((await client.get('/api/tiktok/advertisers/777/campaigns')).status, 404);
    assert.equal((await client.get('/api/tiktok/advertisers/777/report?days=7')).status, 404);
    assert.equal((await client.get('/api/tiktok/advertisers/abc/report?days=7')).status, 400);
    assert.equal((await client.get('/api/tiktok/advertisers/9001;DROP/report?days=7')).status, 400);
    assert.equal((await client.get('/api/tiktok/advertisers/9001/report?days=99')).status, 400);
    assert.equal((await client.get('/api/tiktok/advertisers/9001/report?days=abc')).status, 400);
    assert.equal((await client.get('/api/tiktok/overview?days=1')).status, 400);
    assert.equal(fake.state.calls.length, 0, 'nada foi repassado ao TikTok');
  });

  it('usa cache (não repete chamadas idênticas ao TikTok)', async () => {
    await reset();
    await admin.post('/api/tiktok/business-centers', bcPayload());
    const { client } = await createUser(ctx, { approve: true });
    fake.state.calls.length = 0;
    await client.get('/api/tiktok/advertisers/9001/report?days=14');
    await client.get('/api/tiktok/advertisers/9001/report?days=14');
    await client.get('/api/tiktok/advertisers/9001/campaigns');
    await client.get('/api/tiktok/advertisers/9001/campaigns');
    assert.equal(fake.callsTo('/report/integrated/get/').length, 1);
    assert.equal(fake.callsTo('/campaign/get/').length, 1);
  });

  it('token revogado: marca a BC com erro, bloqueia o uso e volta ao normal ao trocar o token', async () => {
    await reset();
    const created = (await admin.post('/api/tiktok/business-centers', bcPayload())).json.businessCenter;
    const { client } = await createUser(ctx, { approve: true });

    fake.state.validTokens.delete(GOOD_TOKEN); // TikTok revoga
    const failing = await client.get('/api/tiktok/advertisers/9001/campaigns');
    assert.equal(failing.status, 409);
    assert.equal(failing.json.error.code, 'tiktok_reauth');

    const list = (await admin.get('/api/tiktok/business-centers')).json.businessCenters;
    assert.equal(list[0].status, 'error');
    assert.match(list[0].lastError, /token/i);
    // BC com erro não serve dados (e o usuário recebe 404, não um erro vindo do TikTok)
    assert.equal((await client.get('/api/tiktok/advertisers/9001/report?days=7')).status, 404);

    const rotated = await admin.patch(`/api/tiktok/business-centers/${created.id}`, { accessToken: OTHER_TOKEN });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.json.businessCenter.status, 'active');
    assert.equal((await client.get('/api/tiktok/advertisers/9001/report?days=7')).status, 200);
    assert.equal(fake.callsTo('/report/integrated/get/').at(-1).token, OTHER_TOKEN);
    assert.ok(!rotated.text.includes(OTHER_TOKEN));
  });

  it('edição: renomeia, valida o novo token e rejeita pedido vazio', async () => {
    await reset();
    const { id } = (await admin.post('/api/tiktok/business-centers', bcPayload())).json.businessCenter;
    assert.equal((await admin.patch(`/api/tiktok/business-centers/${id}`, { name: 'Renomeada' })).json.businessCenter.name, 'Renomeada');
    assert.equal((await admin.patch(`/api/tiktok/business-centers/${id}`, { name: 'Ok', accessToken: 'invalido-xxxxxxxxxxxxxxxxx' })).status, 400);
    assert.equal((await one(ctx.db, 'SELECT name FROM tiktok_business_centers')).name, 'Renomeada', 'falha não altera nada');
    assert.equal((await admin.patch(`/api/tiktok/business-centers/${id}`, {})).status, 400);
    assert.equal((await admin.patch(`/api/tiktok/business-centers/${id}`, { accessToken: '' , name: undefined })).status, 400);
    assert.equal((await admin.patch('/api/tiktok/business-centers/9999', { name: 'Nada' })).status, 404);
    assert.equal((await admin.patch('/api/tiktok/business-centers/abc', { name: 'Nada' })).status, 400);
  });

  it('sincroniza novas contas e remove a BC com todas as suas contas', async () => {
    await reset();
    const { id } = (await admin.post('/api/tiktok/business-centers', bcPayload())).json.businessCenter;
    fake.state.bcs[111] = ['9001', '9002', '9003'];
    const synced = await admin.post(`/api/tiktok/business-centers/${id}/sync`);
    assert.equal(synced.json.businessCenter.advertiserCount, 3);

    assert.equal((await admin.delete(`/api/tiktok/business-centers/${id}`)).status, 204);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*) c FROM tiktok_advertisers')).c, 0);
    const { client } = await createUser(ctx, { approve: true });
    assert.equal((await client.get('/api/tiktok/advertisers')).json.advertisers.length, 0);
    assert.equal((await client.get('/api/tiktok/advertisers/9001/report?days=7')).status, 404);
    assert.equal((await admin.delete(`/api/tiktok/business-centers/${id}`)).status, 404);
  });

  it('visão geral agrupa por moeda e conta falhas sem derrubar o restante', async () => {
    await reset();
    await admin.post('/api/tiktok/business-centers', bcPayload());
    const { client } = await createUser(ctx, { approve: true });

    const ok = await client.get('/api/tiktok/overview?days=7');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.totalAdvertisers, 2);
    assert.equal(ok.json.failed, 0);
    assert.deepEqual(ok.json.groups.map((g) => [g.currency, g.advertisers, g.totals.spend]).sort(), [['BRL', 1, 15], ['USD', 1, 15]]);

    // outro período (sem cache) com uma conta falhando
    fake.state.failReportFor.add('9002');
    const partial = await client.get('/api/tiktok/overview?days=14');
    assert.equal(partial.status, 200);
    assert.equal(partial.json.failed, 1);
    assert.deepEqual(partial.json.groups.map((g) => g.currency), ['BRL']);
  });

  it('visão geral vazia sem BCs cadastradas', async () => {
    await reset();
    const { client } = await createUser(ctx, { approve: true });
    const res = await client.get('/api/tiktok/overview?days=30');
    assert.deepEqual({ total: res.json.totalAdvertisers, groups: res.json.groups.length }, { total: 0, groups: 0 });
  });

  it('cadastros simultâneos da mesma BC: um vence (201) e o outro recebe 409, sem erro 500', async () => {
    await reset();
    const [a, b] = await Promise.all([
      admin.post('/api/tiktok/business-centers', bcPayload()),
      admin.post('/api/tiktok/business-centers', bcPayload({ name: 'Concorrente' })),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*) c FROM tiktok_business_centers')).c, 1);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*) c FROM tiktok_advertisers')).c, 2);
  });

  it('token ilegível (chave trocada/dado corrompido): 409 claro, BC marcada com erro e sem 500', async () => {
    await reset();
    await admin.post('/api/tiktok/business-centers', bcPayload());
    const { client } = await createUser(ctx, { approve: true });
    (await run(ctx.db, "UPDATE tiktok_business_centers SET access_token = 'v1.corrompido.corrompido.corrompido'"));
    const res = await client.get('/api/tiktok/advertisers/9001/campaigns');
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'tiktok_token_unreadable');
    assert.equal((await admin.get('/api/tiktok/business-centers')).json.businessCenters[0].status, 'error');
  });

  it('o front recebe texto do TikTok como dado (nomes com HTML não são interpretados no servidor)', async () => {
    await reset();
    await admin.post('/api/tiktok/business-centers', bcPayload());
    const { client } = await createUser(ctx, { approve: true });
    const res = await client.get('/api/tiktok/advertisers/9001/campaigns');
    assert.equal(res.headers.get('content-type').startsWith('application/json'), true);
    assert.equal(res.json.campaigns[0].name, 'Black <b>Friday</b>');
  });
});

describe('Integração TikTok: segurança e disponibilidade', () => {
  it('sem TOKEN_ENCRYPTION_KEY o cadastro fica desligado e nada é gravado', async () => {
    const fake = createFakeTiktok();
    const ctx = await startTestServer({ limits: LIMITS, fetchFn: fake.fetchFn });
    try {
      const admin = await loginAdmin(ctx);
      const list = await admin.get('/api/tiktok/business-centers');
      assert.equal(list.json.configured, false);
      const res = await admin.post('/api/tiktok/business-centers', bcPayload());
      assert.equal(res.status, 503);
      assert.equal(res.json.error.code, 'tiktok_not_configured');
      assert.equal(fake.state.calls.length, 0);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*) c FROM tiktok_business_centers')).c, 0);
    } finally {
      await ctx.stop();
    }
  });

  it('falhas de rede/resposta do TikTok viram 502 sem vazar detalhes internos', async () => {
    const down = async () => { throw new Error('ECONNREFUSED secret-internal-detail'); };
    const ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: down });
    try {
      const admin = await loginAdmin(ctx);
      const res = await admin.post('/api/tiktok/business-centers', bcPayload());
      assert.equal(res.status, 502);
      assert.equal(res.json.error.code, 'tiktok_unreachable');
      assert.ok(!res.text.includes('secret-internal-detail') && !res.text.includes(GOOD_TOKEN));
    } finally {
      await ctx.stop();
    }

    const garbage = async () => new Response('<html>oops</html>', { status: 200 });
    const ctx2 = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: garbage });
    try {
      const admin = await loginAdmin(ctx2);
      assert.equal((await admin.post('/api/tiktok/business-centers', bcPayload())).json.error.code, 'tiktok_bad_response');
    } finally {
      await ctx2.stop();
    }
  });

  it('limita operações de escrita do admin (429)', async () => {
    const fake = createFakeTiktok();
    const ctx = await startTestServer({ limits: { ...LIMITS, tiktokWrite: 2 }, config: tiktokTestConfig(), fetchFn: fake.fetchFn });
    try {
      const admin = await loginAdmin(ctx);
      assert.equal((await admin.post('/api/tiktok/business-centers', bcPayload())).status, 201);
      assert.equal((await admin.post('/api/tiktok/business-centers', bcPayload())).status, 409);
      const limited = await admin.post('/api/tiktok/business-centers', bcPayload());
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
    } finally {
      await ctx.stop();
    }
  });

  it('o token é gravado cifrado com chave própria e não é legível com outra chave', async () => {
    const { decrypt } = await import('../src/lib/crypto.js');
    const { randomBytes } = await import('node:crypto');
    const fake = createFakeTiktok();
    const config = tiktokTestConfig();
    const ctx = await startTestServer({ limits: LIMITS, config, fetchFn: fake.fetchFn });
    try {
      const admin = await loginAdmin(ctx);
      await admin.post('/api/tiktok/business-centers', bcPayload());
      const { access_token: stored } = (await one(ctx.db, 'SELECT access_token FROM tiktok_business_centers'));
      assert.equal(decrypt(stored, config.tiktok.encryptionKey), GOOD_TOKEN);
      assert.throws(() => decrypt(stored, randomBytes(32)));
    } finally {
      await ctx.stop();
    }
  });
});
