import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { completeConfig } from './campaign-fixtures.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, loginAdmin, one, run, startTestServer } from './helpers.js';
import { uploadedId } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, campaignPublish: 1000 };
const own = (over = {}) => ({ name: 'Minha BC', bcId: '222', accessToken: OTHER_TOKEN, ...over });

describe('Business Centers por usuário', () => {
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
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9101'], 333: ['9201', '9202'] };
  };

  it('usuário comum conecta a própria BC, vê só o que é dele e o token nunca volta', async () => {
    await reset();
    const { client } = await createUser(ctx, { approve: true });
    const res = await client.post('/api/tiktok/business-centers', own());
    assert.equal(res.status, 201);
    const bc = res.json.businessCenter;
    assert.deepEqual({ shared: bc.shared, owned: bc.owned, canManage: bc.canManage, advertiserCount: bc.advertiserCount, status: bc.status }, { shared: false, owned: true, canManage: true, advertiserCount: 1, status: 'active' });
    assert.ok(!('ownerName' in bc), 'usuário comum não vê dados de dono');
    assert.ok(!res.text.includes(OTHER_TOKEN));

    const list = await client.get('/api/tiktok/business-centers');
    assert.equal(list.json.businessCenters.length, 1);
    assert.ok(!list.text.includes(OTHER_TOKEN) && !list.text.includes('access_token'));
    const stored = (await one(ctx.db, 'SELECT access_token, owner_id, shared FROM tiktok_business_centers'));
    assert.match(stored.access_token, /^v1\./);
    assert.equal(stored.shared, false);

    assert.deepEqual((await client.get('/api/tiktok/advertisers')).json.advertisers.map((a) => a.id), ['9101']);
    assert.equal((await client.get('/api/tiktok/advertisers/9101/report?days=7')).status, 200);
    assert.equal((await client.get('/api/tiktok/advertisers/9101/campaigns')).status, 200);
    const overview = (await client.get('/api/tiktok/overview?days=7')).json;
    assert.equal(overview.totalAdvertisers, 1);
  });

  it('usuário NÃO pode compartilhar com a equipe (403) nem alterar o compartilhamento', async () => {
    await reset();
    const { client } = await createUser(ctx, { approve: true });
    fake.state.calls.length = 0;
    const res = await client.post('/api/tiktok/business-centers', own({ shared: true }));
    assert.equal(res.status, 403);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*) c FROM tiktok_business_centers')).c, 0);
    assert.equal(fake.state.calls.length, 0);

    const { id } = (await client.post('/api/tiktok/business-centers', own())).json.businessCenter;
    assert.equal((await client.patch(`/api/tiktok/business-centers/${id}`, { shared: true })).status, 403);
    assert.equal((await one(ctx.db, 'SELECT shared FROM tiktok_business_centers')).shared, false);
    assert.equal((await client.post('/api/tiktok/business-centers', own({ bcId: '333', shared: 'sim' }))).status, 400, 'tipo inválido');
  });

  it('isolamento total entre usuários: lista, gerenciamento e dados', async () => {
    await reset();
    const a = await createUser(ctx, { approve: true });
    const b = await createUser(ctx, { approve: true });
    const bcA = (await a.client.post('/api/tiktok/business-centers', own())).json.businessCenter;
    fake.state.calls.length = 0;

    assert.equal((await b.client.get('/api/tiktok/business-centers')).json.businessCenters.length, 0);
    assert.equal((await b.client.get('/api/tiktok/advertisers')).json.advertisers.length, 0);
    assert.equal((await b.client.get('/api/tiktok/advertisers/9101/report?days=7')).status, 404);
    assert.equal((await b.client.get('/api/tiktok/advertisers/9101/campaigns')).status, 404);
    assert.equal((await b.client.get('/api/tiktok/overview?days=7')).json.totalAdvertisers, 0);
    // 404 (e não 403): não revela que a BC existe
    assert.equal((await b.client.patch(`/api/tiktok/business-centers/${bcA.id}`, { name: 'Invadida' })).status, 404);
    assert.equal((await b.client.post(`/api/tiktok/business-centers/${bcA.id}/sync`)).status, 404);
    assert.equal((await b.client.delete(`/api/tiktok/business-centers/${bcA.id}`)).status, 404);
    assert.equal(fake.state.calls.length, 0, 'nenhuma chamada ao TikTok com o token de outro usuário');
    assert.equal((await one(ctx.db, 'SELECT name FROM tiktok_business_centers WHERE id = $1', [bcA.id])).name, 'Minha BC');
    assert.equal((await a.client.get('/api/tiktok/advertisers/9101/report?days=7')).status, 200);
  });

  it('mesma BC em usuários diferentes é permitida; repetida pelo mesmo usuário dá 409', async () => {
    await reset();
    const a = await createUser(ctx, { approve: true });
    const b = await createUser(ctx, { approve: true });
    assert.equal((await a.client.post('/api/tiktok/business-centers', own())).status, 201);
    assert.equal((await b.client.post('/api/tiktok/business-centers', own())).status, 201, 'cada um com o próprio token');
    assert.equal((await a.client.post('/api/tiktok/business-centers', own({ name: 'Outra' }))).status, 409);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*) c FROM tiktok_business_centers')).c, 2);
    // cada um enxerga apenas a sua
    assert.equal((await a.client.get('/api/tiktok/business-centers')).json.businessCenters.length, 1);
    assert.equal((await b.client.get('/api/tiktok/business-centers')).json.businessCenters.length, 1);
  });

  it('cadastros simultâneos da mesma BC pelo mesmo usuário: 201 + 409, nunca 500', async () => {
    await reset();
    const { client } = await createUser(ctx, { approve: true });
    const [x, y] = await Promise.all([client.post('/api/tiktok/business-centers', own()), client.post('/api/tiktok/business-centers', own({ name: 'Dupla' }))]);
    assert.deepEqual([x.status, y.status].sort(), [201, 409]);
  });

  it('admin supervisiona todas (com o dono), mas os DADOS usam só as BCs dele e as compartilhadas', async () => {
    await reset();
    const { client } = await createUser(ctx, { approve: true, name: 'Dona da Loja' });
    const bc = (await client.post('/api/tiktok/business-centers', own())).json.businessCenter;

    const adminList = (await admin.get('/api/tiktok/business-centers')).json.businessCenters;
    assert.equal(adminList.length, 1);
    assert.equal(adminList[0].ownerName, 'Dona da Loja');
    assert.equal(adminList[0].canManage, true);
    assert.equal(adminList[0].owned, false);
    assert.ok(!JSON.stringify(adminList).includes(OTHER_TOKEN), 'nem o admin recebe tokens');

    fake.state.calls.length = 0;
    assert.equal((await admin.get('/api/tiktok/advertisers')).json.advertisers.length, 0, 'não usa a BC privada de outro usuário');
    assert.equal((await admin.get('/api/tiktok/advertisers/9101/report?days=7')).status, 404);
    assert.equal(fake.state.calls.length, 0);

    // pode administrar: renomear, sincronizar e remover
    assert.equal((await admin.patch(`/api/tiktok/business-centers/${bc.id}`, { name: 'Renomeada pelo admin' })).json.businessCenter.name, 'Renomeada pelo admin');
    assert.equal((await admin.post(`/api/tiktok/business-centers/${bc.id}/sync`)).status, 200);
    assert.equal((await admin.delete(`/api/tiktok/business-centers/${bc.id}`)).status, 204);
    assert.equal((await client.get('/api/tiktok/business-centers')).json.businessCenters.length, 0);
  });

  it('BC compartilhada pelo admin: todos consomem, só dono/admin gerenciam, token continua oculto', async () => {
    await reset();
    const shared = (await admin.post('/api/tiktok/business-centers', { name: 'Equipe', bcId: '111', accessToken: GOOD_TOKEN, shared: true })).json.businessCenter;
    assert.equal(shared.shared, true);
    const { client } = await createUser(ctx, { approve: true });

    const list = (await client.get('/api/tiktok/business-centers')).json.businessCenters;
    assert.equal(list.length, 1);
    assert.deepEqual({ shared: list[0].shared, owned: list[0].owned, canManage: list[0].canManage }, { shared: true, owned: false, canManage: false });
    assert.ok(!('ownerName' in list[0]));
    assert.equal((await client.get('/api/tiktok/advertisers')).json.advertisers.length, 2);
    assert.equal((await client.get('/api/tiktok/advertisers/9001/report?days=7')).status, 200);
    assert.ok(!(await client.get('/api/tiktok/business-centers')).text.includes(GOOD_TOKEN));

    // visível, porém não gerenciável -> 403
    assert.equal((await client.patch(`/api/tiktok/business-centers/${shared.id}`, { name: 'x1' })).status, 403);
    assert.equal((await client.post(`/api/tiktok/business-centers/${shared.id}/sync`)).status, 403);
    assert.equal((await client.delete(`/api/tiktok/business-centers/${shared.id}`)).status, 403);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*) c FROM tiktok_business_centers')).c, 1);
  });

  it('admin pode compartilhar e deixar de compartilhar a BC de um usuário', async () => {
    await reset();
    const a = await createUser(ctx, { approve: true });
    const b = await createUser(ctx, { approve: true });
    const bc = (await a.client.post('/api/tiktok/business-centers', own())).json.businessCenter;
    assert.equal((await b.client.get('/api/tiktok/advertisers')).json.advertisers.length, 0);

    assert.equal((await admin.patch(`/api/tiktok/business-centers/${bc.id}`, { shared: true })).json.businessCenter.shared, true);
    assert.equal((await b.client.get('/api/tiktok/advertisers')).json.advertisers.length, 1);
    assert.equal((await b.client.get('/api/tiktok/advertisers/9101/report?days=7')).status, 200);

    await admin.patch(`/api/tiktok/business-centers/${bc.id}`, { shared: false });
    assert.equal((await b.client.get('/api/tiktok/advertisers')).json.advertisers.length, 0);
    assert.equal((await b.client.get('/api/tiktok/advertisers/9101/report?days=7')).status, 404, 'o cache não vaza acesso após descompartilhar');
  });

  it('token revogado afeta só a BC do dono e a edição pelo dono normaliza', async () => {
    await reset();
    const a = await createUser(ctx, { approve: true });
    const b = await createUser(ctx, { approve: true });
    const bcA = (await a.client.post('/api/tiktok/business-centers', own({ bcId: '222', accessToken: OTHER_TOKEN }))).json.businessCenter;
    await b.client.post('/api/tiktok/business-centers', { name: 'BC do B', bcId: '333', accessToken: GOOD_TOKEN });

    fake.state.validTokens.delete(OTHER_TOKEN);
    assert.equal((await a.client.get('/api/tiktok/advertisers/9101/report?days=7')).status, 409);
    assert.equal((await a.client.get('/api/tiktok/business-centers')).json.businessCenters[0].status, 'error');
    assert.equal((await b.client.get('/api/tiktok/business-centers')).json.businessCenters[0].status, 'active', 'a BC do outro usuário não é afetada');
    assert.equal((await b.client.get('/api/tiktok/advertisers/9201/report?days=7')).status, 200);

    fake.state.validTokens.add(OTHER_TOKEN);
    assert.equal((await a.client.patch(`/api/tiktok/business-centers/${bcA.id}`, { accessToken: OTHER_TOKEN })).json.businessCenter.status, 'active');
    assert.equal((await a.client.get('/api/tiktok/advertisers/9101/report?days=7')).status, 200);
  });

  it('visão geral e cache são por usuário', async () => {
    await reset();
    const a = await createUser(ctx, { approve: true });
    const b = await createUser(ctx, { approve: true });
    await a.client.post('/api/tiktok/business-centers', own());
    await b.client.post('/api/tiktok/business-centers', { name: 'BC B', bcId: '333', accessToken: GOOD_TOKEN });
    const oa = (await a.client.get('/api/tiktok/overview?days=7')).json;
    const ob = (await b.client.get('/api/tiktok/overview?days=7')).json;
    assert.equal(oa.totalAdvertisers, 1);
    assert.equal(ob.totalAdvertisers, 2);
    assert.equal(oa.groups[0].advertisers, 1);
    assert.equal(ob.groups[0].advertisers, 2);
  });

  it('publicação de campanha usa só contas visíveis ao usuário', async () => {
    await reset();
    const a = await createUser(ctx, { approve: true });
    const b = await createUser(ctx, { approve: true });
    await a.client.post('/api/tiktok/business-centers', own());
    // Cada usuário só pode usar criativos da PRÓPRIA biblioteca.
    const cfgFor = async (client) => completeConfig('TRAFFIC', { ad: { videoCreativeId: await uploadedId(client, { type: 'mp4' }) } });

    const draftA = (await a.client.post('/api/campaigns', { config: await cfgFor(a.client) })).json.campaign;
    const draftB = (await b.client.post('/api/campaigns', { config: await cfgFor(b.client) })).json.campaign;
    fake.state.calls.length = 0;
    const blocked = await b.client.post(`/api/campaigns/${draftB.id}/publish`, { confirm: true, advertiserId: '9101' });
    assert.equal(blocked.status, 404, 'B não publica na conta do A');
    assert.equal(fake.callsTo('/campaign/create/').length, 0);

    const ok = await a.client.post(`/api/campaigns/${draftA.id}/publish`, { confirm: true, advertiserId: '9101' });
    assert.equal(ok.status, 200);
    assert.equal(fake.callsTo('/campaign/create/')[0].token, OTHER_TOKEN, 'usa o token do dono da BC');
  });
});

