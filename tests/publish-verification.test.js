import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { completeConfig } from './campaign-fixtures.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, startTestServer } from './helpers.js';
import { uploadedId } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, campaignPublish: 1000, campaignCopies: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `pv${++counter}@example.com`;

describe('Publicar só vale se campanha, conjunto e anúncio EXISTEM no TikTok (conferência por ID)', () => {
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
    fake.state.uniqueCampaignNames = false;
    fake.state.dropCreated = new Set();
    fake.state.createdLag = 0;
    fake.state.failByIdGets = false;
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
  const publicationOf = async (client, id, advertiserId = '9001') => (await client.get(`/api/campaigns/${id}`)).json.campaign.publications.find((p) => p.advertiserId === advertiserId);
  const gets = () => fake.state.calls.filter((c) => ['/campaign/get/', '/adgroup/get/', '/ad/get/'].includes(c.path));

  it('publicação normal: confere os TRÊS níveis por ID no TikTok e responde verified: true', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    const res = await publish(user.client, id, { activate: true });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.verified, true);
    assert.deepEqual(gets().map((c) => c.path), ['/campaign/get/', '/adgroup/get/', '/ad/get/']);
    const ids = res.json.publication;
    const asked = Object.fromEntries(gets().map((c) => [c.path, JSON.parse(c.query.filtering)]));
    assert.deepEqual(asked['/campaign/get/'].campaign_ids, [ids.tiktokCampaignId]);
    assert.deepEqual(asked['/adgroup/get/'].adgroup_ids, [ids.tiktokAdGroupId]);
    assert.deepEqual(asked['/ad/get/'].ad_ids, [ids.tiktokAdId]);
    assert.ok(Object.values(asked).every((f) => f.primary_status === 'STATUS_NOT_DELETE'), 'o que foi excluído não conta');
    assert.ok(gets().every((c) => c.query.advertiser_id === '9001'));
  });

  it('o TikTok perde o conjunto de anúncios (ele responde o ID mas não cria): o anúncio é recusado, o ID do conjunto fantasma NÃO fica guardado como válido e a nova tentativa recria só o que falta', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    fake.state.dropCreated = new Set(['adgroup']);
    const res = await publish(user.client, id);
    assert.equal(res.status, 502, res.text);
    assert.match(res.json.error.message, /ad group does not exist/, 'o erro do TikTok aparece (nada de "publicada")');
    const saved = await publicationOf(user.client, id);
    assert.equal(saved.status, 'partial', 'não ficou como publicada');
    assert.ok(saved.tiktokCampaignId, 'a campanha existe e é guardada');
    // o TikTok volta a funcionar: a nova tentativa confere o que estava guardado, descarta o conjunto que não existe e cria só o grupo e o anúncio, na MESMA campanha
    fake.state.dropCreated = new Set();
    fake.state.calls.length = 0;
    const retry = await publish(user.client, id);
    assert.equal(retry.status, 200, retry.text);
    assert.equal(fake.callsTo('/campaign/create/').length, 0, 'não criou outra campanha');
    assert.equal(fake.callsTo('/adgroup/create/').length, 1);
    assert.equal(fake.callsTo('/adgroup/create/')[0].body.campaign_id, saved.tiktokCampaignId);
    assert.equal(fake.callsTo('/ad/create/').length, 1);
    assert.equal(retry.json.publication.status, 'published');
    assert.equal(retry.json.verified, true);
  });

  it('só o anúncio some: o erro diz que falta o anúncio e a nova tentativa recria apenas ele', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    fake.state.dropCreated = new Set(['ad']);
    const res = await publish(user.client, id);
    assert.equal(res.status, 502);
    assert.match(res.json.error.message, /não encontramos o anúncio na conta/);
    assert.doesNotMatch(res.json.error.message, /conjunto|campanha na conta/);
    const saved = await publicationOf(user.client, id);
    assert.ok(saved.tiktokCampaignId && saved.tiktokAdGroupId);
    assert.equal(saved.tiktokAdId, null);
    fake.state.dropCreated = new Set();
    fake.state.calls.length = 0;
    assert.equal((await publish(user.client, id)).status, 200);
    assert.deepEqual([fake.callsTo('/campaign/create/').length, fake.callsTo('/adgroup/create/').length, fake.callsTo('/ad/create/').length], [0, 0, 1]);
  });

  it('a campanha some (o TikTok responde o ID mas não cria): o erro aparece e a nova tentativa percebe que o ID guardado não existe e recria TUDO, em vez de confiar nele', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    fake.state.dropCreated = new Set(['campaign']);
    const res = await publish(user.client, id);
    assert.equal(res.status, 502);
    assert.match(res.json.error.message, /campaign does not exist/);
    fake.state.dropCreated = new Set();
    fake.state.calls.length = 0;
    const retry = await publish(user.client, id);
    assert.equal(retry.status, 200, retry.text);
    assert.deepEqual([fake.callsTo('/campaign/create/').length, fake.callsTo('/adgroup/create/').length, fake.callsTo('/ad/create/').length], [1, 1, 1], 'recriou os três: o ID antigo da campanha era fantasma');
    assert.equal(retry.json.verified, true);
  });

  it('atraso normal do TikTok para listar o que acabou de criar: a conferência tenta de novo e publica sem falso erro', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    fake.state.createdLag = 2; // cada nível só aparece depois de 2 consultas
    const res = await publish(user.client, id);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.verified, true);
    assert.ok(gets().length > 3, 'precisou consultar mais de uma vez');
    assert.equal(fake.callsTo('/campaign/create/').length, 1, 'e não criou nada em duplicidade');
  });

  it('a conferência não consegue rodar (consulta falha): publica e AVISA que não foi conferida (verified: false), sem bloquear', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    fake.state.failByIdGets = true;
    const res = await publish(user.client, id);
    fake.state.failByIdGets = false;
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.verified, false);
    assert.equal(res.json.publication.status, 'published');
  });

  it('"já publicada" que o TikTok não tem mais (excluída lá): a nova tentativa percebe, recria o que faltou e conclui', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    const first = await publish(user.client, id);
    assert.equal(first.status, 200);
    const original = first.json.publication;
    fake.deleteCreated('adgroups', original.tiktokAdGroupId); // alguém excluiu o grupo e o anúncio no TikTok
    fake.deleteCreated('ads', original.tiktokAdId);
    fake.state.calls.length = 0;
    const again = await publish(user.client, id);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.publication.tiktokCampaignId, original.tiktokCampaignId, 'a campanha que ainda existia é mantida');
    assert.notEqual(again.json.publication.tiktokAdGroupId, original.tiktokAdGroupId, 'o grupo foi recriado');
    assert.deepEqual([fake.callsTo('/campaign/create/').length, fake.callsTo('/adgroup/create/').length, fake.callsTo('/ad/create/').length], [0, 1, 1]);
  });

  it('"já publicada" que continua existindo: 409 como sempre (só consultas de leitura, nada criado)', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    await publish(user.client, id);
    fake.state.calls.length = 0;
    const again = await publish(user.client, id);
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, 'already_published');
    assert.equal(fake.state.calls.filter((c) => c.path.endsWith('/create/')).length, 0);
  });

  it('retomada com IDs guardados que não existem mais no TikTok (excluídos lá): a conferência os descarta ANTES e recria, em vez de pular o nível e dar "publicada"', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    fake.state.failCreate.add('ad');
    assert.notEqual((await publish(user.client, id)).status, 200, 'a primeira tentativa cria campanha e conjunto e falha no anúncio');
    fake.state.failCreate.clear();
    const partial = await publicationOf(user.client, id);
    assert.ok(partial.tiktokCampaignId && partial.tiktokAdGroupId);
    fake.deleteCreated('campaigns', partial.tiktokCampaignId); // alguém exclui a campanha (e com ela o conjunto) no TikTok
    fake.deleteCreated('adgroups', partial.tiktokAdGroupId);
    fake.state.calls.length = 0;
    const retry = await publish(user.client, id);
    assert.equal(retry.status, 200, retry.text);
    assert.deepEqual([fake.callsTo('/campaign/create/').length, fake.callsTo('/adgroup/create/').length, fake.callsTo('/ad/create/').length], [1, 1, 1], 'recriou os três');
    assert.notEqual(retry.json.publication.tiktokCampaignId, partial.tiktokCampaignId);
    assert.equal(retry.json.verified, true);
  });

  // ---------- "Conferir no TikTok" ----------
  const verify = (client, id, body = {}) => client.post(`/api/campaigns/${id}/verify`, body);

  it('Conferir no TikTok: publicação inteira existente => "ok", e nada muda', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    const published = (await publish(user.client, id)).json.publication;
    fake.state.calls.length = 0;
    const res = await verify(user.client, id);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.results, [{ advertiserId: '9001', state: 'ok', missing: [] }]);
    assert.deepEqual(await publicationOf(user.client, id), { ...published });
    assert.equal(fake.state.calls.filter((c) => c.path.endsWith('/create/') || c.path.endsWith('/update/')).length, 0, 'só consultas de leitura');
  });

  it('Conferir no TikTok: conjunto e anúncio sumiram => a conta volta para "tentar de novo" (parcial, só com a campanha) e publicar de novo recria só o que falta', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    const published = (await publish(user.client, id)).json.publication;
    fake.deleteCreated('adgroups', published.tiktokAdGroupId);
    fake.deleteCreated('ads', published.tiktokAdId);
    const res = await verify(user.client, id);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.results, [{ advertiserId: '9001', state: 'missing', missing: ['adGroup', 'ad'] }]);
    const saved = await publicationOf(user.client, id);
    assert.equal(saved.status, 'partial');
    assert.equal(saved.tiktokCampaignId, published.tiktokCampaignId, 'a campanha que existe é mantida');
    assert.deepEqual([saved.tiktokAdGroupId, saved.tiktokAdId], [null, null]);
    assert.match(saved.error, /não encontrou tudo/);
    fake.state.calls.length = 0;
    const again = await publish(user.client, id);
    assert.equal(again.status, 200, again.text);
    assert.deepEqual([fake.callsTo('/campaign/create/').length, fake.callsTo('/adgroup/create/').length, fake.callsTo('/ad/create/').length], [0, 1, 1]);
  });

  it('Conferir no TikTok: a campanha toda sumiu => solta os três IDs', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    const published = (await publish(user.client, id)).json.publication;
    for (const [kind, key] of [['campaigns', 'tiktokCampaignId'], ['adgroups', 'tiktokAdGroupId'], ['ads', 'tiktokAdId']]) fake.deleteCreated(kind, published[key]);
    const res = await verify(user.client, id, { advertiserId: '9001' });
    assert.deepEqual(res.json.results[0], { advertiserId: '9001', state: 'missing', missing: ['campaign', 'adGroup', 'ad'] });
    const saved = await publicationOf(user.client, id);
    assert.deepEqual([saved.tiktokCampaignId, saved.tiktokAdGroupId, saved.tiktokAdId, saved.status], [null, null, null, 'failed']);
  });

  it('Conferir no TikTok: a consulta falha => "unverified" e NADA é alterado (não apaga o registro por não conseguir ler)', async () => {
    const user = await owner();
    const { id } = await draft(user.client);
    const published = (await publish(user.client, id)).json.publication;
    fake.state.failByIdGets = true;
    const res = await verify(user.client, id);
    fake.state.failByIdGets = false;
    assert.deepEqual(res.json.results, [{ advertiserId: '9001', state: 'unverified', missing: [] }]);
    assert.deepEqual(await publicationOf(user.client, id), published, 'o registro ficou intacto');
  });

  it('Conferir no TikTok: confere todas as contas publicadas, uma a uma; conta sem publicação é 404; pedido inválido é 400; só o dono; exige login', async () => {
    const user = await owner();
    const other = await createUser(ctx, { approve: true, email: emailOf() });
    const { id } = await draft(user.client);
    await publish(user.client, id, {}, '9001');
    const second = (await publish(user.client, id, {}, '9002')).json.publication;
    fake.deleteCreated('ads', second.tiktokAdId);
    const all2 = await verify(user.client, id);
    assert.deepEqual(all2.json.results.map((r) => [r.advertiserId, r.state]), [['9001', 'ok'], ['9002', 'missing']]);
    assert.equal((await verify(user.client, id, { advertiserId: '9101' })).status, 404, 'não publicada nessa conta');
    for (const bad of ['abc', 9001, [], {}]) assert.equal((await verify(user.client, id, { advertiserId: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await verify(user.client, 999999)).status, 404);
    assert.equal((await verify(other.client, id)).status, 404, 'campanha de outra pessoa');
    assert.equal((await ctx.client().post(`/api/campaigns/${id}/verify`, {})).status, 401);
  });

  it('cada cópia é conferida separadamente: se o TikTok perde uma, só ela falha e as outras ficam publicadas', async () => {
    const user = await owner();
    const original = await draft(user.client);
    const copies = (await user.client.post(`/api/campaigns/${original.id}/copies`, { count: 3 })).json.campaigns;
    const results = [];
    for (const [index, copy] of copies.entries()) {
      fake.state.dropCreated = index === 1 ? new Set(['ad']) : new Set(); // a cópia 02 perde o anúncio (responde o ID mas não cria)
      results.push((await publish(user.client, copy.id)).status);
    }
    fake.state.dropCreated = new Set();
    assert.deepEqual(results, [200, 502, 200]);
    const rows = await all(ctx.db, 'SELECT c.name, p.tiktok_adgroup_id IS NOT NULL AS has_group, p.tiktok_ad_id IS NOT NULL AS has_ad FROM campaigns c JOIN campaign_publications p ON p.campaign_id = c.id WHERE c.id = ANY($1::int[]) ORDER BY c.name', [copies.map((c) => c.id)]);
    assert.deepEqual(rows.map((r) => [r.name, r.has_group, r.has_ad]), [['Black Friday 01', true, true], ['Black Friday 02', true, false], ['Black Friday 03', true, true]]);
  });
});
