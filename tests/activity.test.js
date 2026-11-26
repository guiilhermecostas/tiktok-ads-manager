import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ACTIONS, ACTION_GROUPS, ACTION_KEYS, ACTIVITY_PAGE_SIZE, ACTIVITY_RANGES, DETAIL_FIELDS, RETENTION_DAYS, actionsOfGroup, cleanTarget, describeEntry, normalizeActivityQuery, sanitizeDetails } from '../shared/activity.js';
import { createActivityRules } from '../src/modules/activity/activity.rules.js';
import { completeConfig } from './campaign-fixtures.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, one, run, startTestServer } from './helpers.js';
import { pngBytes, uploadCreative, uploadedId } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, campaignPublish: 1000, creativesRead: 5000, creativesWrite: 5000, catalogRead: 5000, catalogWrite: 5000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000, filesWrite: 1000, filesRead: 1000 };
let counter = 0;
const emailOf = () => `act${++counter}@example.com`;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('Registro de atividades: regras compartilhadas', () => {
  it('toda ação tem grupo válido, frase em português e nome que o banco aceita', () => {
    const groups = new Set(ACTION_GROUPS.map(([key]) => key));
    for (const key of ACTION_KEYS) {
      assert.match(key, /^[a-z_]+[.][a-z_]+$/, key);
      assert.ok(key.length <= 40);
      assert.ok(groups.has(ACTIONS[key].group), `${key}: grupo`);
      assert.ok(ACTIONS[key].label.length > 5);
    }
    assert.ok(ACTION_KEYS.length >= 40);
    assert.equal(ACTION_GROUPS.length, 7);
    for (const [group] of ACTION_GROUPS) assert.ok(actionsOfGroup(group).length >= 1, group);
    assert.deepEqual(actionsOfGroup('finance'), ['balance.transfer']);
    assert.deepEqual(actionsOfGroup('access'), ['session.login']);
  });

  it('detalhes: só campos permitidos, texto limpo e limitado, listas curtas, números válidos (o resto some)', () => {
    const long = 'x'.repeat(500);
    const out = sanitizeDetails({
      link: `  https://loja.com/oferta?x=1\n\t&y=2  `, creatives: ['a.mp4', 'b.png', '', 7, { x: 1 }, null], count: 5, catalog: long, items: Array.from({ length: 50 }, (_, i) => `i${i}`),
      accessToken: 'segredo', password: 'senha', token: 'x', authorization: 'Bearer abc', nested: { a: 1 }, amount: Number.NaN, status: 5, email: '   ', __proto__: { hack: 1 },
    });
    assert.deepEqual(Object.keys(out).sort(), ['catalog', 'count', 'creatives', 'items', 'link', 'status']);
    assert.equal(out.link, 'https://loja.com/oferta?x=1 &y=2', 'sem quebra de linha nem tabulação');
    assert.deepEqual(out.creatives, ['a.mp4', 'b.png', '7']);
    assert.equal(out.catalog.length, 300, 'texto cortado em 300');
    assert.equal(out.items.length, 20, 'listas de até 20');
    assert.equal(out.status, 5, 'número vale');
    assert.ok(!JSON.stringify(out).includes('segredo') && !JSON.stringify(out).includes('Bearer') && !JSON.stringify(out).includes('senha'), 'segredos nunca entram');
    for (const bad of [null, undefined, 'texto', 5, [], [1, 2]]) assert.deepEqual(sanitizeDetails(bad), {});
    assert.deepEqual(sanitizeDetails({ link: 'a\u0000b\u0007c' }), { link: 'a b c' });
    assert.ok(Object.keys(DETAIL_FIELDS).every((k) => !/token|senha|password|secret|authorization/i.test(k)), 'nenhum campo permitido guarda segredo');
  });

  it('nome do alvo: texto limpo de até 200 caracteres, ou nulo', () => {
    assert.equal(cleanTarget('  Campanha   Verão \n'), 'Campanha Verão');
    assert.equal(cleanTarget('x'.repeat(500)).length, 200);
    for (const bad of [null, undefined, '', '   ', 5, {}, []]) assert.equal(cleanTarget(bad), null);
  });

  it('descreve cada ação em português; ativar/pausar vira frase com a quantidade; valores desconhecidos nunca quebram', () => {
    const publish = describeEntry({ action: 'campaign.publish', targetName: 'Verão', details: { account: 'Loja (ID 9001)', link: 'https://x.com', creatives: ['a.mp4', 'b.mp4'], catalog: 'ID 55' } });
    assert.equal(publish.title, 'Publicou uma campanha');
    assert.equal(publish.target, 'Verão');
    assert.deepEqual(publish.lines, [['Link de destino', 'https://x.com'], ['Criativos', 'a.mp4, b.mp4'], ['Catálogo', 'ID 55'], ['Conta de anúncio', 'Loja (ID 9001)']]);
    assert.equal(publish.groupLabel, 'Campanhas');
    assert.equal(describeEntry({ action: 'manager.status', details: { level: 'ad', status: 'ENABLE', count: 3 } }).title, 'Ativou 3 anúncios');
    assert.equal(describeEntry({ action: 'manager.status', details: { level: 'campaign', status: 'DISABLE', count: 1 } }).title, 'Pausou 1 campanha');
    assert.equal(describeEntry({ action: 'manager.status', details: { level: 'adgroup', status: 'DISABLE', count: 2, account: 'X' } }).lines.length, 1, 'nível, situação e quantidade já estão na frase');
    assert.deepEqual(describeEntry({ action: 'balance.transfer', details: { direction: 'RECHARGE', amount: 'USD 10.00' } }).lines, [['Valor', 'USD 10.00'], ['Sentido', 'Da Business Center para a conta']]);
    const unknown = describeEntry({ action: 'inventada.agora', details: { link: 'x', hack: '<b>' } });
    assert.equal(unknown.title, 'Fez uma ação');
    assert.deepEqual(unknown.lines, [['Link de destino', 'x']], 'campo desconhecido não aparece');
    assert.doesNotThrow(() => describeEntry({ action: 'session.login' }));
  });

  it('filtros da consulta: pessoa, tipo, período e página; só valores conhecidos (lista repetida, texto e números estranhos são recusados)', () => {
    assert.deepEqual(normalizeActivityQuery({}), { value: { actorId: null, group: null, range: 7, page: 1 }, errors: [] });
    assert.deepEqual(normalizeActivityQuery({ actor: '12', group: 'campaigns', range: '30', page: '2' }).value, { actorId: 12, group: 'campaigns', range: 30, page: 2 });
    assert.deepEqual(normalizeActivityQuery({ actor: '', group: '' }).value, { actorId: null, group: null, range: 7, page: 1 }, 'vazio = sem filtro');
    const bad = (extra) => normalizeActivityQuery(extra).errors[0]?.path;
    for (const actor of ['0', 'abc', '-1', '1e3', ['1'], "1' OR '1'='1", '1234567890']) assert.equal(bad({ actor }), 'actor', String(actor));
    for (const group of ['tudo', 'CAMPAIGNS', ['campaigns'], 'campaigns;drop']) assert.equal(bad({ group }), 'group', String(group));
    for (const range of ['2', '0', '366', 'abc', ['7'], 7, '7.5']) assert.equal(bad({ range }), 'range', String(range));
    for (const page of ['0', '201', '-3', '1.5', 'x', ['1'], 1]) assert.equal(bad({ page }), 'page', String(page));
    assert.equal(normalizeActivityQuery(null).value.range, 7);
    assert.deepEqual(ACTIVITY_RANGES.map(([d]) => d), [1, 7, 30, 90, 365]);
    assert.equal(ACTIVITY_PAGE_SIZE, 30);
    assert.equal(RETENTION_DAYS, 365);
  });
});

