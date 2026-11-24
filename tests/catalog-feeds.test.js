import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { csvTemplate, csvToProducts, describeSchedule, isPrivateHost, normalizeFeedInput, normalizeProduct, parseFeedUrl, parseQuantity, redactUrl } from '../shared/catalog.js';
import { createTiktokClient } from '../src/modules/tiktok/tiktok.client.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, catalogRead: 5000, catalogRefresh: 5000, catalogWrite: 5000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `feed${++counter}@example.com`;
const messageOf = (res) => res.json?.error?.message ?? res.json?.message ?? res.text;
const feed = (extra = {}) => ({ name: 'Feed da loja', url: 'https://loja.example.com/feed.xml', updateMode: 'INCREMENTAL', intervalType: 'HOURLY', intervalCount: 1, hour: 0, minute: 22, timezone: 'America/Sao_Paulo', ...extra });
const base = { skuId: 'A1', title: 'Camisa', description: 'Desc', brand: 'Marca', imageUrl: 'https://x.com/a.jpg', condition: 'NEW', price: 10, landingPageUrl: 'https://x.com/p' };

describe('Catálogo: quantidade em estoque vira disponibilidade (o TikTok só guarda a disponibilidade)', () => {
  it('quantidade maior que zero = em estoque; zero = sem estoque; a disponibilidade escolhida tem prioridade', () => {
    assert.equal(normalizeProduct({ ...base, quantity: 25 }).value.availability, 'IN_STOCK');
    assert.equal(normalizeProduct({ ...base, quantity: '0' }).value.availability, 'OUT_OF_STOCK');
    assert.equal(normalizeProduct({ ...base, quantity: '12,0' }).value.availability, 'IN_STOCK');
    assert.equal(normalizeProduct({ ...base, quantity: 0, availability: 'preorder' }).value.availability, 'PREORDER', 'a escolha explícita vale');
    assert.deepEqual(normalizeProduct({ ...base, quantity: 5 }).errors, []);
  });

  it('sem disponibilidade e sem quantidade é erro; quantidade inválida é erro (e não vira disponibilidade)', () => {
    assert.deepEqual(normalizeProduct(base).errors.map((e) => e.path), ['availability']);
    for (const bad of [-1, 1.5, 'abc', '1e3', 1e10, '12,5']) {
      const result = normalizeProduct({ ...base, quantity: bad });
      assert.ok(result.errors.some((e) => e.path === 'quantity'), String(bad));
      assert.equal(result.value.availability, undefined, String(bad));
    }
    assert.equal(parseQuantity(' 7 '), 7);
    assert.equal(parseQuantity(null), null);
  });

  it('CSV: aceita a coluna de quantidade (quantity, qty, estoque…) no lugar da disponibilidade', () => {
    const header = 'sku_id,title,description,quantity,condition,price,brand,image_link,link';
    const rows = ['A,Camisa,Desc,10,new,10,Marca,https://x.com/a.jpg,https://x.com/p', 'B,Calça,Desc,0,new,10,Marca,https://x.com/b.jpg,https://x.com/q', 'C,Bota,Desc,x,new,10,Marca,https://x.com/c.jpg,https://x.com/r'];
    const parsed = csvToProducts([header, ...rows].join('\n'));
    assert.equal(parsed.fatal, null, parsed.fatal);
    assert.deepEqual(parsed.products.map((p) => [p.skuId, p.availability]), [['A', 'IN_STOCK'], ['B', 'OUT_OF_STOCK']]);
    assert.deepEqual(parsed.rows.map((r) => r.errors.map((e) => e.path)), [[], [], ['quantity']]);
    assert.equal(csvToProducts(header.replace('quantity', 'estoque') + '\n' + rows[0]).products.length, 1);
    const none = csvToProducts('sku_id,title,description,condition,price,brand,image_link,link\nA,B,C,new,1,M,https://x.com/a.jpg,https://x.com/p');
    assert.ok(/Disponibilidade/.test(none.fatal), 'sem disponibilidade nem quantidade a coluna é obrigatória');
  });

  it('o modelo de CSV traz quantidade e vídeo do produto e continua válido', () => {
    assert.ok(csvTemplate().split('\n')[0].includes('quantity') && csvTemplate().split('\n')[0].includes('video_link'));
    const parsed = csvToProducts(csvTemplate());
    assert.equal(parsed.fatal, null);
    assert.deepEqual([parsed.products.length, parsed.products[0].availability, parsed.products[0].videoUrl], [1, 'IN_STOCK', 'https://exemplo.com/video/camiseta-azul.mp4']);
  });
});

