import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { completeConfig } from './campaign-fixtures.js';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, loginAdmin, startTestServer } from './helpers.js';
import { uploadedId } from './media-fixtures.js';
import { MAX_TEMPLATES } from '../src/modules/automation/one-click.service.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, campaignPublish: 1000, oneClickRead: 1000, oneClickWrite: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
const BASE = '/api/automation/one-click';
let counter = 0;
const emailOf = () => `oneclick${++counter}@example.com`;

describe('Campanha one-click: configurações reutilizáveis que publicam em várias contas', () => {
  let ctx;
  let fake;
  let mailer;
  before(async () => {
    fake = createFakeTiktok();
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, mailer, fetchFn: fake.fetchFn });
    const admin = await loginAdmin(ctx);
    assert.equal((await admin.post('/api/tiktok/business-centers', { name: 'Loja Matriz', bcId: '111', accessToken: GOOD_TOKEN, shared: true })).status, 201);
  });
  after(() => ctx.stop());

  const newUser = (name = 'Ana') => createUser(ctx, { approve: true, name, email: emailOf() });
  /** Configuração completa de verdade (com um vídeo do próprio usuário). */
  const configFor = async (client, objective = 'TRAFFIC', over = {}) => {
    const video = await uploadedId(client, { type: 'mp4' });
    return completeConfig(objective, { ...over, ad: { videoCreativeId: video, ...over.ad } });
  };
  const save = async (client, name, over = {}) => client.post(BASE, { name, config: await configFor(client, 'TRAFFIC', over) });
  const withArea = async (owner, areas) => {
    const email = emailOf();
    await owner.client.post('/api/team/invites', { email, name: 'Colaborador Teste', areas });
    const client = ctx.client();
    const accepted = await client.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
    client.csrf = accepted.json.csrfToken;
    return client;
  };

  it('exige login', async () => {
    assert.equal((await ctx.client().get(BASE)).status, 401);
    assert.equal((await ctx.client().post(BASE, {})).status, 401);
  });

  it('salva uma configuração completa, com nome e objetivo, e ela aparece na lista (mais nova primeiro)', async () => {
    const { client } = await newUser();
    assert.deepEqual((await client.get(BASE)).json, { templates: [] });
    const a = await save(client, 'Campanha para o Brasil');
    assert.equal(a.status, 201, a.text);
    assert.equal(a.json.template.name, 'Campanha para o Brasil');
    assert.equal(a.json.template.objective, 'TRAFFIC');
    assert.ok(a.json.template.id && a.json.template.createdAt && a.json.template.config.campaign.objective === 'TRAFFIC');
    await save(client, 'Campanha para Estados Unidos');
    assert.deepEqual((await client.get(BASE)).json.templates.map((t) => t.name), ['Campanha para Estados Unidos', 'Campanha para o Brasil']);
    assert.equal((await client.get(`${BASE}/${a.json.template.id}`)).json.template.name, 'Campanha para o Brasil');
  });

  it('o nome é arrumado (espaços) e validado: curto, longo ou com caracteres de controle é recusado', async () => {
    const { client } = await newUser();
    const config = await configFor(client);
    assert.equal((await client.post(BASE, { name: '  Campanha   EUA  ', config })).json.template.name, 'Campanha EUA');
    for (const name of ['', 'a', 'x'.repeat(61), 'Ruim\u0007nome', null, 42, ['x']]) {
      const res = await client.post(BASE, { name, config });
      assert.equal(res.status, 400, `${JSON.stringify(name)} deveria ser recusado`);
    }
  });

  it('o nome é único por pessoa, sem diferenciar maiúsculas; outra pessoa pode usar o mesmo nome', async () => {
    const a = await newUser('Ana');
    const b = await newUser('Beto');
    assert.equal((await save(a.client, 'Black Friday')).status, 201);
    const dup = await save(a.client, 'BLACK friday');
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, 'template_name_taken');
    assert.equal((await save(b.client, 'Black Friday')).status, 201);
  });

  it('só salva configuração COMPLETA: faltando campo obrigatório volta 400 com o caminho do campo', async () => {
    const { client } = await newUser();
    const config = await configFor(client);
    delete config.adGroup.name;
    const res = await client.post(BASE, { name: 'Incompleta', config });
    assert.equal(res.status, 400);
    assert.ok(res.json.error.details.some((d) => d.path === 'adGroup.name'), res.text);
    assert.equal((await client.post(BASE, { name: 'Sem config' })).status, 400);
    assert.equal((await client.post(BASE, { name: 'Config ruim', config: 'texto' })).status, 400);
    assert.deepEqual((await client.get(BASE)).json.templates, []);
  });

  it('criativo de OUTRA pessoa é recusado (nunca aceita ID de terceiros)', async () => {
    const owner = await newUser('Dona');
    const thief = await newUser('Intrusa');
    const foreign = await uploadedId(owner.client, { type: 'mp4' });
    const res = await thief.client.post(BASE, { name: 'Roubada', config: completeConfig('TRAFFIC', { ad: { videoCreativeId: foreign } }) });
    assert.equal(res.status, 400, res.text);
    assert.deepEqual((await thief.client.get(BASE)).json.templates, []);
  });

  it('edita: troca nome e configuração; nome repetido de outra configuração é recusado', async () => {
    const { client } = await newUser();
    const a = (await save(client, 'Um')).json.template;
    await save(client, 'Dois');
    const config = await configFor(client, 'TRAFFIC', { campaign: { name: 'Nome novo da campanha' } });
    const edited = await client.put(`${BASE}/${a.id}`, { name: 'Um editado', config });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.json.template.name, 'Um editado');
    assert.equal(edited.json.template.config.campaign.name, 'Nome novo da campanha');
    assert.equal((await client.put(`${BASE}/${a.id}`, { name: 'dois', config })).status, 409);
    assert.equal((await client.put(`${BASE}/${a.id}`, { name: 'Um editado', config })).status, 200, 'manter o próprio nome é permitido');
    assert.equal((await client.put(`${BASE}/999999`, { name: 'Nada', config })).status, 404);
  });

  it('apaga: some da lista; apagar de novo é 404; ids inválidos são 400', async () => {
    const { client } = await newUser();
    const { id } = (await save(client, 'Para apagar')).json.template;
    assert.equal((await client.delete(`${BASE}/${id}`)).status, 204);
    assert.deepEqual((await client.get(BASE)).json.templates, []);
    assert.equal((await client.delete(`${BASE}/${id}`)).status, 404);
    assert.equal((await client.get(`${BASE}/${id}`)).status, 404);
    for (const bad of ['abc', '0', '-1', '1.5']) assert.equal((await client.get(`${BASE}/${bad}`)).status, 400, bad);
  });

  it('isolamento: ninguém vê, edita, apaga ou publica as configurações de outra pessoa (sempre 404)', async () => {
    const a = await newUser('Ana');
    const b = await newUser('Beto');
    const { id } = (await save(a.client, 'Da Ana')).json.template;
    assert.deepEqual((await b.client.get(BASE)).json.templates, []);
    assert.equal((await b.client.get(`${BASE}/${id}`)).status, 404);
    assert.equal((await b.client.put(`${BASE}/${id}`, { name: 'Do Beto', config: await configFor(b.client) })).status, 404);
    assert.equal((await b.client.delete(`${BASE}/${id}`)).status, 404);
    assert.equal((await b.client.post(`${BASE}/${id}/launch`, {})).status, 404);
    assert.equal((await a.client.get(`${BASE}/${id}`)).json.template.name, 'Da Ana');
  });

  it(`limite de ${MAX_TEMPLATES} configurações por pessoa`, async () => {
    const { client } = await newUser();
    const config = await configFor(client);
    for (let i = 0; i < MAX_TEMPLATES; i += 1) assert.equal((await client.post(BASE, { name: `Config ${i}`, config })).status, 201, `config ${i}`);
    const over = await client.post(BASE, { name: 'Uma a mais', config });
    assert.equal(over.status, 409);
    assert.equal(over.json.error.code, 'template_limit');
    const first = (await client.get(BASE)).json.templates.at(-1);
    assert.equal((await client.delete(`${BASE}/${first.id}`)).status, 204);
    assert.equal((await client.post(BASE, { name: 'Agora cabe', config })).status, 201);
  });

  it('publicar: cria uma campanha NOVA (rascunho) a cada vez e a configuração continua intacta e reutilizável', async () => {
    const { client } = await newUser();
    const { id } = (await save(client, 'Campanha para o Brasil', { campaign: { name: 'Minha campanha BR' } })).json.template;
    const one = await client.post(`${BASE}/${id}/launch`, {});
    const two = await client.post(`${BASE}/${id}/launch`, {});
    assert.equal(one.status, 201, one.text);
    assert.equal(two.status, 201);
    assert.notEqual(one.json.campaign.id, two.json.campaign.id);
    assert.equal(one.json.campaign.name, 'Minha campanha BR');
    assert.equal(one.json.campaign.status, 'draft');
    assert.equal(one.json.campaign.wizard, true);
    assert.deepEqual(one.json.campaign.publications, []);
    assert.equal((await client.get(`${BASE}/${id}`)).status, 200, 'o modelo continua lá');
    assert.equal((await client.get('/api/campaigns')).json.campaigns.length, 2);
  });

  it('de ponta a ponta: o modelo publica em várias contas pela rota de campanhas, sempre PAUSADO, e depois publica de novo em outra conta', async () => {
    const { client } = await newUser();
    const { id } = (await save(client, 'Para os EUA')).json.template;
    fake.state.calls.length = 0;
    const first = (await client.post(`${BASE}/${id}/launch`, {})).json.campaign;
    for (const account of ['9001', '9002']) {
      const res = await client.post(`/api/campaigns/${first.id}/publish`, { confirm: true, advertiserId: account });
      assert.equal(res.status, 200, `${account}: ${res.text}`);
      assert.equal(res.json.publication.status, 'published');
    }
    assert.equal(fake.state.calls.filter((c) => c.path.includes('/campaign/create/')).length, 2);
    const detail = (await client.get(`/api/campaigns/${first.id}`)).json.campaign;
    assert.deepEqual(detail.publications.map((p) => p.advertiserId).sort(), ['9001', '9002']);
    // Segunda publicação do MESMO modelo: campanha nova, então a conta 9001 pode receber de novo (outra campanha).
    const second = (await client.post(`${BASE}/${id}/launch`, {})).json.campaign;
    assert.equal((await client.post(`/api/campaigns/${second.id}/publish`, { confirm: true, advertiserId: '9001' })).status, 200);
    assert.equal((await client.get(`${BASE}/${id}`)).status, 200);
  });

  it('se o criativo do modelo foi apagado depois, publicar avisa em vez de falhar no meio', async () => {
    const { client } = await newUser();
    const video = await uploadedId(client, { type: 'mp4' });
    const { id } = (await client.post(BASE, { name: 'Com vídeo', config: completeConfig('TRAFFIC', { ad: { videoCreativeId: video } }) })).json.template;
    assert.equal((await client.delete(`/api/creatives/${video}`)).status, 204);
    const res = await client.post(`${BASE}/${id}/launch`, {});
    assert.equal(res.status, 400, res.text);
    assert.deepEqual((await client.get('/api/campaigns')).json.campaigns, [], 'nenhuma campanha foi criada');
  });

  it('colaborador só usa com a área "Campanhas"; sem ela recebe 403 e nunca vê as configurações do dono', async () => {
    const owner = await newUser('Dono');
    await save(owner.client, 'Do dono');
    const without = await withArea(owner, ['creatives']);
    assert.equal((await without.get(BASE)).status, 403);
    assert.equal((await without.post(BASE, {})).status, 403);
    const withCampaigns = await withArea(owner, ['campaigns']);
    const list = await withCampaigns.get(BASE);
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.templates.map((t) => t.name), ['Do dono']);
  });

  it('o que o colaborador cria pertence ao dono e entra no registro de atividades com o nome de quem fez', async () => {
    const owner = await newUser('Dono');
    const collab = await withArea(owner, ['campaigns', 'creatives']);
    const config = await configFor(collab);
    const created = await collab.post(BASE, { name: 'Feita pelo colaborador', config });
    assert.equal(created.status, 201, created.text);
    assert.deepEqual((await owner.client.get(BASE)).json.templates.map((t) => t.name), ['Feita pelo colaborador']);
    await collab.post(`${BASE}/${created.json.template.id}/launch`, {});
    await collab.delete(`${BASE}/${created.json.template.id}`);
    const feed = (await owner.client.get('/api/team/activity?range=1')).json.entries;
    const actions = feed.filter((e) => e.actorName === 'Colaborador Teste' && e.action.startsWith('template.')).map((e) => e.action).sort();
    assert.deepEqual(actions, ['template.create', 'template.delete', 'template.launch']);
    const launch = feed.find((e) => e.action === 'template.launch');
    assert.equal(launch.targetName, 'Feita pelo colaborador');
    assert.ok(launch.details.link, 'o registro guarda o link de destino');
  });

  it('a tabela está protegida (RLS: a API pública do banco não enxerga as configurações)', async () => {
    const rls = await all(ctx.db, "SELECT relrowsecurity FROM pg_class WHERE relname = 'campaign_templates'");
    assert.equal(rls[0].relrowsecurity, true);
  });
});

