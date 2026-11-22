import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { OAUTH_APP_ID, OAUTH_APP_SECRET, OAUTH_REDIRECT_URI, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, loginAdmin, one, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, tiktokCallback: 1000, campaignPublish: 1000 };

/** Lê o state do link gerado (é o que o TikTok devolve na volta). */
const stateOf = (url) => new URL(url).searchParams.get('state');
let codeSeq = 0;
const newCode = () => `code-${++codeSeq}-${'x'.repeat(12)}`;

describe('Conexão por link de autorização (OAuth)', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn });
  });
  after(() => ctx.stop());

  const reset = async () => {
    await run(ctx.db, 'DELETE FROM tiktok_oauth_attempts');
    await run(ctx.db, 'DELETE FROM tiktok_business_centers');
    fake.state.calls.length = 0;
    fake.state.authCodes.clear();
    fake.state.authorized.clear();
    fake.state.exchangeDelayMs = 0;
  };

  /** Usuário gera o link e o TikTok devolve o navegador ao callback (num cliente SEM sessão, como outra aba/perfil). */
  async function authorize(user, { name = 'Minha loja', advertisers, code = newCode(), via } = {}) {
    const start = await user.client.post('/api/tiktok/connect', { name });
    assert.equal(start.status, 201, start.text);
    fake.grantAuthCode(code, advertisers ? { advertisers } : {});
    const anon = ctx.client();
    const back = await anon.get(`/api/tiktok/callback?auth_code=${code}&state=${encodeURIComponent(stateOf(start.json.url))}${via ?? ''}`);
    return { start: start.json, back, code };
  }

  it('informa se o link está disponível (URI de retorno só para admin)', async () => {
    const user = await createUser(ctx, { approve: true });
    const admin = await loginAdmin(ctx);
    const u = (await user.client.get('/api/tiktok/business-centers')).json.oauth;
    const a = (await admin.get('/api/tiktok/business-centers')).json.oauth;
    assert.deepEqual(u, { available: true });
    assert.deepEqual(a, { available: true, redirectUri: OAUTH_REDIRECT_URI });
  });

  it('gera o link do TikTok com app, state único e URI de retorno', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    const first = (await user.client.post('/api/tiktok/connect', { name: 'Loja A' })).json;
    const second = (await user.client.post('/api/tiktok/connect', { name: 'Loja B' })).json;
    const url = new URL(first.url);
    assert.equal(url.origin + url.pathname, 'https://business-api.tiktok.com/portal/auth');
    assert.equal(url.searchParams.get('app_id'), OAUTH_APP_ID);
    assert.equal(url.searchParams.get('redirect_uri'), OAUTH_REDIRECT_URI);
    assert.ok(stateOf(first.url).length >= 40, 'state com entropia');
    assert.notEqual(stateOf(first.url), stateOf(second.url));
    assert.match(first.attemptId, /^[a-f0-9]{32}$/);
    assert.ok(new Date(first.expiresAt).getTime() > Date.now() + 14 * 60 * 1000);
    assert.ok(!first.url.includes(OAUTH_APP_SECRET), 'o segredo do app nunca vai no link');
    // No banco só o hash do state existe.
    const rows = await all(ctx.db, 'SELECT state_hash FROM tiktok_oauth_attempts');
    assert.ok(rows.every((r) => /^[a-f0-9]{64}$/.test(r.state_hash) && r.state_hash !== stateOf(first.url)));
  });

  it('exige sessão aprovada e valida o nome', async () => {
    await reset();
    assert.equal((await ctx.client().post('/api/tiktok/connect', { name: 'X' })).status, 401);
    const pending = await createUser(ctx, { approve: false });
    assert.equal((await pending.client.post('/api/tiktok/connect', { name: 'X' })).status, 403);
    const user = await createUser(ctx, { approve: true });
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'a'.repeat(81) }, { name: 123 }, { name: ['x'] }]) {
      assert.equal((await user.client.post('/api/tiktok/connect', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await user.client.post('/api/tiktok/connect', { name: 'ok' }, { withCsrf: false })).status, 403, 'CSRF');
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_oauth_attempts')).c, 0);
  });

  it('limita os links em aberto por usuário (429)', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    for (let i = 0; i < 5; i++) assert.equal((await user.client.post('/api/tiktok/connect', { name: `L${i}` })).status, 201);
    const res = await user.client.post('/api/tiktok/connect', { name: 'L6' });
    assert.equal(res.status, 429);
    assert.equal(res.json.error.code, 'too_many_pending');
    const other = await createUser(ctx, { approve: true });
    assert.equal((await other.client.post('/api/tiktok/connect', { name: 'ok' })).status, 201, 'o limite é por usuário');
  });

  it('fluxo completo: callback sem sessão cria a conexão, token criptografado, e a tela acompanha', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    const { start, back, code } = await authorize(user, { name: 'Loja Bia' });

    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), '/tiktok/connected?status=connected');
    assert.equal(back.headers.get('cache-control'), 'no-store');
    assert.ok(!back.text.includes(code));

    const exchange = fake.callsTo('/oauth2/access_token/');
    assert.equal(exchange.length, 1);
    assert.deepEqual(exchange[0].body, { app_id: OAUTH_APP_ID, secret: OAUTH_APP_SECRET, auth_code: code });

    const stored = await one(ctx.db, 'SELECT * FROM tiktok_business_centers');
    assert.equal(stored.auth_type, 'oauth');
    assert.equal(stored.bc_id, null);
    assert.equal(stored.name, 'Loja Bia');
    assert.equal(stored.shared, false);
    assert.match(stored.access_token, /^v1\./, 'criptografado em repouso');
    assert.equal((await all(ctx.db, 'SELECT advertiser_id FROM tiktok_advertisers ORDER BY advertiser_id')).map((r) => r.advertiser_id).join(), '9001,9002');

    const status = await user.client.get(`/api/tiktok/connect/${start.attemptId}`);
    assert.equal(status.status, 200);
    assert.equal(status.json.status, 'connected');
    assert.equal(status.json.connection.name, 'Loja Bia');
    assert.equal(status.json.connection.authType, 'oauth');
    assert.equal(status.json.connection.advertiserCount, 2);
    assert.ok(!status.text.includes('access_token') && !status.text.includes('oauth-token'), 'token nunca volta ao navegador');

    // A conexão já alimenta o resto do sistema.
    assert.deepEqual((await user.client.get('/api/tiktok/advertisers')).json.advertisers.map((a) => a.id), ['9001', '9002']);
    assert.equal((await user.client.get('/api/tiktok/advertisers/9001/report?days=7')).status, 200);
    const reportCall = fake.callsTo('/report/integrated/get/').at(-1);
    assert.match(reportCall.token, /^oauth-token-/, 'usa o token obtido pela autorização');
  });

  it('enquanto o usuário não autoriza, a tela vê "pending"; cancelar invalida o link', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    const start = (await user.client.post('/api/tiktok/connect', { name: 'Loja' })).json;
    assert.equal((await user.client.get(`/api/tiktok/connect/${start.attemptId}`)).json.status, 'pending');

    assert.equal((await user.client.delete(`/api/tiktok/connect/${start.attemptId}`)).status, 204);
    assert.equal((await user.client.get(`/api/tiktok/connect/${start.attemptId}`)).status, 404);

    fake.grantAuthCode('code-cancelado-xxxxxxxx');
    const back = await ctx.client().get(`/api/tiktok/callback?auth_code=code-cancelado-xxxxxxxx&state=${encodeURIComponent(stateOf(start.url))}`);
    assert.equal(back.headers.get('location'), '/tiktok/connected?status=expired');
    assert.equal(fake.callsTo('/oauth2/access_token/').length, 0, 'link cancelado nem chega a trocar o código');
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_business_centers')).c, 0);
  });

  it('o state é de uso único: repetir o callback não cria nada nem troca o código de novo', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    const { start, code } = await authorize(user);
    const again = await ctx.client().get(`/api/tiktok/callback?auth_code=${code}&state=${encodeURIComponent(stateOf(start.url))}`);
    assert.equal(again.headers.get('location'), '/tiktok/connected?status=expired');
    assert.equal(fake.callsTo('/oauth2/access_token/').length, 1);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_business_centers')).c, 1);
  });

  it('state expirado, desconhecido ou malformado não conecta nada', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    const start = (await user.client.post('/api/tiktok/connect', { name: 'Loja' })).json;
    await run(ctx.db, "UPDATE tiktok_oauth_attempts SET expires_at = now() - interval '1 minute'");
    fake.grantAuthCode('code-expirado-xxxxxxxx');
    const anon = ctx.client();
    const cases = [
      `auth_code=code-expirado-xxxxxxxx&state=${encodeURIComponent(stateOf(start.url))}`,
      'auth_code=code-expirado-xxxxxxxx&state=abcdefghijklmnopqrstuvwxyz0123456789',
      'auth_code=code-expirado-xxxxxxxx&state=curto',
      'auth_code=code-expirado-xxxxxxxx',
      `auth_code=code-expirado-xxxxxxxx&state=${'a'.repeat(500)}`,
      `auth_code=code-expirado-xxxxxxxx&state=${encodeURIComponent("' OR 1=1 --")}`,
      'auth_code=x&state=a&state=b', // parâmetro repetido
      '',
    ];
    for (const q of cases) {
      const res = await anon.get(`/api/tiktok/callback?${q}`);
      assert.equal(res.status, 302, q);
      assert.equal(res.headers.get('location'), '/tiktok/connected?status=expired', q);
    }
    assert.equal(fake.callsTo('/oauth2/access_token/').length, 0);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_business_centers')).c, 0);
  });

  it('o dono vê "expired" ao consultar uma tentativa vencida', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    const start = (await user.client.post('/api/tiktok/connect', { name: 'Loja' })).json;
    await run(ctx.db, "UPDATE tiktok_oauth_attempts SET expires_at = now() - interval '1 minute'");
    assert.equal((await user.client.get(`/api/tiktok/connect/${start.attemptId}`)).json.status, 'expired');
  });

  it('usuário negou a autorização no TikTok', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    const start = (await user.client.post('/api/tiktok/connect', { name: 'Loja' })).json;
    const back = await ctx.client().get(`/api/tiktok/callback?error=access_denied&state=${encodeURIComponent(stateOf(start.url))}`);
    assert.equal(back.headers.get('location'), '/tiktok/connected?status=denied');
    const status = (await user.client.get(`/api/tiktok/connect/${start.attemptId}`)).json;
    assert.equal(status.status, 'denied');
    assert.match(status.message, /cancelada ou negada/);
    assert.equal(fake.callsTo('/oauth2/access_token/').length, 0);
  });

  it('código recusado pelo TikTok: erro com mensagem segura (sem eco de código ou detalhes)', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    const start = (await user.client.post('/api/tiktok/connect', { name: 'Loja' })).json;
    const secretCode = 'codigo-invalido-secreto-123';
    const back = await ctx.client().get(`/api/tiktok/callback?auth_code=${secretCode}&state=${encodeURIComponent(stateOf(start.url))}`);
    assert.equal(back.headers.get('location'), '/tiktok/connected?status=error');
    const status = (await user.client.get(`/api/tiktok/connect/${start.attemptId}`)).json;
    assert.equal(status.status, 'error');
    assert.ok(status.message && !status.message.includes(secretCode) && !/auth_code/.test(status.message));
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_business_centers')).c, 0);
  });

  it('autorização sem nenhuma conta de anúncio é erro (nada é salvo)', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    const { start, back } = await authorize(user, { advertisers: [] });
    assert.equal(back.headers.get('location'), '/tiktok/connected?status=error');
    const status = (await user.client.get(`/api/tiktok/connect/${start.attemptId}`)).json;
    assert.match(status.message, /Nenhuma conta de anúncio/);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_business_centers')).c, 0);
  });

  it('usuário bloqueado depois de gerar o link não consegue concluir', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    const start = (await user.client.post('/api/tiktok/connect', { name: 'Loja' })).json;
    await run(ctx.db, "UPDATE users SET status = 'blocked' WHERE id = $1", [user.id]);
    fake.grantAuthCode('code-bloqueado-xxxxxxxx');
    const back = await ctx.client().get(`/api/tiktok/callback?auth_code=code-bloqueado-xxxxxxxx&state=${encodeURIComponent(stateOf(start.url))}`);
    assert.equal(back.headers.get('location'), '/tiktok/connected?status=error');
    assert.equal(fake.callsTo('/oauth2/access_token/').length, 0, 'nem troca o código');
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_business_centers')).c, 0);
  });

  it('só o dono acompanha ou cancela a tentativa', async () => {
    await reset();
    const a = await createUser(ctx, { approve: true });
    const b = await createUser(ctx, { approve: true });
    const admin = await loginAdmin(ctx);
    const start = (await a.client.post('/api/tiktok/connect', { name: 'Loja' })).json;
    assert.equal((await b.client.get(`/api/tiktok/connect/${start.attemptId}`)).status, 404);
    assert.equal((await admin.get(`/api/tiktok/connect/${start.attemptId}`)).status, 404, 'nem o admin enxerga a tentativa alheia');
    assert.equal((await ctx.client().get(`/api/tiktok/connect/${start.attemptId}`)).status, 401);
    await b.client.delete(`/api/tiktok/connect/${start.attemptId}`);
    assert.equal((await a.client.get(`/api/tiktok/connect/${start.attemptId}`)).json.status, 'pending', 'cancelar alheio não surte efeito');
    for (const bad of ['abc', '../etc', 'g'.repeat(32), `${start.attemptId}0`]) {
      assert.equal((await a.client.get(`/api/tiktok/connect/${bad}`)).status, 404, bad);
    }
  });

  it('o resultado é do usuário que gerou o link, mesmo que outra pessoa abra o link', async () => {
    await reset();
    const a = await createUser(ctx, { approve: true });
    const b = await createUser(ctx, { approve: true });
    await authorize(a, { name: 'Da A' });
    assert.equal((await b.client.get('/api/tiktok/business-centers')).json.businessCenters.length, 0);
    assert.equal((await a.client.get('/api/tiktok/business-centers')).json.businessCenters.length, 1);
    assert.equal((await one(ctx.db, 'SELECT owner_id FROM tiktok_business_centers')).owner_id, a.id);
  });

  it('callbacks simultâneos com o mesmo state: só um vence', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    const start = (await user.client.post('/api/tiktok/connect', { name: 'Loja' })).json;
    fake.grantAuthCode('code-corrida-xxxxxxxxxx');
    fake.state.exchangeDelayMs = 40;
    const q = `auth_code=code-corrida-xxxxxxxxxx&state=${encodeURIComponent(stateOf(start.url))}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => ctx.client().get(`/api/tiktok/callback?${q}`)));
    const locations = results.map((r) => r.headers.get('location'));
    assert.equal(locations.filter((l) => l.endsWith('connected')).length, 1);
    assert.equal(locations.filter((l) => l.endsWith('expired')).length, 5);
    assert.equal(fake.callsTo('/oauth2/access_token/').length, 1);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_business_centers')).c, 1);
  });

  it('reautorizar as mesmas contas atualiza a conexão existente (sem duplicar)', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    await authorize(user, { name: 'Loja', advertisers: ['9001', '9002'] });
    const first = await one(ctx.db, 'SELECT id, access_token FROM tiktok_business_centers');
    const second = await authorize(user, { name: 'Outro nome', advertisers: ['9001', '9002', '9003'] });
    assert.equal(second.back.headers.get('location'), '/tiktok/connected?status=connected');
    const rows = await all(ctx.db, 'SELECT id, access_token, name FROM tiktok_business_centers');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, first.id);
    assert.notEqual(rows[0].access_token, first.access_token, 'token novo');
    assert.equal(rows[0].name, 'Loja', 'mantém o nome já escolhido');
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_advertisers')).c, 3);
    const status = (await user.client.get(`/api/tiktok/connect/${second.start.attemptId}`)).json;
    assert.equal(status.connection.id, first.id);
  });

  it('contas iguais em outro usuário NÃO se misturam (cada um tem a sua conexão)', async () => {
    await reset();
    const a = await createUser(ctx, { approve: true });
    const b = await createUser(ctx, { approve: true });
    await authorize(a, { advertisers: ['9001'] });
    await authorize(b, { advertisers: ['9001'] });
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_business_centers')).c, 2);
    assert.equal((await a.client.get('/api/tiktok/business-centers')).json.businessCenters.length, 1);
  });

  it('sincronizar uma conexão por link usa a lista de contas autorizadas', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    await authorize(user, { advertisers: ['9001'] });
    const bc = (await user.client.get('/api/tiktok/business-centers')).json.businessCenters[0];
    const token = [...fake.state.authorized.keys()][0];
    fake.state.authorized.set(token, ['9001', '9002']); // o usuário liberou mais uma conta no TikTok
    const res = await user.client.post(`/api/tiktok/business-centers/${bc.id}/sync`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.businessCenter.advertiserCount, 2);
    const call = fake.callsTo('/oauth2/advertiser/get/').at(-1);
    assert.equal(call.query.app_id, OAUTH_APP_ID);
    assert.equal(call.token, token);
  });

  it('token revogado no TikTok marca a conexão com erro ao sincronizar', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    await authorize(user, { advertisers: ['9001'] });
    const bc = (await user.client.get('/api/tiktok/business-centers')).json.businessCenters[0];
    fake.state.validTokens = new Set(); // revogado
    const res = await user.client.post(`/api/tiktok/business-centers/${bc.id}/sync`);
    assert.equal(res.status, 409);
    assert.equal((await one(ctx.db, 'SELECT status FROM tiktok_business_centers')).status, 'error');
    fake.state.validTokens = new Set();
  });

  it('conexão por link não aceita troca manual de token, mas pode ser renomeada e removida', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    await authorize(user);
    const bc = (await user.client.get('/api/tiktok/business-centers')).json.businessCenters[0];
    const bad = await user.client.patch(`/api/tiktok/business-centers/${bc.id}`, { accessToken: 'um-token-manual-qualquer-123' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'oauth_token_not_editable');
    const renamed = await user.client.patch(`/api/tiktok/business-centers/${bc.id}`, { name: 'Novo nome' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.businessCenter.name, 'Novo nome');
    assert.equal((await user.client.delete(`/api/tiktok/business-centers/${bc.id}`)).status, 204);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_advertisers')).c, 0);
  });

  it('remover o usuário apaga as tentativas dele (cascata)', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    await user.client.post('/api/tiktok/connect', { name: 'Loja' });
    await run(ctx.db, 'DELETE FROM users WHERE id = $1', [user.id]);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_oauth_attempts')).c, 0);
  });

  it('o callback é limitado por IP (429)', async () => {
    const small = await startTestServer({ limits: { ...LIMITS, tiktokCallback: 3 }, config: tiktokTestConfig(), fetchFn: fake.fetchFn, isolated: true });
    try {
      const anon = small.client();
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await anon.get('/api/tiktok/callback?state=abcdefghijklmnopqrstuvwxyz0123456789')).status);
      assert.deepEqual(statuses, [302, 302, 302, 429, 429]);
    } finally {
      await small.stop();
    }
  });

  it('a resposta do callback não permite embutir a página e não vaza o código', async () => {
    const res = await ctx.client().get('/api/tiktok/callback?auth_code=segredo-123456789012&state=x');
    assert.equal(res.status, 302);
    assert.ok(!res.headers.get('location').includes('segredo'));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('Conexão por link desabilitada (sem App ID/Secret)', () => {
  let ctx;
  before(async () => {
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig({ oauth: false }), fetchFn: createFakeTiktok().fetchFn, isolated: true });
  });
  after(() => ctx.stop());

  it('responde 503 claro, informa que não está disponível e o token manual continua funcionando', async () => {
    const user = await createUser(ctx, { approve: true });
    const res = await user.client.post('/api/tiktok/connect', { name: 'Loja' });
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, 'tiktok_oauth_not_configured');
    assert.deepEqual((await user.client.get('/api/tiktok/business-centers')).json.oauth, { available: false });
    // Callback sem app configurado: nada acontece.
    const back = await ctx.client().get('/api/tiktok/callback?auth_code=x&state=abcdefghijklmnopqrstuvwxyz0123456789');
    assert.equal(back.headers.get('location'), '/tiktok/connected?status=expired');
    // O caminho antigo (token manual) segue intacto.
    const manual = await user.client.post('/api/tiktok/business-centers', { name: 'Manual', bcId: '222', accessToken: 'other-token-bbbbbbbbbbbbbbbbbbb' });
    assert.equal(manual.status, 201);
    assert.equal(manual.json.businessCenter.authType, 'token');
  });
});

describe('ID da Business Center nas conexões por link', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn });
  });
  after(() => ctx.stop());

  const reset = async () => {
    await run(ctx.db, 'DELETE FROM tiktok_oauth_attempts');
    await run(ctx.db, 'DELETE FROM tiktok_business_centers');
    Object.assign(fake.state, { ownerBc: {}, omitOwnerBc: false, rejectFields: false, accessibleBcs: [] });
    fake.state.calls.length = 0;
    fake.state.authCodes.clear();
    fake.state.authorized.clear();
  };
  /** O usuário autoriza pelo link; `bcId` é a BC dona que o TikTok informa nas contas. */
  async function connect(user, { advertisers = ['9301', '9302'], bcId } = {}) {
    const start = (await user.client.post('/api/tiktok/connect', { name: 'Por link' })).json;
    const code = newCode();
    fake.grantAuthCode(code, { advertisers, bcId });
    await ctx.client().get(`/api/tiktok/callback?auth_code=${code}&state=${encodeURIComponent(stateOf(start.url))}`);
    return (await user.client.get(`/api/tiktok/connect/${start.attemptId}`)).json.connection;
  }
  const listed = async (user) => (await user.client.get('/api/tiktok/business-centers')).json.businessCenters;

  it('o TikTok informa a BC dona das contas: o ID aparece na conexão, nas contas de anúncio e no banco', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    const connection = await connect(user, { bcId: '7123450000000000001' });
    assert.deepEqual(connection.bcIds, ['7123450000000000001']);
    assert.equal(connection.bcId, null, 'o campo bcId (cadastro por token) continua vazio na conexão por link');
    assert.deepEqual((await listed(user))[0].bcIds, ['7123450000000000001']);
    const accounts = (await user.client.get('/api/tiktok/advertisers')).json.advertisers;
    assert.deepEqual(accounts.map((a) => [a.id, a.ownerBcId]), [['9301', '7123450000000000001'], ['9302', '7123450000000000001']]);
    assert.deepEqual((await all(ctx.db, 'SELECT DISTINCT owner_bc_id FROM tiktok_advertisers')).map((r) => r.owner_bc_id), ['7123450000000000001']);
    const infoCall = fake.callsTo('/advertiser/info/')[0];
    assert.deepEqual(JSON.parse(infoCall.query.fields), ['advertiser_id', 'name', 'currency', 'timezone', 'owner_bc_id']);
  });

  it('autorização com contas de BCs diferentes mostra todas as BCs (sem repetir, em ordem)', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    fake.state.ownerBc = { 9401: '700000000000000002', 9402: '700000000000000001', 9403: '700000000000000002' };
    const connection = await connect(user, { advertisers: ['9401', '9402', '9403'] });
    assert.deepEqual(connection.bcIds, ['700000000000000001', '700000000000000002']);
  });

  it('conexão por token continua mostrando o ID informado no cadastro', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    const res = await user.client.post('/api/tiktok/business-centers', { name: 'Por token', bcId: '222', accessToken: OTHER_TOKEN });
    assert.equal(res.status, 201);
    assert.deepEqual([res.json.businessCenter.bcId, res.json.businessCenter.bcIds], ['222', ['222']]);
  });

  it('as contas não informam a BC: usa a lista de BCs do token SÓ se houver exatamente uma (sem adivinhar)', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    fake.state.omitOwnerBc = true;
    fake.state.accessibleBcs = [{ id: '7777', name: 'Minha BC' }];
    assert.deepEqual((await connect(user)).bcIds, ['7777']);
    assert.ok(fake.callsTo('/bc/get/').length >= 1);

    await reset();
    fake.state.omitOwnerBc = true;
    fake.state.accessibleBcs = [{ id: '7777', name: 'A' }, { id: '8888', name: 'B' }];
    assert.deepEqual((await connect(user)).bcIds, [], 'duas BCs possíveis: não dá para saber qual é; não chuta');
  });

  it('sem permissão para listar BCs ou sem informação nenhuma: a conexão FUNCIONA e o ID fica vazio (a tela explica)', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    Object.assign(fake.state, { omitOwnerBc: true, accessibleBcs: null });
    const connection = await connect(user);
    assert.equal(connection.status, 'active');
    assert.equal(connection.advertiserCount, 2);
    assert.deepEqual(connection.bcIds, []);
  });

  it('TikTok recusa o parâmetro `fields`: tudo funciona como antes (repete sem ele) e usa a reserva da lista de BCs', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    Object.assign(fake.state, { rejectFields: true, accessibleBcs: [{ id: '5555', name: 'BC' }] });
    const connection = await connect(user);
    assert.equal(connection.advertiserCount, 2, 'as contas foram lidas mesmo sem o parâmetro');
    assert.deepEqual(connection.bcIds, ['5555']);
    const withFields = fake.callsTo('/advertiser/info/').map((c) => 'fields' in c.query);
    assert.deepEqual(withFields, [true, false]);
  });

  it('conexões antigas (sem o ID) são preenchidas ao Sincronizar; e o que o TikTok informa de novo atualiza', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    fake.state.omitOwnerBc = true;
    const connection = await connect(user);
    assert.deepEqual(connection.bcIds, []);
    const id = (await listed(user))[0].id;

    fake.state.omitOwnerBc = false;
    fake.state.ownerBc = { 9301: '7000000000000000009', 9302: '7000000000000000009' };
    const res = await user.client.post(`/api/tiktok/business-centers/${id}/sync`, {});
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.businessCenter.bcIds, ['7000000000000000009']);

    fake.state.ownerBc = { 9301: '7000000000000000010', 9302: '7000000000000000010' };
    assert.deepEqual((await user.client.post(`/api/tiktok/business-centers/${id}/sync`, {})).json.businessCenter.bcIds, ['7000000000000000010']);
  });

  it('valor estranho vindo do TikTok nunca é gravado (só números)', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    fake.state.ownerBc = { 9301: "1'; DROP TABLE users;--", 9302: '<b>x</b>' };
    assert.deepEqual((await connect(user)).bcIds, []);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int AS c FROM tiktok_advertisers WHERE owner_bc_id IS NOT NULL')).c, 0);
  });

  it('o ID da BC segue as mesmas regras de visibilidade da conexão (outro usuário não vê)', async () => {
    await reset();
    const owner = await createUser(ctx, { approve: true });
    const stranger = await createUser(ctx, { approve: true });
    await connect(owner, { bcId: '7000000000000000042' });
    assert.deepEqual(await listed(stranger), []);
    assert.ok(!JSON.stringify((await stranger.client.get('/api/tiktok/advertisers')).json).includes('7000000000000000042'));
  });
});
