import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { findField, reconcileConfig, validateConfig } from '../shared/campaign-spec.js';
import { LEGACY_PIXEL_EVENTS, PIXEL_EVENTS, PIXEL_EVENT_NAME_MAX, PIXEL_EVENT_VALUES, isPixelEvent, pixelEventLabel } from '../shared/pixel-events.js';
import { completeConfig } from './campaign-fixtures.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, startTestServer } from './helpers.js';
import { uploadedId } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, tiktokPixelEvent: 1000, campaignPublish: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
const pixelWith = (events, extra = {}) => ({ pixel_id: '123456', pixel_code: 'CABC123XYZ789', pixel_name: 'Pixel da Loja', events, ...extra });
const ev = (type, name = '') => ({ event_type: type, optimization_event: type, event_name: name, event_id: '1' });
let counter = 0;
const emailOf = () => `pe${++counter}@example.com`;

describe('Eventos de conversão do pixel (regras compartilhadas)', () => {
  it('são os 12 eventos web da tabela oficial do TikTok, sem repetição (e sem os valores que não existem)', () => {
    assert.equal(PIXEL_EVENTS.length, 12);
    assert.equal(new Set(PIXEL_EVENT_VALUES).size, 12);
    for (const real of ['SHOPPING', 'INITIATE_ORDER', 'ON_WEB_CART', 'ADD_BILLING', 'ON_WEB_DETAIL', 'FORM', 'ON_WEB_REGISTER', 'ON_WEB_SUBSCRIBE', 'ON_WEB_SEARCH', 'ON_WEB_ADD_TO_WISHLIST', 'CONSULT', 'DOWNLOAD_START']) assert.ok(isPixelEvent(real), real);
    for (const fake of ['COMPLETE_PAYMENT', 'ADD_TO_CART', 'PURCHASE', '', null, undefined, 'shopping']) assert.equal(isPixelEvent(fake), false, String(fake));
    assert.equal(pixelEventLabel('SHOPPING'), 'Compra (geral)');
    assert.equal(pixelEventLabel('ALGO_NOVO'), 'ALGO_NOVO', 'valor desconhecido aparece como veio');
    assert.equal(PIXEL_EVENT_NAME_MAX, 40);
  });

  it('o campo "Evento de conversão" do assistente oferece exatamente essa lista', () => {
    const field = findField('adGroup', 'optimizationEvent');
    assert.deepEqual(field.options.map((o) => o.value), PIXEL_EVENT_VALUES);
    assert.equal(field.legacy, LEGACY_PIXEL_EVENTS);
    assert.match(field.help, /precisa existir no pixel/);
  });

  it('campanhas e configurações salvas com os valores antigos são corrigidas (Pagamento concluído → Compra; Carrinho → ON_WEB_CART); valor que nunca existiu continua inválido', () => {
    const cfg = (event) => completeConfig('WEB_CONVERSIONS', { adGroup: { optimizationEvent: event } });
    for (const [old, now] of Object.entries(LEGACY_PIXEL_EVENTS)) {
      const result = validateConfig(cfg(old));
      assert.equal(result.config.adGroup.optimizationEvent, now, old);
      assert.ok(!result.errors.some((e) => e.path === 'adGroup.optimizationEvent'), old);
      assert.equal(reconcileConfig(cfg(old)).adGroup.optimizationEvent, now, `${old} na tela`);
    }
    assert.ok(validateConfig(cfg('INVENTADO')).errors.some((e) => e.path === 'adGroup.optimizationEvent'));
    assert.equal(validateConfig(cfg('SHOPPING')).config.adGroup.optimizationEvent, 'SHOPPING');
  });
});