describe('Duplicar: nome sugerido para a cópia (regra compartilhada)', () => {
  it('"X (cópia)", depois "X (cópia 2)"… sem repetir nome existente (sem diferenciar maiúsculas)', async () => {
    const { copyName } = await import('../shared/one-click.js');
    assert.equal(copyName('Dodo EUA CTV 1', []), 'Dodo EUA CTV 1 (cópia)');
    assert.equal(copyName('Dodo EUA CTV 1', ['Dodo EUA CTV 1', 'Dodo EUA CTV 1 (cópia)']), 'Dodo EUA CTV 1 (cópia 2)');
    assert.equal(copyName('Dodo', ['dodo (CÓPIA)', 'Dodo (cópia 2)']), 'Dodo (cópia 3)');
    assert.equal(copyName('A', ['Outra']), 'A (cópia)');
  });

  it('nunca passa de 60 caracteres: o nome original é encurtado para caber o sufixo', async () => {
    const { copyName, TEMPLATE_NAME_MAX } = await import('../shared/one-click.js');
    const long = 'x'.repeat(60);
    const first = copyName(long, [long]);
    assert.equal(first.length, TEMPLATE_NAME_MAX);
    assert.ok(first.endsWith(' (cópia)'));
    const second = copyName(long, [long, first]);
    assert.ok(second.length <= TEMPLATE_NAME_MAX && second.endsWith(' (cópia 2)') && second !== first);
  });

  it('o nome sugerido sempre é aceito pelo servidor (2 a 60 caracteres)', async () => {
    const { copyName, TEMPLATE_NAME_MIN, TEMPLATE_NAME_MAX } = await import('../shared/one-click.js');
    for (const name of ['Ab', 'x'.repeat(60), 'Campanha para o Brasil']) {
      const suggested = copyName(name, []);
      assert.ok(suggested.length >= TEMPLATE_NAME_MIN && suggested.length <= TEMPLATE_NAME_MAX, suggested);
    }
  });
});
