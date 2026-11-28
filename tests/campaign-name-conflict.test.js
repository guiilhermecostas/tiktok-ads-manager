import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { numberedName } from '../src/modules/tiktok/tiktok.service.js';
import { completeConfig } from './campaign-fixtures.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, startTestServer } from './helpers.js';
import { uploadedId } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, campaignPublish: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `cn${++counter}@example.com`;

describe('Nome de campanha repetido (regras)', () => {
  it('numera o nome ("Nome (2)") sem passar do limite de 100 caracteres', () => {
    assert.equal(numberedName('Black Friday', 2), 'Black Friday (2)');
    assert.equal(numberedName('Black Friday', 12), 'Black Friday (12)');
    const long = 'x'.repeat(100);
    for (const n of [2, 9, 10, 20]) {
      const name = numberedName(long, n);
      assert.ok(name.length <= 100, `${n}: ${name.length}`);
      assert.ok(name.endsWith(` (${n})`));
    }
    assert.equal(numberedName('A  ', 2), 'A (2)', 'não deixa espaço sobrando antes do número');
  });
});

describe('Publicar com nome de campanha que já existe na conta (API)', () => {
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
    fake.state.failCampaignMessage = '';
    fake.state.failForAdvertiser.clear();
    fake.state.calls.length = 0;
    await user.client.post('/api/tiktok/business-centers', { name: 'BC 111', bcId: '111', accessToken: GOOD_TOKEN });
    return user;
  }
  const draft = async (client, name = 'Black Friday', over = {}) => {
    const video = await uploadedId(client, { type: 'mp4' });
    return (await client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { campaign: { name, ...over.campaign }, ad: { videoCreativeId: video } }) })).json.campaign;
  };
  const publish = (client, id, advertiserId = '9001') => client.post(`/api/campaigns/${id}/publish`, { confirm: true, advertiserId });
  const campaignNames = (adv) => fake.callsTo('/campaign/create/').filter((c) => c.body.advertiser_id === adv).map((c) => c.body.campaign_name);

  it('o nome já existe na conta (outra rodada concluída): publica como "Nome (2)", "Nome (3)" e avisa; em outra conta o nome não muda', async () => {
    const user = await owner();
    const [a, b, c] = [await draft(user.client), await draft(user.client), await draft(user.client)];
    const first = await publish(user.client, a.id);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.renamedTo, undefined, 'o primeiro usa o nome pedido');
    const second = await publish(user.client, b.id);
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.renamedTo, 'Black Friday (2)');
    assert.equal((await publish(user.client, c.id)).json.renamedTo, 'Black Friday (3)');
    assert.deepEqual(campaignNames('9001'), ['Black Friday', 'Black Friday', 'Black Friday (2)', 'Black Friday', 'Black Friday (2)', 'Black Friday (3)'], 'cada nome repetido foi recusado pelo TikTok e tentado de novo com o número');
    const other = await publish(user.client, b.id, '9002');
    assert.equal(other.status, 200, other.text);
    assert.equal(other.json.renamedTo, undefined, 'em outra conta o nome estava livre');
    assert.equal(campaignNames('9002').at(-1), 'Black Friday');
    assert.equal(second.json.publication.status, 'published');
  });

  it('o rascunho local não muda de nome (só o que vai ao TikTok é numerado)', async () => {
    const user = await owner();
    const [a, b] = [await draft(user.client), await draft(user.client)];
    await publish(user.client, a.id);
    await publish(user.client, b.id);
    const saved = (await user.client.get(`/api/campaigns/${b.id}`)).json.campaign;
    assert.equal(saved.name, 'Black Friday');
    assert.equal(saved.config.campaign.name, 'Black Friday');
  });

  it('tentativa anterior parou depois de criar a campanha e antes do grupo: a nova rodada (outro rascunho, mesmo nome) REAPROVEITA a campanha, sem criar outra nem numerar', async () => {
    const user = await owner();
    const a = await draft(user.client);
    fake.state.failCreate.add('adGroup'); // o grupo falha (ex.: evento que não existe no pixel): a campanha já ficou criada no TikTok
    const failed = await publish(user.client, a.id);
    assert.notEqual(failed.status, 200);
    const orphanId = (await user.client.get(`/api/campaigns/${a.id}`)).json.campaign.publications[0].tiktokCampaignId;
    assert.ok(orphanId, 'a campanha ficou criada');
    fake.state.failCreate.clear();
    fake.state.calls.length = 0;
    const b = await draft(user.client); // a mesma configuração rodada de novo
    const ok = await publish(user.client, b.id);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.renamedTo, undefined, 'não foi numerada');
    assert.equal(fake.callsTo('/campaign/create/').length, 0, 'nenhuma campanha nova foi criada');
    assert.equal(fake.callsTo('/adgroup/create/')[0].body.campaign_id, orphanId, 'o grupo entrou na campanha que já existia');
    assert.equal(ok.json.publication.tiktokCampaignId, orphanId);
    const rows = await all(ctx.db, 'SELECT campaign_id, tiktok_campaign_id FROM campaign_publications WHERE campaign_id = ANY($1::int[]) ORDER BY campaign_id', [[a.id, b.id]]);
    assert.deepEqual(rows.map((r) => r.tiktok_campaign_id), [null, orphanId], 'a publicação antiga soltou a campanha (ninguém a reivindica duas vezes)');
  });

  it('a campanha sobrada só é reaproveitada se a parte da campanha for IDÊNTICA (outro orçamento = campanha nova, numerada)', async () => {
    const user = await owner();
    const a = await draft(user.client);
    fake.state.failCreate.add('adGroup');
    await publish(user.client, a.id);
    fake.state.failCreate.clear();
    fake.state.calls.length = 0;
    const b = await draft(user.client, 'Black Friday', { campaign: { budgetMode: 'BUDGET_MODE_DAY', budget: 9900 } });
    const ok = await publish(user.client, b.id);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.renamedTo, 'Black Friday (2)');
    assert.equal(fake.callsTo('/campaign/create/').length, 2, 'uma recusada pelo nome e uma criada com o número');
  });

  it('a campanha sobrada de OUTRA conta de anúncio ou de OUTRA pessoa nunca é reaproveitada', async () => {
    const user = await owner();
    const a = await draft(user.client);
    fake.state.failCreate.add('adGroup');
    await publish(user.client, a.id, '9001'); // sobra na conta 9001
    fake.state.failCreate.clear();
    fake.state.calls.length = 0;
    const b = await draft(user.client);
    const otherAccount = await publish(user.client, b.id, '9002');
    assert.equal(otherAccount.status, 200, otherAccount.text);
    assert.equal(fake.callsTo('/campaign/create/').length, 1, 'na conta 9002 foi criada uma campanha nova (não usou a da 9001)');
    // outra pessoa, mesma conta (BC compartilhada): não pode adotar a campanha da primeira
    const admin = await createUser(ctx, { approve: true, email: emailOf() });
    const other = admin;
    await other.client.post('/api/tiktok/business-centers', { name: 'BC 111 (outra pessoa)', bcId: '111', accessToken: GOOD_TOKEN });
    const c = await draft(other.client);
    fake.state.calls.length = 0;
    const res = await publish(other.client, c.id, '9001');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.renamedTo, 'Black Friday (2)', 'a campanha da primeira pessoa não foi adotada: o nome foi numerado');
  });

  it('erro do TikTok que não é de nome repetido segue como antes (nada é tentado de novo)', async () => {
    const user = await owner();
    const a = await draft(user.client);
    fake.state.failCreate.add('campaign');
    fake.state.failCampaignMessage = 'Invalid campaign budget for this account';
    const res = await publish(user.client, a.id);
    fake.state.failCampaignMessage = '';
    assert.notEqual(res.status, 200);
    assert.match(res.json.error.message, /Invalid campaign budget/);
    assert.equal(fake.callsTo('/campaign/create/').length, 1, 'uma única tentativa');
  });

  it('se todos os nomes numerados também estiverem ocupados, para depois de 20 tentativas com o erro do TikTok (nunca fica em laço)', async () => {
    const user = await owner();
    fake.state.campaignNamesByAdvertiser['9001'] = new Set(['Black Friday', ...Array.from({ length: 19 }, (_, i) => `Black Friday (${i + 2})`)]);
    const a = await draft(user.client);
    const res = await publish(user.client, a.id);
    assert.equal(res.status, 502, res.text);
    assert.match(res.json.error.message, /Campaign name already exists/);
    assert.equal(fake.callsTo('/campaign/create/').length, 20);
  });
});