describe('Eventos do pixel: listar, criar e avisar antes de publicar (API)', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer: createFakeMailer() });
  });
  after(() => ctx.stop());

  async function owner() {
    const user = await createUser(ctx, { approve: true, email: emailOf() });
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9101'] };
    fake.state.pixels = {};
    fake.state.pixelEventCreates = [];
    fake.state.failPixelEventCreate = '';
    fake.state.pixelEventDenied = new Set();
    fake.state.calls.length = 0;
    await user.client.post('/api/tiktok/business-centers', { name: 'BC 111', bcId: '111', accessToken: GOOD_TOKEN });
    return user;
  }
  const pixels = async (user, adv = '9001') => (await user.client.get(`/api/tiktok/advertisers/${adv}/pixels?fresh=1`)).json.pixels;
  const createEvent = (user, body, adv = '9001') => user.client.post(`/api/tiktok/advertisers/${adv}/pixel-events`, body);
  const createCalls = () => fake.callsTo('/pixel/event/create/');

  it('a lista de pixels traz os eventos que cada pixel já tem (só os padrões, no formato do TikTok, sem repetição)', async () => {
    const user = await owner();
    fake.state.pixels = { 9001: [pixelWith([ev('SHOPPING', 'Compra'), ev('SHOPPING', 'repetido'), ev('ON_WEB_CART'), { custom_event_type: 'meu_evento', event_id: '9' }, { optimization_event: 'minusculo' }, { optimization_event: 'X<script>' }, null]), pixelWith(undefined, { pixel_id: '123457' })] };
    const list = await pixels(user);
    assert.deepEqual(list[0].events.map((e) => e.optimizationEvent), ['SHOPPING', 'ON_WEB_CART']);
    assert.equal(list[0].events[0].name, 'Compra');
    assert.deepEqual(list[1].events, [], 'pixel sem eventos: lista vazia (nunca indefinida)');
  });

  it('cria o evento no pixel: o TikTok recebe o formato oficial e a lista já mostra o evento novo', async () => {
    const user = await owner();
    fake.state.pixels = { 9001: [pixelWith([ev('ON_WEB_CART')])] };
    await pixels(user); // aquece o cache
    const res = await createEvent(user, { pixelId: '123456', eventType: 'SHOPPING', name: '  Compra   no site ' });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.json, { eventType: 'SHOPPING', created: true });
    assert.deepEqual(fake.state.pixelEventCreates, [{ advertiser_id: '9001', pixel_id: '123456', pixel_events: [{ event_type: 'SHOPPING', statistic_type: 'EVERY_TIME', event_name: 'Compra no site' }] }]);
    assert.deepEqual((await user.client.get('/api/tiktok/advertisers/9001/pixels')).json.pixels[0].events.map((e) => e.optimizationEvent), ['ON_WEB_CART', 'SHOPPING'], 'o cache foi limpo');
  });

  it('o evento que o pixel já tem não é criado de novo (nada é enviado ao TikTok)', async () => {
    const user = await owner();
    fake.state.pixels = { 9001: [pixelWith([ev('SHOPPING')])] };
    const res = await createEvent(user, { pixelId: '123456', eventType: 'SHOPPING' });
    assert.equal(res.status, 201);
    assert.deepEqual(res.json, { eventType: 'SHOPPING', created: false });
    assert.equal(createCalls().length, 0);
  });

  it('valida o pedido antes de falar com o TikTok: tipo, pixel, nome', async () => {
    const user = await owner();
    fake.state.pixels = { 9001: [pixelWith([])] };
    const bad = [
      { pixelId: '123456', eventType: 'COMPLETE_PAYMENT' }, { pixelId: '123456', eventType: 'shopping' }, { pixelId: '123456' }, { eventType: 'SHOPPING' },
      { pixelId: 'abc', eventType: 'SHOPPING' }, { pixelId: 123456, eventType: 'SHOPPING' }, { pixelId: '123456', eventType: 'SHOPPING', name: 'x'.repeat(PIXEL_EVENT_NAME_MAX + 1) },
      { pixelId: '123456', eventType: 'SHOPPING', name: 'linha\u0001quebrada' },
    ];
    for (const body of bad) assert.equal((await createEvent(user, body)).status, 400, JSON.stringify(body).slice(0, 70));
    assert.equal((await user.client.post('/api/tiktok/advertisers/9001/pixel-events', [])).status, 400);
    assert.equal((await createEvent(user, { pixelId: '123456', eventType: 'SHOPPING' }, 'abc')).status, 400);
    assert.equal(createCalls().length, 0);
    assert.equal((await createEvent(user, { pixelId: '123456', eventType: 'SHOPPING', name: 'x'.repeat(PIXEL_EVENT_NAME_MAX) })).status, 201, '40 caracteres é o limite');
  });

  it('pixel que a conta não enxerga: 404 sem chamar o TikTok para criar; conta de outra pessoa: 404; exige login', async () => {
    const user = await owner();
    fake.state.pixels = { 9001: [pixelWith([])] };
    const missing = await createEvent(user, { pixelId: '999999', eventType: 'SHOPPING' });
    assert.equal(missing.status, 404);
    assert.match(missing.json.error.message, /Vincule o pixel à conta/);
    assert.equal((await createEvent(user, { pixelId: '123456', eventType: 'SHOPPING' }, '9101')).status, 404, 'conta que não é de uma BC dele');
    const other = await createUser(ctx, { approve: true, email: emailOf() });
    assert.equal((await createEvent(other, { pixelId: '123456', eventType: 'SHOPPING' })).status, 404);
    assert.equal((await ctx.client().post('/api/tiktok/advertisers/9001/pixel-events', { pixelId: '123456', eventType: 'SHOPPING' })).status, 401);
    assert.equal(createCalls().length, 0);
  });

  it('erro do TikTok ao criar volta com a mensagem original e nada quebra', async () => {
    const user = await owner();
    fake.state.pixels = { 9001: [pixelWith([])] };
    fake.state.failPixelEventCreate = 'No permission to update this pixel';
    const res = await createEvent(user, { pixelId: '123456', eventType: 'SHOPPING' });
    assert.equal(res.status, 502);
    assert.match(res.json.error.message, /No permission to update this pixel/);
    fake.state.failPixelEventCreate = '';
    assert.equal((await createEvent(user, { pixelId: '123456', eventType: 'SHOPPING' })).status, 201, 'depois do erro tudo volta a funcionar');
  });

  // ---------- pixel só compartilhado ("Pixel cannot be modified.") ----------
  const shared = (events = []) => pixelWith(events, { asset_ownership: { asset_relation_status: 'SHARED', ownership_status: false } });
  const owned = (events = []) => pixelWith(events, { asset_ownership: { asset_relation_status: null, ownership_status: true } });

  it('a lista informa se a conta é a DONA do pixel ou se ele foi só compartilhado com ela', async () => {
    const user = await owner();
    fake.state.pixels = { 9001: [shared(), pixelWith([], { pixel_id: '123457', asset_ownership: { asset_relation_status: null, ownership_status: true } }), pixelWith([], { pixel_id: '123458', asset_ownership: { asset_relation_status: 'TRANSFERRED', ownership_status: true } }), pixelWith([], { pixel_id: '123459', asset_ownership: { asset_relation_status: 'X<script>', ownership_status: 'sim' } })] };
    const list = await pixels(user);
    assert.deepEqual(list.map((p) => [p.ownership, p.relation]), [[false, 'SHARED'], [true, null], [true, 'TRANSFERRED'], [null, null]], 'valor estranho nunca é aceito');
  });

  it('pixel só compartilhado com a conta: o evento é criado pela conta DONA do pixel (quando há uma na conexão) e aparece para as duas', async () => {
    const user = await owner();
    fake.state.pixels = { 9001: [shared()], 9002: [owned()] };
    fake.state.pixelEventDenied = new Set(['9001']); // por 9001 o TikTok responde "Pixel cannot be modified."
    const res = await createEvent(user, { pixelId: '123456', eventType: 'SHOPPING' }); // pedido feito pela 9001
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.json, { eventType: 'SHOPPING', created: true });
    assert.deepEqual(fake.state.pixelEventCreates.map((c) => c.advertiser_id), ['9002'], 'quem criou foi a conta dona');
    assert.deepEqual((await pixels(user, '9001'))[0].events.map((e) => e.optimizationEvent), ['SHOPPING'], 'a conta compartilhada também enxerga o evento');
    fake.state.pixelEventDenied = new Set();
  });

  it('pixel compartilhado e nenhuma conta da conexão é a dona: tenta pela própria conta e, se o TikTok recusar, explica o motivo e o que fazer (com a mensagem original)', async () => {
    const user = await owner();
    fake.state.pixels = { 9001: [shared()], 9002: [shared()] };
    fake.state.pixelEventDenied = new Set(['9001', '9002']);
    const res = await createEvent(user, { pixelId: '123456', eventType: 'SHOPPING' });
    fake.state.pixelEventDenied = new Set();
    assert.equal(res.status, 422, res.text);
    assert.equal(res.json.error.code, 'pixel_not_modifiable');
    assert.match(res.json.error.message, /só foi compartilhado com ela|não tem permissão de edição/);
    assert.match(res.json.error.message, /Gerenciador de Eventos do TikTok/);
    assert.match(res.json.error.message, /Pixel cannot be modified/, 'a mensagem original segue entre parênteses');
    assert.equal(fake.state.pixelEventCreates.length, 1, 'uma única tentativa de criar (a busca pela conta dona só lista pixels)');
  });

  it('a própria conta é a dona mas o TikTok recusa (sem permissão): mesmo erro explicado, sem procurar outra conta', async () => {
    const user = await owner();
    fake.state.pixels = { 9001: [owned()], 9002: [owned()] };
    fake.state.pixelEventDenied = new Set(['9001']);
    const res = await createEvent(user, { pixelId: '123456', eventType: 'SHOPPING' });
    fake.state.pixelEventDenied = new Set();
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'pixel_not_modifiable');
    assert.deepEqual(fake.state.pixelEventCreates.map((c) => c.advertiser_id), ['9001']);
  });

  // ---------- publicar ----------
  const draft = async (client) => {
    const video = await uploadedId(client, { type: 'mp4' });
    return (await client.post('/api/campaigns', { config: completeConfig('WEB_CONVERSIONS', { ad: { videoCreativeId: video } }) })).json.campaign;
  };
  const publish = (client, id, advertiserId = '9001') => client.post(`/api/campaigns/${id}/publish`, { confirm: true, advertiserId });

  it('pixel COM eventos mas sem o escolhido: a publicação é recusada ANTES de criar qualquer coisa, dizendo o que o pixel tem e o que fazer', async () => {
    const user = await owner();
    fake.state.pixels = { 9001: [pixelWith([ev('ON_WEB_CART'), ev('INITIATE_ORDER')])] };
    const { id } = await draft(user.client);
    fake.state.calls.length = 0;
    const res = await publish(user.client, id);
    assert.equal(res.status, 422, res.text);
    assert.equal(res.json.error.code, 'pixel_event_missing');
    assert.match(res.json.error.message, /não tem o evento “Compra \(geral\)”/);
    assert.match(res.json.error.message, /Adicionar ao carrinho, Início de pedido/);
    assert.match(res.json.error.message, /Criar evento no pixel/);
    assert.equal(fake.callsTo('/campaign/create/').length, 0, 'nada foi criado no TikTok');
  });

  it('depois de criar o evento no pixel, a mesma campanha publica normalmente', async () => {
    const user = await owner();
    fake.state.pixels = { 9001: [pixelWith([ev('ON_WEB_CART')])] };
    const { id } = await draft(user.client);
    assert.equal((await publish(user.client, id)).status, 422);
    assert.equal((await createEvent(user, { pixelId: '123456', eventType: 'SHOPPING' })).status, 201);
    const ok = await publish(user.client, id);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(fake.callsTo('/adgroup/create/').at(-1).body.optimization_event, 'SHOPPING');
  });

  it('pixel que já tem o evento: publica sem nenhum aviso', async () => {
    const user = await owner();
    fake.state.pixels = { 9001: [pixelWith([ev('SHOPPING'), ev('ON_WEB_CART')])] };
    const { id } = await draft(user.client);
    assert.equal((await publish(user.client, id)).status, 200);
  });

  it('pixel sem eventos listados (novo: o TikTok atualiza a cada 2 a 4 horas) ou que não aparece na lista: não bloqueia; se o TikTok recusar, o erro vem explicado e a campanha retoma de onde parou', async () => {
    const user = await owner();
    fake.state.pixels = { 9001: [pixelWith([])] }; // lista vazia: não dá para afirmar nada; o TikTok (simulado) recusa porque o pixel declara `events`
    const { id } = await draft(user.client);
    fake.state.calls.length = 0;
    const res = await publish(user.client, id);
    assert.equal(res.status, 422, res.text);
    assert.equal(res.json.error.code, 'pixel_event_missing');
    assert.match(res.json.error.message, /Criar evento no pixel/);
    assert.match(res.json.error.message, /This pixel event type does not exist/, 'a mensagem original do TikTok segue entre parênteses');
    assert.equal(fake.callsTo('/campaign/create/').length, 1, 'a campanha chegou a ser criada (a lista vazia não permitia afirmar nada)');
    // corrige e tenta de novo: retoma sem duplicar a campanha
    assert.equal((await createEvent(user, { pixelId: '123456', eventType: 'SHOPPING' })).status, 201);
    const retry = await publish(user.client, id);
    assert.equal(retry.status, 200, retry.text);
    assert.equal(fake.callsTo('/campaign/create/').length, 1, 'não criou outra campanha');
    // pixel que a conta nem lista: não bloqueia por conta própria
    const user2 = await owner();
    fake.state.pixels = { 9001: [] };
    const draft2 = await draft(user2.client);
    fake.state.calls.length = 0;
    const res2 = await publish(user2.client, draft2.id);
    assert.equal(res2.status, 200, 'sem lista do pixel não há como afirmar: segue para o TikTok');
  });

  it('falha ao consultar os pixels não bloqueia a publicação (a checagem é só um aviso antecipado)', async () => {
    const user = await owner();
    fake.state.pixels = {};
    fake.state.failPixels = true;
    const { id } = await draft(user.client);
    const res = await publish(user.client, id);
    fake.state.failPixels = false;
    assert.equal(res.status, 200, res.text);
  });
});

describe('Criar evento no pixel: limite de pedidos', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: { ...LIMITS, tiktokPixelEvent: 2 }, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer: createFakeMailer() });
  });
  after(() => ctx.stop());

  it('depois de poucos pedidos seguidos o servidor responde 429; consultar continua liberado', async () => {
    const user = await createUser(ctx, { approve: true, email: emailOf() });
    fake.state.bcs = { 111: ['9001'] };
    fake.state.pixels = { 9001: [pixelWith([])] };
    await user.client.post('/api/tiktok/business-centers', { name: 'BC', bcId: '111', accessToken: GOOD_TOKEN });
    const url = '/api/tiktok/advertisers/9001/pixel-events';
    assert.equal((await user.client.post(url, { pixelId: '123456', eventType: 'SHOPPING' })).status, 201);
    assert.equal((await user.client.post(url, { pixelId: '123456', eventType: 'FORM' })).status, 201);
    assert.equal((await user.client.post(url, { pixelId: '123456', eventType: 'CONSULT' })).status, 429);
    assert.equal((await user.client.get('/api/tiktok/advertisers/9001/pixels')).status, 200);
  });
});