describe('Catálogo: regras do feed de sincronização (documentação oficial de /catalog/feed/create/)', () => {
  it('URL do feed: http, https, ftp ou sftp, pública e sem usuário/senha embutidos', () => {
    for (const ok of ['https://loja.com/feed.xml', 'http://loja.com/f.csv', 'ftp://ftp.loja.com/f.tsv', 'sftp://sftp.loja.com/x.csv']) assert.equal(parseFeedUrl(ok).value, ok);
    for (const bad of ['', '   ', 'loja.com/feed', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/csv,a', 'https://u:p@loja.com/f.csv', 'https://loja.com/a b', `https://x.com/${'a'.repeat(2000)}`, null, 42]) assert.ok(parseFeedUrl(bad).error, String(bad));
  });

  it('recusa endereços que o TikTok não alcança (loopback, rede privada, link-local, nomes internos)', () => {
    for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', 'fd00::1', 'servidor', 'app.local', 'db.internal', '224.0.0.1']) assert.equal(isPrivateHost(host), true, host);
    for (const host of ['loja.com.br', '8.8.8.8', '172.32.0.1', '203.0.113.9', 'feed.minhaloja.com']) assert.equal(isPrivateHost(host), false, host);
    assert.ok(parseFeedUrl('http://169.254.169.254/latest/meta-data').error);
    assert.ok(parseFeedUrl('https://localhost:8080/f.xml').error);
  });

  it('feed válido: nome, URL, atualização, frequência com limites de cada tipo, hora, minuto e fuso da tabela oficial', () => {
    const { value, errors } = normalizeFeedInput(feed({ name: '  Feed   da loja ' }));
    assert.deepEqual(errors, []);
    assert.deepEqual([value.name, value.url, value.updateMode, value.intervalType, value.intervalCount, value.minute, value.timezone], ['Feed da loja', 'https://loja.example.com/feed.xml', 'INCREMENTAL', 'HOURLY', 1, 22, 'America/Sao_Paulo']);
    assert.equal(value.username, undefined);
  });

  it('limites por tipo: horas 1–23, dias 1–30, meses 1–12 (e mensal exige o dia, de 1 a 28)', () => {
    const bad = (extra) => normalizeFeedInput(feed(extra)).errors.map((e) => e.path);
    assert.deepEqual(bad({ intervalType: 'HOURLY', intervalCount: 24 }), ['intervalCount']);
    assert.deepEqual(bad({ intervalType: 'HOURLY', intervalCount: 0 }), ['intervalCount']);
    assert.deepEqual(bad({ intervalType: 'HOURLY', intervalCount: 23 }), []);
    assert.deepEqual(bad({ intervalType: 'DAILY', intervalCount: 31 }), ['intervalCount']);
    assert.deepEqual(bad({ intervalType: 'DAILY', intervalCount: 30 }), []);
    assert.deepEqual(bad({ intervalType: 'MONTHLY', intervalCount: 13, dayOfMonth: 5 }), ['intervalCount']);
    assert.deepEqual(bad({ intervalType: 'MONTHLY', intervalCount: 1 }), ['dayOfMonth'], 'mensal exige o dia');
    assert.deepEqual(bad({ intervalType: 'MONTHLY', intervalCount: 1, dayOfMonth: 29 }), ['dayOfMonth']);
    assert.deepEqual(bad({ intervalType: 'MONTHLY', intervalCount: 1, dayOfMonth: 28 }), []);
    assert.deepEqual(bad({ intervalType: 'WEEKLY' }), ['intervalType']);
    assert.deepEqual(bad({ hour: 24 }), ['hour']);
    assert.deepEqual(bad({ minute: 60 }), ['minute']);
    assert.deepEqual(bad({ timezone: 'Etc/GMT+5' }), ['timezone'], 'só fusos da tabela oficial');
    assert.deepEqual(bad({ timezone: '' }), ['timezone']);
    assert.deepEqual(bad({ updateMode: 'SUPPLEMENT' }), ['updateMode'], 'só INCREMENTAL e OVERWRITE na criação');
    assert.deepEqual(bad({ name: 'x' }), ['name']);
    assert.deepEqual(bad({ url: 'http://10.0.0.1/f' }), ['url']);
  });

  it('usuário e senha vêm juntos (ou nenhum) e a senha só existe no valor validado', () => {
    assert.deepEqual(normalizeFeedInput(feed({ username: 'loja', password: 's3nha!' })).errors, []);
    assert.equal(normalizeFeedInput(feed({ username: 'loja', password: 's3nha!' })).value.password, 's3nha!');
    assert.deepEqual(normalizeFeedInput(feed({ username: 'loja' })).errors.map((e) => e.path), ['password']);
    assert.deepEqual(normalizeFeedInput(feed({ password: 'x' })).errors.map((e) => e.path), ['username']);
    assert.deepEqual(normalizeFeedInput(feed({ username: '  ', password: '' })).errors, [], 'em branco = feed público');
    assert.ok(normalizeFeedInput(feed({ username: 'a'.repeat(201), password: 'x' })).errors.length);
    assert.ok(normalizeFeedInput(feed({ username: 'a\u0000b', password: 'x' })).errors.length);
    assert.ok(normalizeFeedInput(null).errors.length >= 5);
  });

  it('texto da agenda e remoção de credenciais de uma URL', () => {
    assert.equal(describeSchedule({ intervalType: 'HOURLY', intervalCount: 1, minute: 22 }), 'A cada hora, a partir do minuto 22');
    assert.equal(describeSchedule({ intervalType: 'HOURLY', intervalCount: 6, minute: 0 }), 'A cada 6 horas, a partir do minuto 00');
    assert.equal(describeSchedule({ intervalType: 'DAILY', intervalCount: 1, hour: 3, minute: 5 }), 'Todo dia, às 03:05');
    assert.equal(describeSchedule({ intervalType: 'MONTHLY', intervalCount: 2, dayOfMonth: 10, hour: 12, minute: 30 }), 'A cada 2 meses, no dia 10, às 12:30');
    assert.equal(describeSchedule({ intervalType: null }), 'Sem agenda (envio manual)');
    assert.equal(redactUrl('https://user:segredo@loja.com/feed.xml?x=1'), 'https://loja.com/feed.xml?x=1');
    assert.equal(redactUrl('sftp://u:p@h.com/f.csv'), 'sftp://h.com/f.csv');
    assert.equal(redactUrl('https://loja.com/f.csv'), 'https://loja.com/f.csv');
    assert.equal(redactUrl(null), null);
    assert.equal(redactUrl(''), null);
  });
});

describe('Catálogo: cliente do TikTok para feeds (contrato oficial)', () => {
  let fake;
  let api;
  let catalogId;
  before(async () => {
    fake = createFakeTiktok();
    api = createTiktokClient({ config: { tiktok: { apiBase: 'https://business-api.tiktok.com' } }, fetchFn: fake.fetchFn });
    catalogId = await api.createCatalog(GOOD_TOKEN, { bcId: '111', name: 'Loja', regionCode: 'BR', currency: 'BRL' });
  });
  const callsOf = (path) => fake.state.calls.filter((c) => c.path === path);
  const create = (extra = {}) => { const { value } = normalizeFeedInput(feed(extra)); return api.createCatalogFeed(GOOD_TOKEN, { bcId: '111', catalogId, ...value }); };

  it('criar: POST /catalog/feed/create/ com bc_id, catalog_id, feed_name, update_mode e schedule_param (source, interval, timezone, hour, minute)', async () => {
    fake.state.calls.length = 0;
    const created = await create();
    assert.deepEqual([created.name, created.status], ['Feed da loja', 'ON']);
    assert.deepEqual(callsOf('/catalog/feed/create/')[0].body, {
      bc_id: '111', catalog_id: catalogId, feed_name: 'Feed da loja', update_mode: 'INCREMENTAL', feed_type: 'DATA_FEED',
      schedule_param: { source: { uri: 'https://loja.example.com/feed.xml' }, interval_type: 'HOURLY', interval_count: 1, timezone: 'America/Sao_Paulo', hour: 0, minute: 22 },
    });
  });

  it('mensal envia day_of_month; com login envia username e password dentro de source', async () => {
    fake.state.calls.length = 0;
    await create({ intervalType: 'MONTHLY', intervalCount: 1, dayOfMonth: 10, hour: 4, username: 'loja', password: 'S3nha-Forte' });
    const sent = callsOf('/catalog/feed/create/')[0].body.schedule_param;
    assert.deepEqual([sent.day_of_month, sent.hour, sent.source.username, sent.source.password], [10, 4, 'loja', 'S3nha-Forte']);
    const hourly = await create();
    assert.ok(hourly.id);
    assert.equal('day_of_month' in callsOf('/catalog/feed/create/').at(-1).body.schedule_param, false, 'só o mensal leva o dia');
  });

  it('listar: o feed padrão (envios manuais) e os agendados, com agenda, URL e situação; credenciais nunca aparecem', async () => {
    const list = await api.listCatalogFeeds(GOOD_TOKEN, { bcId: '111', catalogId });
    const scheduled = list.filter((f) => f.url);
    assert.ok(list.some((f) => f.name === 'default' && f.url === null && f.status === 'OFF'));
    assert.ok(scheduled.length >= 3);
    assert.deepEqual([scheduled[0].intervalType, scheduled[0].intervalCount, scheduled[0].minute, scheduled[0].timezone, scheduled[0].updateMode, scheduled[0].status], ['HOURLY', 1, 22, 'America/Sao_Paulo', 'INCREMENTAL', 'ON']);
    assert.equal(JSON.stringify(list).includes('S3nha-Forte'), false);
    assert.ok(fake.state.feedCredentials.some((c) => c.password === 'S3nha-Forte'), 'o TikTok recebeu a senha');
  });

  it('uma URL de feed criada fora daqui com usuário e senha embutidos é devolvida SEM as credenciais', async () => {
    (fake.state.catalogFeeds[catalogId] ??= []).push({ feed_id: '99001', feed_name: 'Externo', feed_type: 'DATA_FEED', status: 'ON', last_update_param: { uri: 'https://admin:superSegredo@loja.com/feed.csv', update_mode: 'OVERWRITE', interval_type: 'DAILY', interval_count: 1, timezone: 'UTC', hour: 1, minute: 0 }, number_of_products: 7 });
    const list = await api.listCatalogFeeds(GOOD_TOKEN, { bcId: '111', catalogId });
    const external = list.find((f) => f.id === '99001');
    assert.equal(external.url, 'https://loja.com/feed.csv');
    assert.equal(JSON.stringify(list).includes('superSegredo'), false);
    assert.equal(JSON.stringify(list).includes('admin:'), false);
  });

  it('ligar e desligar a agenda; o TikTok só aceita um status diferente do atual', async () => {
    const created = await create();
    await api.switchCatalogFeed(GOOD_TOKEN, { bcId: '111', catalogId, feedId: created.id, status: 'OFF' });
    assert.deepEqual(callsOf('/catalog/feed/switch/').at(-1).body, { bc_id: '111', catalog_id: catalogId, feed_id: created.id, status: 'OFF' });
    await assert.rejects(api.switchCatalogFeed(GOOD_TOKEN, { bcId: '111', catalogId, feedId: created.id, status: 'OFF' }), (e) => /already OFF/.test(e.message));
    await api.switchCatalogFeed(GOOD_TOKEN, { bcId: '111', catalogId, feedId: created.id, status: 'ON' });
    await assert.rejects(api.switchCatalogFeed(GOOD_TOKEN, { bcId: '111', catalogId, feedId: created.id, status: 'TALVEZ' }), (e) => e.status === 400);
  });

  it('histórico: as últimas execuções com quantos entraram, mudaram, saíram e deram erro', async () => {
    const created = await create();
    const runs = await api.getCatalogFeedLog(GOOD_TOKEN, { bcId: '111', catalogId, feedId: created.id });
    assert.deepEqual([runs[0].status, runs[0].addCount, runs[0].updateCount, runs[0].removeCount, runs[0].errorCount, runs[0].warnCount], ['SUCCESS', 3, 1, 0, 0, 1]);
    assert.match(runs[0].startTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('excluir: POST /catalog/feed/delete/ e o feed some da lista', async () => {
    const created = await create({ name: 'Para excluir' });
    await api.deleteCatalogFeed(GOOD_TOKEN, { bcId: '111', catalogId, feedId: created.id });
    assert.equal((await api.listCatalogFeeds(GOOD_TOKEN, { bcId: '111', catalogId })).some((f) => f.id === created.id), false);
    await assert.rejects(api.deleteCatalogFeed(GOOD_TOKEN, { bcId: '111', catalogId, feedId: created.id }), (e) => /Feed not found/.test(e.message));
  });

  it('o simulado recusa o que fugir da documentação (a prova de que ele confere): URL sem esquema, contagem fora do limite, senha sem usuário', async () => {
    const send = (schedule, extra = {}) => api.createCatalogFeed(GOOD_TOKEN, { bcId: '111', catalogId, ...normalizeFeedInput(feed()).value, ...extra, ...schedule });
    await assert.rejects(send({ url: 'loja.com/feed' }), /must start with http/);
    await assert.rejects(send({ intervalCount: 24 }), /interval_count must be 1-23/);
    await assert.rejects(send({ intervalType: 'MONTHLY', intervalCount: 1, dayOfMonth: undefined }), /day_of_month/);
    await assert.rejects(send({ timezone: '' }), /timezone/);
  });
});

describe('Catálogo: API da sincronização (feeds)', () => {
  let ctx;
  let fake;
  let mailer;
  const logged = [];
  before(async () => {
    fake = createFakeTiktok();
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer });
  });
  after(() => ctx.stop());

  async function setup() {
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9101'] };
    fake.state.validTokens.add(GOOD_TOKEN);
    fake.state.validTokens.add(OTHER_TOKEN);
    fake.state.catalogs = {}; fake.state.catalogProducts = {}; fake.state.catalogFeeds = {}; fake.state.catalogFeedLogs2 = {}; fake.state.feedCredentials = [];
    fake.state.failCatalogFor = new Set();
    fake.state.calls.length = 0;
    return createUser(ctx, { approve: true, email: emailOf() });
  }
  const connect = async (user) => {
    const res = await user.client.post('/api/tiktok/business-centers', { name: 'BC 111', bcId: '111', accessToken: GOOD_TOKEN });
    assert.equal(res.status, 201, res.text);
    return res.json.businessCenter?.id ?? res.json.id;
  };
  const callsOf = (path) => fake.state.calls.filter((c) => c.path === path);
  const q = (id) => `connectionId=${id}&bcId=111`;
  async function newCatalog(user, connectionId) {
    const res = await user.client.post('/api/tiktok/catalogs', { connectionId, bcId: '111', name: 'Loja', regionCode: 'BR', currency: 'BRL' });
    assert.equal(res.status, 201, res.text);
    return res.json.catalog;
  }
  const body = (connectionId, extra = {}) => ({ connectionId, bcId: '111', ...feed(), ...extra });

  it('exige login e a área "Campanhas"', async () => {
    const anon = ctx.client();
    assert.equal((await anon.get('/api/tiktok/catalogs/1/feeds?connectionId=1&bcId=1')).status, 401);
    assert.equal((await anon.post('/api/tiktok/catalogs/1/feeds', {})).status, 401);
    assert.equal((await anon.delete('/api/tiktok/catalogs/1/feeds/1?connectionId=1&bcId=1')).status, 401);
  });

  it('CRIAR feed: envia ao TikTok o contrato oficial, devolve o feed e ele aparece na lista com o feed padrão', async () => {
    const user = await setup();
    const id = await connect(user);
    const catalog = await newCatalog(user, id);
    const res = await user.client.post(`/api/tiktok/catalogs/${catalog.id}/feeds`, body(id));
    assert.equal(res.status, 201, res.text);
    assert.deepEqual([res.json.feed.name, res.json.feed.status], ['Feed da loja', 'ON']);
    const sent = callsOf('/catalog/feed/create/').at(-1).body;
    assert.deepEqual([sent.bc_id, sent.catalog_id, sent.feed_name, sent.update_mode, sent.schedule_param.source.uri, sent.schedule_param.interval_type, sent.schedule_param.timezone], ['111', catalog.id, 'Feed da loja', 'INCREMENTAL', 'https://loja.example.com/feed.xml', 'HOURLY', 'America/Sao_Paulo']);
    const list = await user.client.get(`/api/tiktok/catalogs/${catalog.id}/feeds?${q(id)}`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.feeds.map((f) => [f.name, f.status]).sort(), [['Feed da loja', 'ON'], ['default', 'OFF']]);
  });

  it('a SENHA do feed vai ao TikTok e nunca volta: nem na criação, nem na lista, nem no histórico', async () => {
    const user = await setup();
    const id = await connect(user);
    const catalog = await newCatalog(user, id);
    const res = await user.client.post(`/api/tiktok/catalogs/${catalog.id}/feeds`, body(id, { username: 'loja', password: 'Senh4-Secret-XYZ' }));
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(fake.state.feedCredentials.map((c) => [c.username, c.password]), [['loja', 'Senh4-Secret-XYZ']], 'o TikTok recebeu o login');
    const list = await user.client.get(`/api/tiktok/catalogs/${catalog.id}/feeds?${q(id)}`);
    const runs = await user.client.get(`/api/tiktok/catalogs/${catalog.id}/feeds/${res.json.feed.id}/log?${q(id)}`);
    for (const response of [res, list, runs]) {
      assert.equal(response.text.includes('Senh4-Secret-XYZ'), false);
      assert.equal(response.text.includes('password'), false);
    }
  });

  it('valida TUDO antes de chamar o TikTok (URL pública, sem credenciais embutidas, limites, fuso, login completo)', async () => {
    const user = await setup();
    const id = await connect(user);
    const catalog = await newCatalog(user, id);
    const url = `/api/tiktok/catalogs/${catalog.id}/feeds`;
    fake.state.calls.length = 0;
    for (const [extra, pattern] of [
      [{ url: 'http://169.254.169.254/latest' }, /não é público/], [{ url: 'https://localhost/f.xml' }, /não é público/], [{ url: 'file:///etc/passwd' }, /http, https, ftp ou sftp/],
      [{ url: 'https://u:p@loja.com/f.xml' }, /usuário e senha/i], [{ intervalCount: 99 }, /a cada quantos/i], [{ timezone: 'Etc/GMT+5' }, /fuso/i],
      [{ username: 'so-usuario' }, /juntos/], [{ name: 'x' }, /nome do feed/], [{ updateMode: 'SUPPLEMENT' }, /como atualizar/], [{ intervalType: 'MONTHLY', intervalCount: 1 }, /dia do mês/],
    ]) {
      const res = await user.client.post(url, body(id, extra));
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.match(messageOf(res), pattern, JSON.stringify(extra));
    }
    assert.equal(callsOf('/catalog/feed/create/').length, 0, 'nada foi enviado ao TikTok');
    assert.equal((await user.client.post(url, { bcId: '111', ...feed() })).status, 400, 'sem connectionId');
    assert.equal((await user.client.post(url, [1])).status, 400);
  });

  it('ligar/desligar e excluir; feedId precisa ser numérico e o status ON ou OFF', async () => {
    const user = await setup();
    const id = await connect(user);
    const catalog = await newCatalog(user, id);
    const created = (await user.client.post(`/api/tiktok/catalogs/${catalog.id}/feeds`, body(id))).json.feed;
    const status = (feedId, st) => user.client.post(`/api/tiktok/catalogs/${catalog.id}/feeds/${feedId}/status`, { connectionId: id, bcId: '111', status: st });
    assert.deepEqual((await status(created.id, 'OFF')).json, { feedId: created.id, status: 'OFF' });
    assert.equal((await status(created.id, 'OFF')).status, 502, 'o TikTok recusa repetir o mesmo status (o erro dele chega à tela)');
    assert.equal((await status(created.id, 'TALVEZ')).status, 400);
    assert.equal((await status('abc', 'ON')).status, 400);
    assert.equal((await user.client.delete(`/api/tiktok/catalogs/${catalog.id}/feeds/abc?${q(id)}`)).status, 400);
    assert.equal((await user.client.delete(`/api/tiktok/catalogs/${catalog.id}/feeds/${created.id}?${q(id)}`)).status, 204);
    const list = await user.client.get(`/api/tiktok/catalogs/${catalog.id}/feeds?${q(id)}`);
    assert.deepEqual(list.json.feeds.map((f) => f.name), ['default']);
  });

  it('histórico do feed: execuções com contagens', async () => {
    const user = await setup();
    const id = await connect(user);
    const catalog = await newCatalog(user, id);
    const created = (await user.client.post(`/api/tiktok/catalogs/${catalog.id}/feeds`, body(id))).json.feed;
    const runs = await user.client.get(`/api/tiktok/catalogs/${catalog.id}/feeds/${created.id}/log?${q(id)}`);
    assert.equal(runs.status, 200);
    assert.deepEqual([runs.json.runs[0].status, runs.json.runs[0].addCount, runs.json.runs[0].updateCount], ['SUCCESS', 3, 1]);
    assert.equal((await user.client.get(`/api/tiktok/catalogs/${catalog.id}/feeds/zzz/log?${q(id)}`)).status, 400);
  });

  it('isolamento e permissão: outro usuário não vê nem mexe; usuário de BC compartilhada só LÊ', async () => {
    const owner = await setup();
    const id = await connect(owner);
    const catalog = await newCatalog(owner, id);
    const created = (await owner.client.post(`/api/tiktok/catalogs/${catalog.id}/feeds`, body(id))).json.feed;
    const intruder = await createUser(ctx, { approve: true, email: emailOf() });
    const url = `/api/tiktok/catalogs/${catalog.id}/feeds`;
    assert.equal((await intruder.client.get(`${url}?${q(id)}`)).status, 404);
    assert.equal((await intruder.client.post(url, body(id))).status, 404);
    assert.equal((await intruder.client.post(`${url}/${created.id}/status`, { connectionId: id, bcId: '111', status: 'OFF' })).status, 404);
    assert.equal((await intruder.client.delete(`${url}/${created.id}?${q(id)}`)).status, 404);
    await run(ctx.db, 'UPDATE tiktok_business_centers SET shared = true WHERE id = $1', [id]);
    const viewer = await createUser(ctx, { approve: true, email: emailOf() });
    assert.equal((await viewer.client.get(`${url}?${q(id)}`)).status, 200, 'pode ver');
    assert.equal((await viewer.client.get(`${url}/${created.id}/log?${q(id)}`)).status, 200);
    assert.equal((await viewer.client.post(url, body(id))).status, 403);
    assert.equal((await viewer.client.post(`${url}/${created.id}/status`, { connectionId: id, bcId: '111', status: 'OFF' })).status, 403);
    assert.equal((await viewer.client.delete(`${url}/${created.id}?${q(id)}`)).status, 403);
    assert.equal(logged.length, 0);
  });
});