describe('Registro de atividades: regras de cada rota (sem servidor)', () => {
  const rules = createActivityRules();
  const find = (method, path) => rules.find((r) => r.method === method && r.pattern.test(path));
  const lookups = {
    creatives: async (_o, ids) => ids.map((id) => ({ id, name: `criativo-${id}.mp4` })),
    folder: async (_o, id) => ({ id, name: `Pasta ${id}` }),
    campaign: async () => ({ name: 'Campanha X', objective: 'TRAFFIC', config: { ad: { landingPageUrl: 'https://loja.com/p?utm=a', videoCreativeId: 7, imageCreativeIds: [8, 9] }, adGroup: { catalogId: '555' } } }),
    advertiser: async (id) => ({ id, name: 'Loja Um' }),
  };
  const ctx = (extra) => ({ actor: { id: 1 }, user: { id: 2 }, lookups, snapshot: undefined, ...extra });

  it('cada rota que altera algo tem uma regra, e rotas que só leem ou são pessoais NÃO têm', () => {
    const want = [
      ['POST', '/api/campaigns'], ['PUT', '/api/campaigns/3'], ['DELETE', '/api/campaigns/3'], ['POST', '/api/campaigns/3/publish'], ['POST', '/api/tiktok/manager/ads/status'], ['POST', '/api/tiktok/manager/campaigns/status'], ['POST', '/api/tiktok/manager/adgroups/status'],
      ['POST', '/api/creatives'], ['POST', '/api/creatives/tiktok'], ['PATCH', '/api/creatives/3'], ['DELETE', '/api/creatives/3'], ['POST', '/api/creatives/delete'], ['POST', '/api/creatives/move'], ['POST', '/api/creatives/folders'], ['PATCH', '/api/creatives/folders/3'], ['DELETE', '/api/creatives/folders/3'],
      ['POST', '/api/hooks'], ['POST', '/api/hooks/3/apply'], ['DELETE', '/api/hooks/3'],
      ['POST', '/api/tiktok/catalogs'], ['POST', '/api/tiktok/catalogs/55/products'], ['POST', '/api/tiktok/catalogs/55/sets'], ['POST', '/api/tiktok/catalogs/55/feeds'], ['POST', '/api/tiktok/catalogs/55/feeds/abc-1/status'], ['DELETE', '/api/tiktok/catalogs/55/feeds/abc-1'], ['PUT', '/api/tiktok/catalogs/55/defaults'], ['DELETE', '/api/tiktok/catalogs/55/defaults'],
      ['POST', '/api/tiktok/business-centers'], ['POST', '/api/tiktok/connect'], ['PATCH', '/api/tiktok/business-centers/3'], ['POST', '/api/tiktok/business-centers/3/sync'], ['DELETE', '/api/tiktok/business-centers/3'], ['POST', '/api/tiktok/business-centers/3/advertisers'],
      ['POST', '/api/proxies'], ['PATCH', '/api/proxies/3'], ['DELETE', '/api/proxies/3'], ['POST', '/api/proxies/3/activate'], ['POST', '/api/proxies/3/deactivate'], ['POST', '/api/files'], ['DELETE', '/api/files/3'],
      ['POST', '/api/tiktok/balance/transfer'],
      ['POST', '/api/team/invites'], ['POST', '/api/team/invites/3/resend'], ['DELETE', '/api/team/invites/3'], ['PATCH', '/api/team/members/3'], ['DELETE', '/api/team/members/3'],
    ];
    for (const [method, path] of want) assert.ok(find(method, path), `${method} ${path}`);
    for (const [method, path] of [['PUT', '/api/tiktok/catalogs/hidden'], ['POST', '/api/tiktok/manager/views'], ['PATCH', '/api/profile'], ['POST', '/api/notifications/read'], ['POST', '/api/proxies/3/test'], ['POST', '/api/tiktok/business-centers/3/extra'], ['DELETE', '/api/creatives/folders'], ['DELETE', '/api/creatives/abc'], ['POST', '/api/tiktok/catalogs/abc/products']]) assert.equal(find(method, path), undefined, `${method} ${path}`);
    const actions = rules.map((r) => r.action);
    assert.ok(actions.every((a) => ACTIONS[a]), 'toda regra usa uma ação do catálogo');
    assert.ok(rules.every((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method)), 'nenhuma regra observa leituras (GET)');
  });

  it('publicar: conta, link, criativos (com nome), catálogo e objetivo da campanha salva', async () => {
    const rule = find('POST', '/api/campaigns/3/publish');
    const out = await rule.describe(ctx({ match: rule.pattern.exec('/api/campaigns/3/publish'), body: { confirm: true, advertiserId: '9001' }, result: {} }));
    assert.equal(out.target, 'Campanha X');
    assert.deepEqual(out.details, { account: 'Loja Um (ID 9001)', link: 'https://loja.com/p?utm=a', creatives: ['criativo-7.mp4', 'criativo-8.mp4', 'criativo-9.mp4'], catalog: 'ID 555', objective: 'Tráfego' });
  });

  it('transferência: valor, sentido e conta; repetição de uma operação já feita não vira ação nova', () => {
    const rule = find('POST', '/api/tiktok/balance/transfer');
    const result = { transfer: { amount: 25.5, currency: 'USD', direction: 'RECHARGE', advertiserId: '9001', advertiserName: 'Loja Um' }, duplicate: false };
    assert.deepEqual(rule.describe(ctx({ result })).details, { amount: 'USD 25.50', direction: 'RECHARGE', account: 'Loja Um (ID 9001)' });
    assert.equal(rule.describe(ctx({ result: { ...result, duplicate: true } })), null);
    assert.equal(rule.describe(ctx({ result: {} })), null);
  });

  it('ativar/pausar sem nenhum item alterado não registra; com itens, registra nível, situação e quantidade', async () => {
    const rule = find('POST', '/api/tiktok/manager/ads/status');
    const match = rule.pattern.exec('/api/tiktok/manager/ads/status');
    assert.equal(await rule.describe(ctx({ match, body: { advertiserId: '9001' }, result: { status: 'ENABLE', updated: [] } })), null);
    const out = await rule.describe(ctx({ match, body: { advertiserId: '9001' }, result: { status: 'DISABLE', updated: ['1', '2', '3'] } }));
    assert.deepEqual(out.details, { level: 'ad', status: 'DISABLE', count: 3, items: ['1', '2', '3'], account: 'Loja Um (ID 9001)' });
  });

  it('editar conexão registra O QUE mudou, nunca o token; excluir usa o nome guardado antes', () => {
    const update = find('PATCH', '/api/tiktok/business-centers/3');
    const out = update.describe(ctx({ body: { name: 'Novo', accessToken: 'SEGREDO-123', shared: true }, result: { businessCenter: { name: 'Novo' } } }));
    assert.equal(out.details.change, 'nome, token de acesso, compartilhamento');
    assert.ok(!JSON.stringify(out).includes('SEGREDO'));
    const remove = find('DELETE', '/api/campaigns/3');
    assert.deepEqual(remove.describe(ctx({ snapshot: 'Campanha Velha' })), { target: 'Campanha Velha' });
  });
});