describe('Contas de anúncio: de qual Business Center cada uma é', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn });
  });
  after(() => ctx.stop());

  it('cada conta traz a BC de origem (nome, ID, tipo de conexão, visibilidade); ordenadas por BC e nome; sem token', async () => {
    const admin = await loginAdmin(ctx);
    const { client } = await createUser(ctx, { approve: true });
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9101'], 333: ['9201', '9202'] };
    assert.equal((await admin.post('/api/tiktok/business-centers', { name: 'Loja Matriz', bcId: '111', accessToken: GOOD_TOKEN, shared: true })).status, 201);
    assert.equal((await client.post('/api/tiktok/business-centers', { name: 'Agência Bia', bcId: '222', accessToken: OTHER_TOKEN })).status, 201);
    // conexão por link da usuária (sem ID de BC)
    fake.grantAuthCode('code-contas-xxxxxxxxxx', { advertisers: ['9301'] });
    const start = (await client.post('/api/tiktok/connect', { name: 'Conta por Link' })).json;
    const state = new URL(start.url).searchParams.get('state');
    await ctx.client().get(`/api/tiktok/callback?auth_code=code-contas-xxxxxxxxxx&state=${encodeURIComponent(state)}`);

    const res = await client.get('/api/tiktok/advertisers');
    assert.equal(res.status, 200);
    const rows = res.json.advertisers.map((a) => [a.id, a.businessCenterName, a.businessCenterBcId, a.businessCenterAuthType, a.businessCenterShared, a.businessCenterOwned]);
    assert.deepEqual(rows, [
      ['9101', 'Agência Bia', '222', 'token', false, true],
      ['9301', 'Conta por Link', null, 'oauth', false, true],
      ['9001', 'Loja Matriz', '111', 'token', true, false],
      ['9002', 'Loja Matriz', '111', 'token', true, false],
    ]);
    assert.ok(res.json.advertisers.every((a) => a.businessCenterStatus === 'active' && a.currency));
    assert.ok(!res.text.includes(GOOD_TOKEN) && !res.text.includes(OTHER_TOKEN) && !/access_token/.test(res.text));
  });

  it('outro usuário não vê contas nem BCs privadas alheias', async () => {
    const { client } = await createUser(ctx, { approve: true });
    const ids = (await client.get('/api/tiktok/advertisers')).json.advertisers.map((a) => a.id);
    assert.deepEqual(ids, ['9001', '9002'], 'só as compartilhadas pelo admin');
  });
});
