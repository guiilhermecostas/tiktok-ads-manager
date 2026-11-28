import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MAX_COPIES } from '../shared/campaign-copies.js';
import { completeConfig } from './campaign-fixtures.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, run, startTestServer } from './helpers.js';
import { uploadedId } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, campaignPublish: 1000, campaignCopies: 1000, oneClickRead: 1000, oneClickWrite: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `cc${++counter}@example.com`;

describe('Várias campanhas iguais por conta e publicar já ativa (API)', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer: createFakeMailer() });
  });
  after(() => ctx.stop());

  async function owner() {
    const user = await createUser(ctx, { approve: true, email: emailOf() });
    fake.state.bcs = { 111: ['9001', '9002'] };
    fake.state.uniqueCampaignNames = true;
    fake.state.campaignNamesByAdvertiser = {};
    fake.state.failCreate.clear();
    fake.state.calls.length = 0;
    await user.client.post('/api/tiktok/business-centers', { name: 'BC 111', bcId: '111', accessToken: GOOD_TOKEN });
    return user;
  }
  const draft = async (client, name = 'Black Friday') => {
    const video = await uploadedId(client, { type: 'mp4' });
    return (await client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { campaign: { name }, ad: { videoCreativeId: video } }) })).json.campaign;
  };
  const publish = (client, id, body = {}, advertiserId = '9001') => client.post(`/api/campaigns/${id}/publish`, { confirm: true, advertiserId, ...body });
  const statusOf = (path) => fake.callsTo(path).map((c) => c.body.operation_status ?? c.body.creatives?.[0]?.operation_status);

  // ---------- publicar já ativa ----------
  it('com activate: true, campanha, grupo e anúncio nascem ATIVOS e a campanha local fica "ativa"', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    const res = await publish(user.client, id, { activate: true });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.activated, true);
    assert.equal(res.json.campaign.status, 'active');
    assert.deepEqual([statusOf('/campaign/create/'), statusOf('/adgroup/create/'), statusOf('/ad/create/')], [['ENABLE'], ['ENABLE'], ['ENABLE']]);
  });

  it('sem a escolha (ou com activate: false) continua PAUSADA, como sempre foi o padrão da API', async () => {
    const user = await owner();
    const a = await draft(user.client);
    const b = await draft(user.client, 'Outra');
    const first = await publish(user.client, a.id);
    const second = await publish(user.client, b.id, { activate: false });
    assert.deepEqual([first.json.activated, first.json.campaign.status, second.json.activated, second.json.campaign.status], [false, 'paused', false, 'paused']);
    assert.deepEqual([statusOf('/campaign/create/'), statusOf('/adgroup/create/'), statusOf('/ad/create/')], [['DISABLE', 'DISABLE'], ['DISABLE', 'DISABLE'], ['DISABLE', 'DISABLE']]);
  });

  it('activate precisa ser verdadeiro ou falso (qualquer outra coisa é 400 e nada é criado)', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    for (const bad of ['true', 'sim', 1, 0, null, {}, []]) assert.equal((await publish(user.client, id, { activate: bad })).status, 400, JSON.stringify(bad));
    assert.equal(fake.callsTo('/campaign/create/').length, 0);
  });

  it('retomada: o que foi criado PAUSADO numa tentativa anterior é ativado quando a nova tentativa pede ativa (e o contrário também)', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    fake.state.failCreate.add('ad');
    assert.notEqual((await publish(user.client, id)).status, 200, 'a primeira tentativa (pausada) falha no anúncio');
    fake.state.failCreate.clear();
    fake.state.calls.length = 0;
    const res = await publish(user.client, id, { activate: true });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.campaign.status, 'active');
    assert.deepEqual(statusOf('/ad/create/'), ['ENABLE'], 'o anúncio novo nasce ativo');
    assert.deepEqual(fake.callsTo('/campaign/status/update/').map((c) => c.body.operation_status), ['ENABLE'], 'a campanha que já existia foi ativada');
    assert.deepEqual(fake.callsTo('/adgroup/status/update/').map((c) => c.body.operation_status), ['ENABLE'], 'o grupo que já existia foi ativado');
    assert.equal(fake.callsTo('/ad/status/update/').length, 0, 'o anúncio foi criado agora: não precisa de ajuste');
  });

  it('campanha que sobrou de uma tentativa que falhou e é reaproveitada também é ativada', async () => {
    const user = await owner();
    const a = await draft(user.client);
    fake.state.failCreate.add('adGroup');
    await publish(user.client, a.id); // sobra a campanha, pausada
    fake.state.failCreate.clear();
    fake.state.calls.length = 0;
    const b = await draft(user.client);
    const res = await publish(user.client, b.id, { activate: true });
    assert.equal(res.status, 200, res.text);
    assert.equal(fake.callsTo('/campaign/create/').length, 0, 'reaproveitou a campanha');
    assert.deepEqual(fake.callsTo('/campaign/status/update/').map((c) => c.body.operation_status), ['ENABLE']);
    assert.deepEqual([statusOf('/adgroup/create/'), statusOf('/ad/create/')], [['ENABLE'], ['ENABLE']]);
  });

  it('entra no registro de atividades como "Publicada já ativa" ou "Publicada pausada"', async () => {
    const user = await owner();
    const a = await draft(user.client);
    const b = await draft(user.client, 'Pausada');
    await publish(user.client, a.id, { activate: true });
    await publish(user.client, b.id);
    let entries = [];
    for (let i = 0; i < 40 && entries.length < 2; i += 1) {
      entries = (await user.client.get('/api/team/activity?range=365')).json.entries.filter((e) => e.action === 'campaign.publish');
      if (entries.length < 2) await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    assert.deepEqual(entries.map((e) => [e.targetName, e.details.status]).sort(), [['Black Friday', 'Publicada já ativa'], ['Pausada', 'Publicada pausada']]);
  });

  // ---------- várias campanhas iguais ----------
  it('cria as cópias de uma campanha: rascunhos novos com nome numerado, a original não muda', async () => {
    const user = await owner();
    const original = await draft(user.client);
    const res = await user.client.post(`/api/campaigns/${original.id}/copies`, { count: 3 });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.json.campaigns.map((c) => c.name), ['Black Friday 01', 'Black Friday 02', 'Black Friday 03']);
    for (const copy of res.json.campaigns) {
      const saved = (await user.client.get(`/api/campaigns/${copy.id}`)).json.campaign;
      assert.equal(saved.name, copy.name);
      assert.equal(saved.config.campaign.name, copy.name, 'o nome que vai ao TikTok é o da cópia');
      assert.equal(saved.status, 'draft');
      assert.deepEqual({ ...saved.config, campaign: { ...saved.config.campaign, name: 'Black Friday' } }, (await user.client.get(`/api/campaigns/${original.id}`)).json.campaign.config, 'o resto da configuração é idêntico');
    }
    assert.equal((await user.client.get(`/api/campaigns/${original.id}`)).json.campaign.name, 'Black Friday', 'a original não mudou');
  });

  it('valida a quantidade (2 a 10), o dono e o tipo da campanha', async () => {
    const user = await owner();
    const other = await createUser(ctx, { approve: true, email: emailOf() });
    const { id } = await draft(user.client);
    for (const count of [undefined, 0, 1, MAX_COPIES + 1, -2, 2.5, '3', null, [], {}]) assert.equal((await user.client.post(`/api/campaigns/${id}/copies`, { count })).status, 400, JSON.stringify(count));
    assert.equal((await user.client.post(`/api/campaigns/${id}/copies`, { count: MAX_COPIES })).status, 201, '10 é o limite');
    assert.equal((await user.client.post('/api/campaigns/999999/copies', { count: 2 })).status, 404);
    assert.equal((await other.client.post(`/api/campaigns/${id}/copies`, { count: 2 })).status, 404, 'campanha de outra pessoa');
    assert.equal((await ctx.client().post(`/api/campaigns/${id}/copies`, { count: 2 })).status, 401);
    const legacy = (await user.client.post('/api/campaigns', { name: 'Antiga', objective: 'TRAFFIC', dailyBudget: 1000 })).json.campaign;
    assert.equal((await user.client.post(`/api/campaigns/${legacy.id}/copies`, { count: 2 })).status, 400, 'campanha do formato antigo não tem configuração para copiar');
    const incomplete = (await user.client.post('/api/campaigns', { config: { campaign: { name: 'Incompleta', objective: 'TRAFFIC' } } })).json.campaign;
    assert.equal((await user.client.post(`/api/campaigns/${incomplete.id}/copies`, { count: 2 })).status, 400, 'configuração incompleta não é copiada');
  });

  it('a configuração one-click cria N campanhas iguais de uma vez (launch com count); sem count continua sendo 1 com o nome original', async () => {
    const user = await owner();
    const video = await uploadedId(user.client, { type: 'mp4' });
    const template = (await user.client.post('/api/automation/one-click', { name: 'Campanha para Teste', config: completeConfig('TRAFFIC', { campaign: { name: 'Fatias de público' }, ad: { videoCreativeId: video } }) })).json.template;
    const one = await user.client.post(`/api/automation/one-click/${template.id}/launch`);
    assert.equal(one.status, 201, one.text);
    assert.equal(one.json.campaigns.length, 1);
    assert.equal(one.json.campaign.name, 'Fatias de público');
    const five = await user.client.post(`/api/automation/one-click/${template.id}/launch`, { count: 5 });
    assert.equal(five.status, 201, five.text);
    assert.deepEqual(five.json.campaigns.map((c) => c.name), ['Fatias de público 01', 'Fatias de público 02', 'Fatias de público 03', 'Fatias de público 04', 'Fatias de público 05']);
    assert.equal(five.json.campaign.id, five.json.campaigns[0].id, '`campaign` é a primeira (compatibilidade)');
    assert.ok(five.json.campaigns.every((c) => c.config.campaign.name === c.name));
    for (const bad of [0, MAX_COPIES + 1, 2.5, '3', null, -1]) assert.equal((await user.client.post(`/api/automation/one-click/${template.id}/launch`, { count: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await user.client.post(`/api/automation/one-click/${template.id}/launch`, { count: MAX_COPIES })).json.campaigns.length, MAX_COPIES);
  });

  it('as cópias publicam cada uma na mesma conta com o próprio nome, sem esbarrar em "nome já existe", e cada uma já ativa', async () => {
    const user = await owner();
    const original = await draft(user.client, 'Teste de público');
    const copies = (await user.client.post(`/api/campaigns/${original.id}/copies`, { count: 3 })).json.campaigns;
    for (const copy of copies) {
      const res = await publish(user.client, copy.id, { activate: true });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.renamedTo, undefined, 'os nomes numerados já são únicos');
    }
    assert.deepEqual(fake.callsTo('/campaign/create/').map((c) => c.body.campaign_name), ['Teste de público 01', 'Teste de público 02', 'Teste de público 03']);
    assert.deepEqual(statusOf('/campaign/create/'), ['ENABLE', 'ENABLE', 'ENABLE']);
    const rows = await all(ctx.db, "SELECT name, status FROM campaigns WHERE name LIKE 'Teste de público%' ORDER BY name");
    assert.deepEqual(rows.map((r) => [r.name, r.status]), [['Teste de público', 'draft'], ['Teste de público 01', 'active'], ['Teste de público 02', 'active'], ['Teste de público 03', 'active']]);
    await run(ctx.db, "DELETE FROM campaigns WHERE name LIKE 'Teste de público%'");
  });
});

describe('Cópias: limite de pedidos', () => {
  let ctx;
  before(async () => {
    ctx = await startTestServer({ limits: { ...LIMITS, campaignCopies: 2 }, config: { mail: MAIL_CONFIG }, mailer: createFakeMailer() });
  });
  after(() => ctx.stop());

  it('depois de poucos pedidos seguidos o servidor responde 429', async () => {
    const user = await createUser(ctx, { approve: true, email: emailOf() });
    const video = await uploadedId(user.client, { type: 'mp4' });
    const { id } = (await user.client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { ad: { videoCreativeId: video } }) })).json.campaign;
    assert.equal((await user.client.post(`/api/campaigns/${id}/copies`, { count: 2 })).status, 201);
    assert.equal((await user.client.post(`/api/campaigns/${id}/copies`, { count: 2 })).status, 201);
    assert.equal((await user.client.post(`/api/campaigns/${id}/copies`, { count: 2 })).status, 429);
  });
});