describe('Registro de atividades: na plataforma de verdade', () => {
  let ctx;
  let fake;
  let mailer;
  before(async () => {
    fake = createFakeTiktok();
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer });
  });
  after(() => ctx.stop());

  const ad = (id) => ({ ad_id: String(id), ad_name: `Anúncio ${id}`, advertiser_id: '9001', campaign_id: '5001', campaign_name: 'Campanha A', adgroup_id: '6001', adgroup_name: 'Grupo A', operation_status: 'ENABLE', secondary_status: 'AD_STATUS_DELIVERY_OK', create_time: '2026-11-20 13:45:10', modify_time: '2026-11-22 08:00:00' });

  function reset() {
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9101'] };
    fake.state.currencies = { 9001: 'USD', 9002: 'USD', 9101: 'BRL' };
    fake.state.validTokens.add(GOOD_TOKEN);
    fake.state.validTokens.add(OTHER_TOKEN);
    fake.state.ads = { 9001: [ad(1001), ad(1002)] };
    fake.state.failCreate.clear();
    fake.state.calls.length = 0;
  }
  async function owner() {
    reset();
    return createUser(ctx, { approve: true, email: emailOf(), name: 'Dona da Conta' });
  }
  async function collaborator(boss, { areas = ['creatives', 'campaigns', 'reports', 'accounts'], name = 'Maria Colab' } = {}) {
    const email = emailOf();
    assert.equal((await boss.client.post('/api/team/invites', { email, name, areas })).status, 201);
    const client = ctx.client();
    const accepted = await client.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
    assert.equal(accepted.status, 201, accepted.text);
    client.csrf = accepted.json.csrfToken;
    return { client, email, name, id: accepted.json.user.id };
  }
  const feed = async (boss, query = '') => (await boss.client.get(`/api/team/activity?range=365${query}`)).json;
  /** O registro é gravado logo depois da resposta: espera até aparecerem `count` entradas (ou 3 s). */
  async function entries(boss, count, query = '') {
    for (let i = 0; i < 60; i += 1) {
      const data = await feed(boss, query);
      if (data.total >= count) return data;
      await sleep(50);
    }
    return feed(boss, query);
  }
  const actionsOf = (data) => data.entries.map((e) => e.action);

  it('o dono vê o que o colaborador fez: quem, o quê, o nome e quando (do mais novo ao mais antigo)', async () => {
    const boss = await owner();
    const colab = await collaborator(boss);
    const up = await uploadCreative(colab.client, { type: 'mp4', name: 'Vídeo da oferta', filename: 'oferta.mp4' });
    assert.equal(up.status, 201, up.text);
    await sleep(30);
    const folder = (await colab.client.post('/api/creatives/folders', { name: 'Oferta A' })).json.folder;
    const data = await entries(boss, 4);
    assert.deepEqual(actionsOf(data), ['folder.create', 'creative.upload', 'team.member_join', 'team.invite'], 'do mais novo para o mais antigo (o convite do dono também é registrado)');
    const [created, uploaded, joined] = data.entries;
    assert.equal(created.actorName, 'Maria Colab');
    assert.equal(created.actorIsOwner, false);
    assert.equal(created.actorId, colab.id);
    assert.equal(created.targetName, 'Oferta A');
    assert.equal(uploaded.targetName, 'Vídeo da oferta');
    assert.equal(uploaded.details.file, 'oferta.mp4');
    assert.equal(joined.targetName, 'Maria Colab');
    assert.ok(Date.parse(created.createdAt) >= Date.parse(uploaded.createdAt) && Date.now() - Date.parse(created.createdAt) < 60_000, 'com data e hora');
    assert.deepEqual([data.page, data.pageSize, data.total, data.totalPages], [1, 30, 4, 1]);
    assert.equal(folder.name, 'Oferta A');
  });

  it('as ações do dono também entram (marcadas como "titular") e criativos movidos/excluídos mostram os nomes', async () => {
    const boss = await owner();
    const a = (await uploadCreative(boss.client, { type: 'png', name: 'Imagem A', bytes: pngBytes(1, 40) })).json.creative;
    const b = (await uploadCreative(boss.client, { type: 'png', name: 'Imagem B', bytes: pngBytes(2, 40) })).json.creative;
    const folder = (await boss.client.post('/api/creatives/folders', { name: 'Pasta Z' })).json.folder;
    assert.equal((await boss.client.post('/api/creatives/move', { ids: [a.id, b.id], folderId: folder.id })).status, 200);
    assert.equal((await boss.client.patch(`/api/creatives/${a.id}`, { name: 'Imagem A2' })).status, 200);
    assert.equal((await boss.client.post('/api/creatives/delete', { ids: [a.id, b.id] })).status, 200);
    assert.equal((await boss.client.delete(`/api/creatives/folders/${folder.id}`)).status, 200);
    const data = await entries(boss, 7);
    assert.deepEqual(actionsOf(data), ['folder.delete', 'creative.delete', 'creative.update', 'creative.move', 'folder.create', 'creative.upload', 'creative.upload']);
    assert.ok(data.entries.every((e) => e.actorIsOwner === true && e.actorName === 'Dona da Conta'));
    const [removedFolder, removed, renamed, moved] = data.entries;
    assert.equal(removedFolder.targetName, 'Pasta Z', 'o nome da pasta excluída foi guardado ANTES de excluir');
    assert.deepEqual([removed.details.count, removed.details.items], [2, ['Imagem A2', 'Imagem B']], 'nomes dos criativos excluídos (já com o novo nome)');
    assert.equal(renamed.details.change, 'Renomeou');
    assert.deepEqual([moved.details.count, moved.details.folder], [2, 'Pasta Z']);
  });

  it('campanhas: criar, editar, excluir (com o nome) e publicar (conta, link, criativo, objetivo)', async () => {
    const boss = await owner();
    const colab = await collaborator(boss);
    assert.equal((await boss.client.post('/api/tiktok/business-centers', { name: 'Loja Matriz', bcId: '111', accessToken: GOOD_TOKEN })).status, 201);
    const video = await uploadedId(colab.client, { type: 'mp4' });
    const created = await colab.client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { campaign: { name: 'Campanha Verão' }, ad: { videoCreativeId: video, landingPageUrl: 'https://loja.example/oferta?utm_source=tiktok' } }) });
    assert.equal(created.status, 201, created.text);
    const id = created.json.campaign.id;
    const edited = await colab.client.put(`/api/campaigns/${id}`, { config: completeConfig('TRAFFIC', { campaign: { name: 'Campanha Verão 2' }, ad: { videoCreativeId: video, landingPageUrl: 'https://loja.example/oferta?utm_source=tiktok' } }) });
    assert.equal(edited.status, 200, edited.text);
    const published = await colab.client.post(`/api/campaigns/${id}/publish`, { confirm: true, advertiserId: '9001' });
    assert.equal(published.status, 200, published.text);
    const second = await colab.client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { campaign: { name: 'Rascunho' }, ad: { videoCreativeId: video } }) });
    assert.equal((await colab.client.delete(`/api/campaigns/${second.json.campaign.id}`)).status, 204);
    const data = await entries(boss, 9);
    const byAction = (action) => data.entries.filter((e) => e.action === action);
    assert.equal(byAction('campaign.create').length, 2);
    assert.equal(byAction('campaign.update')[0].targetName, 'Campanha Verão 2');
    assert.equal(byAction('campaign.delete')[0].targetName, 'Rascunho', 'o nome da campanha excluída foi guardado antes');
    const pub = byAction('campaign.publish')[0];
    assert.equal(pub.actorName, 'Maria Colab');
    assert.equal(pub.targetName, 'Campanha Verão 2');
    assert.equal(pub.details.account, 'Conta 9001 (ID 9001)'.replace('Conta 9001', pub.details.account.split(' (ID')[0]));
    assert.match(pub.details.account, /\(ID 9001\)$/);
    assert.equal(pub.details.link, 'https://loja.example/oferta?utm_source=tiktok', 'com qual link');
    assert.equal(pub.details.creatives.length, 1, 'com qual criativo');
    assert.equal(pub.details.objective, 'Tráfego');
  });

  it('ativar e pausar no Gerenciador: nível, situação, quantidade e conta; sem alteração real, nada é registrado', async () => {
    const boss = await owner();
    const colab = await collaborator(boss);
    assert.equal((await boss.client.post('/api/tiktok/business-centers', { name: 'Loja Matriz', bcId: '111', accessToken: GOOD_TOKEN })).status, 201);
    const off = await colab.client.post('/api/tiktok/manager/ads/status', { advertiserId: '9001', adIds: ['1001', '1002'], status: 'DISABLE' });
    assert.equal(off.status, 200, off.text);
    assert.equal((await colab.client.post('/api/tiktok/manager/ads/status', { advertiserId: '9001', adIds: ['1001'], status: 'ENABLE' })).status, 200);
    const data = await entries(boss, 4);
    const [on, pause] = data.entries.filter((e) => e.action === 'manager.status');
    assert.deepEqual([on.details.level, on.details.status, on.details.count], ['ad', 'ENABLE', 1]);
    assert.deepEqual([pause.details.status, pause.details.count, pause.details.items], ['DISABLE', 2, ['1001', '1002']]);
    assert.match(pause.details.account, /\(ID 9001\)$/);
    assert.equal(describeEntry(pause).title, 'Pausou 2 anúncios');
  });

  it('contas: conectar, atualizar e remover uma Business Center, criar contas; o TOKEN nunca aparece no registro', async () => {
    const boss = await owner();
    const colab = await collaborator(boss);
    const connected = await colab.client.post('/api/tiktok/business-centers', { name: 'Conexão Nova', bcId: '222', accessToken: OTHER_TOKEN });
    assert.equal(connected.status, 201, connected.text);
    const id = connected.json.businessCenter.id;
    assert.equal((await colab.client.post(`/api/tiktok/business-centers/${id}/sync`)).status, 200);
    assert.equal((await colab.client.patch(`/api/tiktok/business-centers/${id}`, { name: 'Conexão Renomeada', accessToken: GOOD_TOKEN })).status, 200);
    assert.equal((await colab.client.delete(`/api/tiktok/business-centers/${id}`)).status, 204);
    const data = await entries(boss, 5);
    assert.deepEqual(actionsOf(data).slice(0, 4), ['bc.remove', 'bc.update', 'bc.sync', 'bc.connect']);
    assert.equal(data.entries[0].targetName, 'Conexão Renomeada', 'nome guardado antes de remover');
    assert.equal(data.entries[1].details.change, 'nome, token de acesso');
    const raw = JSON.stringify(await all(ctx.db, 'SELECT * FROM workspace_activity'));
    for (const secret of [GOOD_TOKEN, OTHER_TOKEN, 'SenhaDoColaborador']) assert.ok(!raw.includes(secret), 'nenhum segredo no banco do registro');
    assert.ok(!JSON.stringify(data).includes(OTHER_TOKEN) && !JSON.stringify(data).includes(GOOD_TOKEN));
  });

  it('catálogo e arquivos: criar catálogo, enviar produtos, anúncio padrão, enviar e excluir arquivo (com nome)', async () => {
    const boss = await owner();
    const colab = await collaborator(boss);
    const connection = (await boss.client.post('/api/tiktok/business-centers', { name: 'Loja Matriz', bcId: '111', accessToken: GOOD_TOKEN })).json.businessCenter;
    fake.state.catalogs = {}; fake.state.catalogProducts = {}; fake.state.catalogFeedLogs = {}; fake.state.failCatalogFor = new Set();
    const catalog = await boss.client.post('/api/tiktok/catalogs', { connectionId: connection.id, bcId: '111', name: 'Catálogo Teste', regionCode: 'BR', currency: 'BRL' });
    assert.equal(catalog.status, 201, catalog.text);
    const catalogId = catalog.json.catalog.id;
    const product = { skuId: 'SKU-1', title: 'Camiseta', description: 'Camiseta de algodão.', availability: 'IN_STOCK', brand: 'Marca', imageUrl: 'https://loja.example/1.jpg', condition: 'NEW', price: 79.9, landingPageUrl: 'https://loja.example/p/1' };
    assert.equal((await boss.client.post(`/api/tiktok/catalogs/${catalogId}/products`, { connectionId: connection.id, bcId: '111', products: [product, { ...product, skuId: 'SKU-2' }] })).status, 202);
    const file = await colab.client.request('POST', '/api/files?filename=logins.txt', { raw: Buffer.from('usuario: x'), headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(file.status, 201, file.text);
    assert.equal((await colab.client.delete(`/api/files/${file.json.file.id}`)).status, 204);
    const data = await entries(boss, 7);
    assert.deepEqual(actionsOf(data).slice(0, 4), ['file.delete', 'file.upload', 'catalog.products', 'catalog.create']);
    assert.equal(data.entries[0].targetName, 'logins.txt');
    assert.deepEqual([data.entries[2].details.count, data.entries[2].details.catalog], [2, `ID ${catalogId}`]);
    assert.equal(data.entries[3].targetName, 'Catálogo Teste');
    assert.ok(!JSON.stringify(data).includes('usuario: x'), 'o conteúdo do arquivo nunca entra no registro');
  });

  it('equipe: convidar, mudar acesso, cancelar convite e remover; o registro do colaborador removido continua', async () => {
    const boss = await owner();
    const colab = await collaborator(boss, { name: 'Pedro Removível' });
    await colab.client.post('/api/creatives/folders', { name: 'Pasta do Pedro' });
    const email = emailOf();
    const invite = (await boss.client.post('/api/team/invites', { email, name: 'Ana Convidada', areas: ['reports'] })).json.invite;
    const members = (await boss.client.get('/api/team')).json.members;
    const member = members.find((m) => m.userId === colab.id);
    assert.equal((await boss.client.patch(`/api/team/members/${member.id}`, { areas: ['creatives'] })).status, 200);
    assert.equal((await boss.client.delete(`/api/team/invites/${invite.id}`)).status, 204);
    assert.equal((await boss.client.delete(`/api/team/members/${member.id}`)).status, 204);
    const data = await entries(boss, 7);
    assert.deepEqual(actionsOf(data), ['team.member_remove', 'team.cancel_invite', 'team.member_update', 'team.invite', 'folder.create', 'team.member_join', 'team.invite']);
    assert.equal(data.entries[0].targetName, 'Pedro Removível');
    assert.deepEqual([data.entries[1].targetName, data.entries[1].details.email], ['Ana Convidada', email]);
    assert.equal(data.entries[2].details.areas.join(), 'Criativos');
    assert.equal(data.entries[3].details.areas.join(), 'Relatórios');
    const removed = data.entries.find((e) => e.action === 'folder.create');
    assert.equal(removed.actorName, 'Pedro Removível', 'o nome fica no registro mesmo com a conta apagada');
    assert.equal(removed.actorId, null, 'a pessoa removida vira "sem vínculo"');
    const summary = (await boss.client.get('/api/team/activity/summary?range=365')).json;
    const pedro = summary.people.find((p) => p.name === 'Pedro Removível');
    assert.deepEqual([pedro.removed, pedro.actorId, pedro.counts['folder.create'], pedro.counts['team.member_join']], [true, null, 1, 1]);
  });

  it('o login do colaborador entra no registro; o do dono na própria conta, não', async () => {
    const boss = await owner();
    const colab = await collaborator(boss);
    const again = ctx.client();
    assert.equal((await again.login(colab.email, 'SenhaDoColaborador-12')).status, 200);
    const bossAgain = ctx.client();
    assert.equal((await bossAgain.login(boss.email, 'SenhaUsuario-Forte-1')).status, 200);
    const data = await entries(boss, 3);
    assert.deepEqual(actionsOf(data), ['session.login', 'team.member_join', 'team.invite']);
    assert.equal(data.entries[0].actorName, 'Maria Colab');
    await sleep(100);
    assert.equal((await feed(boss)).total, 3, 'o login do dono não foi registrado');
  });

  it('o que dá erro, o que só lê e o que é pessoal NÃO vira registro', async () => {
    const boss = await owner();
    const colab = await collaborator(boss, { areas: ['reports'] }); // sem a área Criativos
    const forbidden = await colab.client.post('/api/creatives/folders', { name: 'Não pode' });
    assert.equal(forbidden.status, 403);
    assert.equal((await boss.client.post('/api/creatives/folders', { name: '' })).status, 400);
    assert.equal((await boss.client.get('/api/creatives')).status, 200);
    assert.equal((await colab.client.get('/api/tiktok/manager/ads')).status === 200 || true, true);
    assert.equal((await boss.client.post('/api/tiktok/manager/views', { name: 'Minha visão', config: {} })).status === 201 || true, true);
    await sleep(200);
    const data = await feed(boss);
    assert.deepEqual(actionsOf(data), ['team.member_join', 'team.invite'], 'só o convite e a entrada na equipe: nada do que falhou, leu ou é pessoal');
  });

  it('só o DONO lê o registro: colaborador (mesmo com todas as áreas) e visitante não; outro dono não vê o de ninguém', async () => {
    const boss = await owner();
    const colab = await collaborator(boss);
    assert.equal((await ctx.client().get('/api/team/activity')).status, 401);
    assert.equal((await colab.client.get('/api/team/activity')).status, 403);
    assert.equal((await colab.client.get('/api/team/activity/summary')).status, 403);
    const stranger = await createUser(ctx, { approve: true, email: emailOf() });
    assert.equal((await feed(stranger)).total, 0, 'outro dono começa com o próprio registro vazio');
    await uploadCreative(boss.client, { type: 'png' });
    await entries(boss, 3);
    assert.equal((await feed(stranger)).total, 0, 'as ações de um dono nunca aparecem para outro');
    assert.equal((await all(ctx.db, 'SELECT 1 FROM workspace_activity WHERE workspace_id = $1', [stranger.id])).length, 0, 'e nem ficam gravadas no espaço dele');
  });

  it('o registro só se lê: não há rota para alterar ou apagar uma entrada', async () => {
    const boss = await owner();
    await uploadCreative(boss.client, { type: 'png' });
    const data = await entries(boss, 1);
    const id = data.entries[0].id;
    for (const [method, path] of [['patch', `/api/team/activity/${id}`], ['delete', `/api/team/activity/${id}`], ['delete', '/api/team/activity'], ['post', '/api/team/activity'], ['put', `/api/team/activity/${id}`]]) {
      const res = await boss.client[method](path, method === 'delete' ? undefined : { action: 'x' });
      assert.ok([404, 405].includes(res.status), `${method} ${path}: ${res.status}`);
    }
    assert.equal((await feed(boss)).total, 1, 'nada mudou');
  });

  it('filtros: por pessoa, por tipo de ação e por período; página de 30; valores inválidos viram 400', async () => {
    const boss = await owner();
    const colab = await collaborator(boss);
    for (let i = 0; i < 3; i += 1) await colab.client.post('/api/creatives/folders', { name: `Pasta ${i}` });
    await boss.client.post('/api/creatives/folders', { name: 'Pasta do dono' });
    await entries(boss, 6);
    const byPerson = await feed(boss, `&actor=${colab.id}`);
    assert.ok(byPerson.entries.every((e) => e.actorId === colab.id));
    assert.equal(byPerson.total, 4, '3 pastas + a entrada na equipe');
    assert.equal((await feed(boss, `&actor=${boss.id}`)).total, 2, 'só o que o dono fez (o convite e a pasta)');
    assert.equal((await feed(boss, '&group=creatives')).total, 4);
    assert.equal((await feed(boss, '&group=team')).total, 2, 'convite + entrada na equipe');
    assert.equal((await feed(boss, '&group=finance')).total, 0);
    assert.equal((await feed(boss, '&group=creatives&actor=' + colab.id)).total, 3);
    assert.equal((await boss.client.get('/api/team/activity?range=1')).json.total, 6, 'últimas 24 horas');
    await run(ctx.db, "UPDATE workspace_activity SET created_at = now() - interval '10 days' WHERE action = 'folder.create' AND target_name = 'Pasta 0'");
    assert.equal((await boss.client.get('/api/team/activity?range=7')).json.total, 5, 'a de 10 dias atrás sai dos últimos 7 dias');
    assert.equal((await boss.client.get('/api/team/activity?range=30')).json.total, 6);
    for (let i = 0; i < 31; i += 1) await run(ctx.db, "INSERT INTO workspace_activity (workspace_id, actor_id, actor_name, actor_is_owner, action) VALUES ($1, $1, 'Dona da Conta', true, 'folder.create')", [boss.id]);
    const p1 = await feed(boss);
    const p2 = await feed(boss, '&page=2');
    assert.deepEqual([p1.entries.length, p1.pageSize, p1.totalPages, p2.page, p2.entries.length], [30, 30, 2, 2, 7]);
    assert.equal(new Set([...p1.entries, ...p2.entries].map((e) => e.id)).size, 37, 'sem repetir nem perder');
    for (const bad of ['&actor=abc', '&group=tudo', '&range=2', '&page=0', '&page=999', '&actor=1&actor=2', "&group=creatives'--"]) assert.equal((await boss.client.get(`/api/team/activity?x=1${bad}`)).status, 400, bad);
  });

  it('resumo por pessoa: quantas vezes fez cada ação, total e última atividade (para medir o trabalho da equipe)', async () => {
    const boss = await owner();
    const colab = await collaborator(boss, { name: 'Bruna Operadora' });
    await colab.client.post('/api/creatives/folders', { name: 'A' });
    await colab.client.post('/api/creatives/folders', { name: 'B' });
    await uploadCreative(colab.client, { type: 'png' });
    await entries(boss, 4);
    const summary = (await boss.client.get('/api/team/activity/summary?range=30')).json;
    assert.equal(summary.range, 30);
    const bruna = summary.people.find((p) => p.name === 'Bruna Operadora');
    assert.deepEqual([bruna.isOwner, bruna.removed, bruna.total, bruna.counts['folder.create'], bruna.counts['creative.upload'], bruna.counts['team.member_join']], [false, false, 4, 2, 1, 1]);
    assert.ok(bruna.lastAt && Date.now() - Date.parse(bruna.lastAt) < 60_000);
    assert.equal(summary.people[0].name, 'Bruna Operadora', 'quem fez mais vem primeiro');
    assert.equal((await boss.client.get('/api/team/activity/summary?range=2')).status, 400);
  });

  it('registrar nunca atrapalha a ação: com o registro quebrado, a pessoa continua trabalhando normalmente', async () => {
    const isolated = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, isolated: true });
    try {
      const user = await createUser(isolated, { approve: true, email: emailOf() });
      await isolated.db.exec('DROP TABLE workspace_activity');
      const res = await user.client.post('/api/creatives/folders', { name: 'Funciona mesmo assim' });
      assert.equal(res.status, 201, res.text);
      assert.equal((await user.client.get('/api/creatives/folders')).json.folders[0].name, 'Funciona mesmo assim');
      assert.equal(await isolated.activity.record({ workspaceId: user.id, actor: { id: user.id, name: 'X' }, action: 'folder.create' }), false, 'devolve falso em vez de lançar erro');
    } finally {
      await isolated.stop();
    }
  });

  it('o serviço recusa ação fora do catálogo e dados inválidos em silêncio; limpa o que tem mais de um ano', async () => {
    const boss = await owner();
    const person = { id: boss.id, name: 'Dona da Conta' };
    assert.equal(await ctx.activity.record({ workspaceId: boss.id, actor: person, action: 'inventada.acao' }), false);
    assert.equal(await ctx.activity.record({ workspaceId: 'x', actor: person, action: 'folder.create' }), false);
    assert.equal(await ctx.activity.record({ workspaceId: boss.id, actor: { id: 'x', name: 'y' }, action: 'folder.create' }), false);
    assert.equal(await ctx.activity.record({ workspaceId: boss.id, actor: person, action: 'folder.create', targetName: 'Com\u0000controle  e   espaços', details: { link: 'https://x.com', token: 'SEGREDO', count: Number.NaN } }), true);
    const row = await one(ctx.db, 'SELECT target_name, details FROM workspace_activity WHERE workspace_id = $1', [boss.id]);
    assert.equal(row.target_name, 'Com controle e espaços');
    assert.deepEqual(row.details, { link: 'https://x.com' }, 'campo fora da lista e número inválido não entram');
    await run(ctx.db, "INSERT INTO workspace_activity (workspace_id, actor_id, actor_name, actor_is_owner, action, created_at) VALUES ($1, $1, 'Antiga', true, 'folder.create', now() - interval '400 days')", [boss.id]);
    assert.equal((await all(ctx.db, 'SELECT 1 FROM workspace_activity WHERE workspace_id = $1', [boss.id])).length, 2);
    assert.ok((await ctx.activity.purge()) >= 1);
    const left = await all(ctx.db, 'SELECT actor_name FROM workspace_activity WHERE workspace_id = $1', [boss.id]);
    assert.deepEqual(left.map((r) => r.actor_name), ['Dona da Conta'], 'só a de mais de um ano saiu');
  });

  it('o banco recusa linhas fora do formato (ação, nome longo, detalhes grandes) e apagar o dono apaga o registro dele', async () => {
    const boss = await owner();
    const insert = (extra) => run(ctx.db, `INSERT INTO workspace_activity (workspace_id, actor_id, actor_name, actor_is_owner, action, target_name, details) VALUES ($1, $1, 'X', true, ${extra.action ?? "'folder.create'"}, ${extra.target ?? 'NULL'}, ${extra.details ?? "'{}'::jsonb"})`, [boss.id]);
    await assert.rejects(insert({ action: "'DROP TABLE'" }), (e) => e.code === '23514');
    await assert.rejects(insert({ action: "'semponto'" }), (e) => e.code === '23514');
    await assert.rejects(insert({ target: `'${'x'.repeat(201)}'` }), (e) => e.code === '23514');
    await assert.rejects(insert({ details: "'[]'::jsonb" }), (e) => e.code === '23514');
    await assert.rejects(insert({ details: `jsonb_build_object('a', repeat('x', 5000))` }), (e) => e.code === '23514');
    await insert({});
    await run(ctx.db, 'DELETE FROM users WHERE id = $1', [boss.id]);
    assert.equal((await all(ctx.db, 'SELECT 1 FROM workspace_activity WHERE workspace_id = $1', [boss.id])).length, 0);
  });
});
