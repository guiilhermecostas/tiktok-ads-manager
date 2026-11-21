import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { completeConfig } from './campaign-fixtures.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, loginAdmin, startTestServer } from './helpers.js';
import { uploadedId } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, campaignPublish: 1000 };

describe('Publicar a mesma campanha em várias contas de anúncio', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn });
    const admin = await loginAdmin(ctx);
    // BC compartilhada (contas 9001 BRL e 9002 USD) para toda a equipe.
    assert.equal((await admin.post('/api/tiktok/business-centers', { name: 'Loja Matriz', bcId: '111', accessToken: GOOD_TOKEN, shared: true })).status, 201);
  });
  after(() => ctx.stop());

  const reset = () => {
    fake.state.calls.length = 0;
    fake.state.failCreate.clear();
    fake.state.failForAdvertiser.clear();
  };
  /** Usuária com a BC privada 222 (conta 9101) além da compartilhada. */
  const newUser = async ({ privateBc = true } = {}) => {
    const user = await createUser(ctx, { approve: true });
    if (privateBc) assert.equal((await user.client.post('/api/tiktok/business-centers', { name: 'Agência', bcId: '222', accessToken: OTHER_TOKEN })).status, 201);
    return user;
  };
  const draft = async (client, objective = 'TRAFFIC', over = {}) => {
    const video = await uploadedId(client, { type: 'mp4' });
    return (await client.post('/api/campaigns', { config: completeConfig(objective, { ...over, ad: { videoCreativeId: video, ...over.ad } }) })).json.campaign;
  };
  const publish = (client, id, advertiserId, extra = {}) => client.post(`/api/campaigns/${id}/publish`, { confirm: true, advertiserId, ...extra });
  const detail = async (client, id) => (await client.get(`/api/campaigns/${id}`)).json.campaign;
  const byAccount = (campaign) => Object.fromEntries(campaign.publications.map((p) => [p.advertiserId, p]));

  it('publica em 3 contas de 2 Business Centers: cada uma com o próprio token, IDs e registro; tudo PAUSADO', async () => {
    const { client } = await newUser();
    const { id } = await draft(client);
    reset();
    for (const account of ['9001', '9002', '9101']) {
      const res = await publish(client, id, account);
      assert.equal(res.status, 200, `${account}: ${res.text}`);
      assert.equal(res.json.publication.advertiserId, account);
      assert.equal(res.json.publication.status, 'published');
    }
    const creates = ['/campaign/create/', '/adgroup/create/', '/ad/create/'].map((p) => fake.callsTo(p));
    assert.deepEqual(creates.map((c) => c.length), [3, 3, 3]);
    assert.deepEqual(creates[0].map((c) => c.body.advertiser_id), ['9001', '9002', '9101']);
    assert.deepEqual(creates[0].map((c) => c.token), [GOOD_TOKEN, GOOD_TOKEN, OTHER_TOKEN], 'o token é o da BC dona de cada conta');
    assert.ok([...creates[0], ...creates[1]].every((c) => c.body.operation_status === 'DISABLE'), 'campanha e grupo nascem pausados');
    assert.ok(creates[2].every((c) => c.body.creatives.every((cr) => cr.operation_status === 'DISABLE')), 'o anúncio nasce pausado');

    const campaign = await detail(client, id);
    assert.equal(campaign.publish.status, 'published');
    assert.deepEqual([campaign.publish.published, campaign.publish.partial, campaign.publish.failed], [3, 0, 0]);
    assert.equal(campaign.status, 'paused');
    assert.equal(campaign.publications.length, 3);
    const ids = campaign.publications.map((p) => p.tiktokCampaignId);
    assert.equal(new Set(ids).size, 3, 'cada conta tem os próprios IDs do TikTok');
    assert.ok(campaign.publications.every((p) => p.tiktokAdGroupId && p.tiktokAdId && p.publishedAt && p.error === null));
    assert.ok(!JSON.stringify(campaign).includes(GOOD_TOKEN) && !JSON.stringify(campaign).includes(OTHER_TOKEN));
  });

  it('a falha em uma conta não impede as outras; a conta que falhou pode ser tentada de novo sem duplicar', async () => {
    const { client } = await newUser();
    const { id } = await draft(client);
    reset();
    fake.state.failForAdvertiser.set('9002', 'ad');
    assert.equal((await publish(client, id, '9001')).status, 200);
    const failed = await publish(client, id, '9002');
    assert.equal(failed.status, 502);
    assert.match(failed.json.error.message, /Identity not found/);
    assert.equal((await publish(client, id, '9101')).status, 200, 'a terceira conta segue normalmente');

    let campaign = await detail(client, id);
    const state = byAccount(campaign);
    assert.deepEqual([state['9001'].status, state['9002'].status, state['9101'].status], ['published', 'partial', 'published']);
    assert.match(state['9002'].error, /Identity not found/);
    assert.ok(state['9002'].tiktokCampaignId && state['9002'].tiktokAdGroupId && !state['9002'].tiktokAdId);
    assert.equal(campaign.publish.status, 'partial', 'há uma publicação pela metade');

    fake.state.failForAdvertiser.clear();
    const created = { c: fake.callsTo('/campaign/create/').length, g: fake.callsTo('/adgroup/create/').length };
    assert.equal((await publish(client, id, '9002')).status, 200);
    assert.equal(fake.callsTo('/campaign/create/').length, created.c, 'a campanha da conta 9002 não foi recriada');
    assert.equal(fake.callsTo('/adgroup/create/').length, created.g, 'o grupo não foi recriado');
    campaign = await detail(client, id);
    assert.equal(campaign.publish.status, 'published');
    assert.equal(byAccount(campaign)['9002'].error, null);
  });

  it('falha ao criar a campanha numa conta registra o erro daquela conta (sem IDs) e não trava as demais', async () => {
    const { client } = await newUser();
    const { id } = await draft(client);
    reset();
    fake.state.failForAdvertiser.set('9001', 'campaign');
    assert.equal((await publish(client, id, '9001')).status, 502);
    assert.equal((await publish(client, id, '9002')).status, 200);
    const campaign = await detail(client, id);
    assert.equal(byAccount(campaign)['9001'].status, 'failed');
    assert.match(byAccount(campaign)['9001'].error, /already exists/);
    assert.equal(campaign.publish.status, 'published');
    assert.equal(campaign.publish.failed, 1);
    assert.equal(campaign.publish.locks.campaign, true, 'a conta 9002 já criou a campanha');
  });

  it('IDs próprios de cada conta (pixel e identidade): valem só naquela conta; a campanha base não muda', async () => {
    const { client } = await newUser();
    const { id } = await draft(client, 'WEB_CONVERSIONS');
    reset();
    assert.equal((await publish(client, id, '9001')).status, 200);
    const res = await publish(client, id, '9002', { overrides: { adGroup: { pixelId: '999000' }, ad: { identityId: 'identidade-conta-2' } } });
    assert.equal(res.status, 200, res.text);

    const [g1, g2] = fake.callsTo('/adgroup/create/');
    const [a1, a2] = fake.callsTo('/ad/create/');
    assert.equal(g1.body.pixel_id, '123456', 'sem ajuste: vale o da campanha');
    assert.equal(g2.body.pixel_id, '999000');
    assert.equal(a1.body.creatives[0].identity_id, 'id-123456');
    assert.equal(a2.body.creatives[0].identity_id, 'identidade-conta-2');

    const campaign = await detail(client, id);
    assert.equal(campaign.config.adGroup.pixelId, '123456', 'a configuração da campanha não foi alterada');
    assert.equal(campaign.config.ad.identityId, 'id-123456');
    assert.equal(byAccount(campaign)['9001'].overrides, null);
    assert.deepEqual(byAccount(campaign)['9002'].overrides, { adGroup: { pixelId: '999000' }, ad: { identityId: 'identidade-conta-2' } });
  });

  it('ajustes inválidos: campo que não é por conta, tipo ruim e ID malformado são recusados ANTES de chamar o TikTok', async () => {
    const { client } = await newUser();
    const { id } = await draft(client, 'WEB_CONVERSIONS');
    reset();
    const forbidden = await publish(client, id, '9001', { overrides: { campaign: { name: 'Outro nome' }, adGroup: { budget: 1 }, ad: { landingPageUrl: 'https://evil.example' } } });
    assert.equal(forbidden.status, 400);
    const paths = forbidden.json.error.details.map((d) => d.path);
    assert.ok(['overrides.campaign.name', 'overrides.adGroup.budget', 'overrides.ad.landingPageUrl'].every((p) => paths.includes(p)), paths.join());

    assert.equal((await publish(client, id, '9001', { overrides: 'texto' })).status, 400);
    assert.equal((await publish(client, id, '9001', { overrides: { adGroup: { pixelId: 123 } } })).status, 400);
    const malformed = await publish(client, id, '9001', { overrides: { adGroup: { pixelId: 'abc' } } });
    assert.equal(malformed.status, 400);
    assert.ok(malformed.json.error.details.some((d) => d.path === 'adGroup.pixelId'));
    assert.equal(fake.state.calls.length, 0, 'nada foi enviado ao TikTok');
    assert.equal((await detail(client, id)).publications.length, 0, 'nada foi registrado');
  });

  it('exige a conta: ausente ou malformada = 400; conta que o usuário não enxerga = 404 e nada é registrado', async () => {
    const { client } = await newUser();
    const stranger = await newUser({ privateBc: false });
    const { id } = await draft(client);
    reset();
    for (const advertiserId of [undefined, '', 'abc', '../9001', '9001; DROP TABLE campaigns', 9001, ['9001'], '9'.repeat(25)]) {
      const res = await client.post(`/api/campaigns/${id}/publish`, { confirm: true, advertiserId });
      assert.equal(res.status, 400, JSON.stringify(advertiserId));
      assert.equal(res.json.error.code, 'advertiser_required');
    }
    assert.equal((await publish(client, id, '777777')).status, 404, 'conta inexistente');
    assert.equal((await publish(stranger.client, id, '9001')).status, 404, 'campanha de outro usuário');
    const strangerOwn = await draft(stranger.client);
    assert.equal((await publish(stranger.client, strangerOwn.id, '9101')).status, 404, 'conta da BC privada de outro usuário');
    assert.equal(fake.state.calls.filter((c) => c.path.endsWith('/create/')).length, 0);
    assert.deepEqual((await detail(client, id)).publications, []);
    assert.deepEqual((await detail(stranger.client, strangerOwn.id)).publications, []);
  });

  it('a mesma conta não recebe a campanha duas vezes (409); outras contas continuam liberadas', async () => {
    const { client } = await newUser();
    const { id } = await draft(client);
    assert.equal((await publish(client, id, '9001')).status, 200);
    reset();
    const again = await publish(client, id, '9001');
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, 'already_published');
    assert.equal(fake.state.calls.filter((c) => c.path.endsWith('/create/')).length, 0, 'nada duplicado no TikTok');
    assert.equal((await publish(client, id, '9002')).status, 200, 'outra conta pode receber a mesma campanha depois');
  });

  it('depois que uma conta concluiu, a configuração fica travada (a mesma vale para todas); publicar em mais contas segue possível', async () => {
    const { client } = await newUser();
    const { id, config } = await draft(client);
    assert.equal((await publish(client, id, '9001')).status, 200);
    const campaign = await detail(client, id);
    assert.deepEqual(campaign.publish.locks, { campaign: true, adGroup: true, ad: true });
    const edit = await client.put(`/api/campaigns/${id}`, { config: { ...config, campaign: { ...config.campaign, name: 'Mudei' } } });
    assert.equal(edit.status, 409);
    assert.equal(edit.json.error.code, 'already_published');
    assert.equal((await publish(client, id, '9002')).status, 200);
  });

  it('só publicação parcial: campanha e grupo travam, o anúncio continua editável; ajuste do grupo não muda depois que o grupo existe', async () => {
    const { client } = await newUser();
    const { id } = await draft(client, 'WEB_CONVERSIONS');
    reset();
    fake.state.failForAdvertiser.set('9001', 'ad');
    assert.equal((await publish(client, id, '9001', { overrides: { adGroup: { pixelId: '555111' } } })).status, 502);
    let campaign = await detail(client, id);
    assert.deepEqual(campaign.publish.locks, { campaign: true, adGroup: true, ad: false });

    // O anúncio ainda pode mudar; campanha/grupo não.
    const edited = { ...campaign.config, campaign: { ...campaign.config.campaign, name: 'Nome novo' }, ad: { ...campaign.config.ad, identityId: 'identidade-corrigida' } };
    const put = await client.put(`/api/campaigns/${id}`, { config: edited });
    assert.equal(put.status, 200);
    assert.equal(put.json.campaign.config.campaign.name, 'Black Friday');
    assert.equal(put.json.campaign.config.ad.identityId, 'identidade-corrigida');

    // Tentar trocar o pixel (nível do grupo, já criado) na retomada é ignorado: vale o que foi usado na criação.
    fake.state.failForAdvertiser.clear();
    const created = fake.callsTo('/adgroup/create/').length;
    const retry = await publish(client, id, '9001', { overrides: { adGroup: { pixelId: '000222' }, ad: { identityId: 'identidade-da-conta' } } });
    assert.equal(retry.status, 200, retry.text);
    assert.equal(fake.callsTo('/adgroup/create/').length, created, 'grupo não recriado');
    campaign = await detail(client, id);
    assert.deepEqual(byAccount(campaign)['9001'].overrides, { adGroup: { pixelId: '555111' }, ad: { identityId: 'identidade-da-conta' } });
    assert.equal(fake.callsTo('/ad/create/').at(-1).body.creatives[0].identity_id, 'identidade-da-conta', 'o anúncio usa o ajuste novo');
  });

  it('publicações simultâneas da mesma campanha (em contas diferentes): uma vence, as outras recebem 409 e nada é duplicado', async () => {
    const { client } = await newUser();
    const { id } = await draft(client);
    reset();
    fake.state.createDelayMs = 80;
    try {
      const results = await Promise.all(['9001', '9002', '9101'].map((account) => publish(client, id, account)));
      const codes = results.map((r) => r.status).sort();
      assert.equal(codes.filter((c) => c === 200).length, 1);
      assert.equal(codes.filter((c) => c === 409).length, 2);
      assert.ok(results.filter((r) => r.status === 409).every((r) => r.json.error.code === 'publish_in_progress'));
      assert.equal(fake.callsTo('/campaign/create/').length, 1, 'só uma conta foi criada no TikTok');
    } finally {
      fake.state.createDelayMs = 0;
    }
    // Sequencialmente, as contas que ficaram de fora publicam normalmente (e a que já venceu continua 409).
    const winner = (await detail(client, id)).publications[0].advertiserId;
    for (const account of ['9001', '9002', '9101']) {
      const res = await publish(client, id, account);
      assert.equal(res.status, account === winner ? 409 : 200, account);
    }
    assert.equal((await detail(client, id)).publish.published, 3);
  });

  it('a listagem resume as publicações por campanha (sem a configuração), e excluir a campanha apaga as publicações', async () => {
    const { client } = await newUser();
    const a = await draft(client);
    const b = await draft(client);
    await draft(client);
    reset();
    await publish(client, a.id, '9001');
    await publish(client, a.id, '9002');
    fake.state.failForAdvertiser.set('9001', 'ad');
    await publish(client, b.id, '9001');

    const list = (await client.get('/api/campaigns')).json.campaigns;
    assert.equal(list.length, 3);
    assert.ok(list.every((c) => !('config' in c) && !('publications' in c)));
    const byId = Object.fromEntries(list.map((c) => [c.id, c.publish]));
    assert.deepEqual([byId[a.id].status, byId[a.id].published], ['published', 2]);
    assert.deepEqual([byId[b.id].status, byId[b.id].partial], ['partial', 1]);
    assert.match(byId[b.id].error, /Identity not found/);
    assert.equal(list.find((c) => c.publish.status === 'none').publish.published, 0);

    assert.equal((await client.delete(`/api/campaigns/${a.id}`)).status, 204);
    const rows = await all(ctx.db, 'SELECT campaign_id FROM campaign_publications WHERE campaign_id = $1', [a.id]);
    assert.equal(rows.length, 0, 'publicações removidas em cascata');
  });

  it('o banco impede publicação duplicada por (campanha, conta) e conta malformada', async () => {
    const { client } = await newUser();
    const { id } = await draft(client);
    await publish(client, id, '9001');
    await assert.rejects(() => ctx.db.query("INSERT INTO campaign_publications (campaign_id, advertiser_id) VALUES ($1, '9001')", [id]), (e) => e.code === '23505');
    await assert.rejects(() => ctx.db.query("INSERT INTO campaign_publications (campaign_id, advertiser_id) VALUES ($1, 'abc')", [id]), (e) => e.code === '23514');
    await assert.rejects(() => ctx.db.query("INSERT INTO campaign_publications (campaign_id, advertiser_id) VALUES (999999, '9002')"), (e) => e.code === '23503');
  });
});
