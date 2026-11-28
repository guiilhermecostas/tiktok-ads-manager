import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MAX_LINK_ADVERTISERS, PIXEL_CODE_RE, PIXEL_LINK_ACTIONS, normalizePixelCode } from '../shared/pixel-link.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, tiktokPixelLink: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
const CODE = 'CABC123XYZ789';
let counter = 0;
const emailOf = () => `pl${++counter}@example.com`;

describe('Vínculo de pixel (regras compartilhadas)', () => {
  it('o código do pixel tem letras e números (6 a 40), sem espaços nas pontas', () => {
    assert.equal(normalizePixelCode('  CABC123XYZ789 '), 'CABC123XYZ789');
    assert.equal(normalizePixelCode('abc123'), 'abc123', 'não muda maiúsculas e minúsculas');
    for (const bad of ['', '   ', 'ABC12', 'A'.repeat(41), 'ABC 123456', 'ABC-123456', 'ABC_123456', "ABC123456'; DROP", 12345678, null, undefined, {}, ['ABC123456']]) assert.equal(normalizePixelCode(bad), null, JSON.stringify(bad));
    assert.ok(PIXEL_CODE_RE.test('A'.repeat(40)));
  });

  it('as ações e o limite de contas por pedido', () => {
    assert.deepEqual([...PIXEL_LINK_ACTIONS], ['LINK', 'UNLINK']);
    assert.equal(MAX_LINK_ADVERTISERS, 50);
  });
});

describe('Vincular pixel a contas de anúncio (API)', () => {
  let ctx;
  let fake;
  let mailer;
  before(async () => {
    fake = createFakeTiktok();
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer });
  });
  after(() => ctx.stop());

  async function owner() {
    const user = await createUser(ctx, { approve: true, email: emailOf() });
    fake.state.bcs = { 111: ['9001', '9002', '9003'], 222: ['9101'] };
    fake.state.pixels = {};
    fake.state.pixelLinks = {};
    fake.state.pixelLinkCalls = [];
    fake.state.failPixelLink = '';
    fake.state.pixelLinkDelayMs = 0;
    fake.state.pixelLinkPageSize = 0;
    fake.state.calls.length = 0;
    return user;
  }
  const connect = async (user, bcId = '111') => (await user.client.post('/api/tiktok/business-centers', { name: `BC ${bcId}`, bcId, accessToken: GOOD_TOKEN })).json.businessCenter;
  const link = (user, bc, body) => user.client.post(`/api/tiktok/business-centers/${bc.id}/pixel-links`, { bcId: '111', pixelCode: CODE, advertiserIds: ['9001'], action: 'LINK', ...body });
  const linked = async (user, bc, query = `bcId=111&pixelCode=${CODE}`) => (await user.client.get(`/api/tiktok/business-centers/${bc.id}/pixel-links?${query}`)).json;
  const updateCalls = () => fake.callsTo('/bc/pixel/link/update/');

  it('vincula o pixel a várias contas (no formato do TikTok) e confirma lendo o vínculo de volta', async () => {
    const user = await owner();
    const bc = await connect(user);
    const res = await link(user, bc, { advertiserIds: ['9001', '9002'] });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, { action: 'LINK', requested: 2, advertiserIds: ['9001', '9002'] });
    assert.deepEqual(fake.state.pixelLinkCalls, [{ bc_id: '111', pixel_code: CODE, advertiser_ids: ['9001', '9002'], relation_status: 'LINK' }]);
    assert.equal(updateCalls().length, 1);
    assert.deepEqual(await linked(user, bc), { advertiserIds: ['9001', '9002'] });
  });

  it('desvincula só as contas pedidas; as outras continuam vinculadas', async () => {
    const user = await owner();
    const bc = await connect(user);
    await link(user, bc, { advertiserIds: ['9001', '9002', '9003'] });
    const res = await link(user, bc, { advertiserIds: ['9002'], action: 'UNLINK' });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, { action: 'UNLINK', requested: 1, advertiserIds: ['9001', '9003'] });
    assert.equal(fake.state.pixelLinkCalls.at(-1).relation_status, 'UNLINK');
  });

  it('IDs repetidos viram um só; o vínculo repetido não dá erro', async () => {
    const user = await owner();
    const bc = await connect(user);
    const res = await link(user, bc, { advertiserIds: ['9001', '9001', '9001'] });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.requested, 1);
    assert.deepEqual(fake.state.pixelLinkCalls[0].advertiser_ids, ['9001']);
    assert.equal((await link(user, bc, { advertiserIds: ['9001'] })).status, 200, 'vincular de novo é inofensivo');
  });

  it('o vínculo some da lista de pixels? A lista da conta é relida (o cache de 60 s é limpo)', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.pixels = { 9001: [] };
    assert.deepEqual((await user.client.get('/api/tiktok/advertisers/9001/pixels')).json, { pixels: [] });
    fake.state.pixels = { 9001: [{ pixel_id: '7001', pixel_code: CODE, pixel_name: 'Loja' }] };
    assert.deepEqual((await user.client.get('/api/tiktok/advertisers/9001/pixels')).json, { pixels: [] }, 'em cache por 60 s');
    assert.equal((await link(user, bc)).status, 200);
    assert.equal((await user.client.get('/api/tiktok/advertisers/9001/pixels')).json.pixels[0].id, '7001', 'depois de vincular a lista é relida');
  });

  it('lê o vínculo em várias páginas e para se o TikTok ignorar a página (nunca fica em laço)', async () => {
    const user = await owner();
    fake.state.bcs = { 111: ['9001', '9002', '9003', '9004', '9005'] };
    const bc = await connect(user);
    fake.state.pixelLinks[`111:${CODE}`] = ['9001', '9002', '9003', '9004', '9005'];
    fake.state.pixelLinkPageSize = 2;
    assert.deepEqual((await linked(user, bc)).advertiserIds.sort(), ['9001', '9002', '9003', '9004', '9005']);
    assert.equal(fake.callsTo('/bc/pixel/link/get/').length, 3, 'três páginas de 2, 2 e 1');
  });

  it('só mostra as contas DESTA conexão (contas de outra conexão que o TikTok listar não aparecem)', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.pixelLinks[`111:${CODE}`] = ['9001', '9999'];
    assert.deepEqual(await linked(user, bc), { advertiserIds: ['9001'] });
  });

  it('valida o pedido ANTES de falar com o TikTok (código, BC, contas, ação)', async () => {
    const user = await owner();
    const bc = await connect(user);
    const bad = [
      { pixelCode: 'curto' }, { pixelCode: 'ABC 123456' }, { pixelCode: 12345678 }, { pixelCode: undefined },
      { bcId: 'abc' }, { bcId: '' }, { bcId: undefined },
      { advertiserIds: [] }, { advertiserIds: 'x' }, { advertiserIds: ['abc'] }, { advertiserIds: [9001] }, { advertiserIds: undefined },
      { advertiserIds: Array.from({ length: MAX_LINK_ADVERTISERS + 1 }, (_, i) => String(9000 + i)) },
      { action: 'link' }, { action: 'DELETE' }, { action: undefined },
    ];
    for (const body of bad) assert.equal((await link(user, bc, body)).status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal((await user.client.post(`/api/tiktok/business-centers/${bc.id}/pixel-links`, [])).status, 400);
    assert.equal(updateCalls().length, 0, 'nada chegou ao TikTok');
    for (const query of ['', 'bcId=111', `pixelCode=${CODE}`, `bcId=abc&pixelCode=${CODE}`, 'bcId=111&pixelCode=curto']) assert.equal((await user.client.get(`/api/tiktok/business-centers/${bc.id}/pixel-links?${query}`)).status, 400, query);
    assert.equal((await user.client.post('/api/tiktok/business-centers/abc/pixel-links', {})).status, 400);
  });

  it('conta que não é desta conexão: 404 e nada é enviado ao TikTok (nem a de uma BC parecida)', async () => {
    const user = await owner();
    const bc = await connect(user);
    const res = await link(user, bc, { advertiserIds: ['9001', '9101'] });
    assert.equal(res.status, 404);
    assert.equal(updateCalls().length, 0);
  });

  it('a Business Center do TikTok precisa ser uma desta conexão (400); conexão alheia ou inexistente é 404', async () => {
    const user = await owner();
    const bc = await connect(user);
    assert.equal((await link(user, bc, { bcId: '222' })).status, 400, 'BC do TikTok que não é desta conexão');
    assert.equal((await user.client.get(`/api/tiktok/business-centers/${bc.id}/pixel-links?bcId=222&pixelCode=${CODE}`)).status, 400);
    assert.equal((await link(user, { id: 999999 })).status, 404);
    const other = await createUser(ctx, { approve: true, email: emailOf() });
    assert.equal((await link(other, bc)).status, 404, 'a conexão de outra pessoa nem aparece');
    assert.equal((await other.client.get(`/api/tiktok/business-centers/${bc.id}/pixel-links?bcId=111&pixelCode=${CODE}`)).status, 404);
    assert.equal(updateCalls().length, 0);
  });

  it('exige login (consultar e vincular)', async () => {
    const user = await owner();
    const bc = await connect(user);
    const anon = ctx.client();
    assert.equal((await anon.get(`/api/tiktok/business-centers/${bc.id}/pixel-links?bcId=111&pixelCode=${CODE}`)).status, 401);
    assert.equal((await anon.post(`/api/tiktok/business-centers/${bc.id}/pixel-links`, { bcId: '111', pixelCode: CODE, advertiserIds: ['9001'], action: 'LINK' })).status, 401);
    assert.equal(updateCalls().length, 0);
  });

  it('erro do TikTok vira explicação em português (com o texto original entre parênteses) e não derruba nada', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.failPixelLink = 'No permission: admin role required';
    const res = await link(user, bc);
    assert.equal(res.status, 502);
    assert.match(res.json.error.message, /administrador do pixel/);
    assert.match(res.json.error.message, /No permission: admin role required/);
    fake.state.failPixelLink = '';
    assert.equal((await link(user, bc)).status, 200, 'depois do erro tudo volta a funcionar');
  });

  it('um vínculo por vez em cada conexão: o segundo pedido durante o primeiro é 409 e depois libera', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.pixelLinkDelayMs = 300;
    const [first, second] = await Promise.all([link(user, bc), link(user, bc, { advertiserIds: ['9002'] })]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    assert.equal([first, second].find((r) => r.status === 409).json.error.code, 'link_in_progress');
    fake.state.pixelLinkDelayMs = 0;
    assert.equal((await link(user, bc, { advertiserIds: ['9002'] })).status, 200, 'liberou');
  });

  it('conexão com erro: 409 antes de falar com o TikTok', async () => {
    const user = await owner();
    const bc = await connect(user);
    await run(ctx.db, "UPDATE tiktok_business_centers SET status = 'error' WHERE id = $1", [bc.id]);
    const res = await link(user, bc);
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'tiktok_connection_error');
    assert.equal(updateCalls().length, 0);
  });

  it('entra no registro de atividades da equipe (quem, qual pixel, quais contas) e uma tentativa recusada não entra', async () => {
    const user = await owner();
    const bc = await connect(user);
    assert.equal((await link(user, bc, { pixelCode: 'curto' })).status, 400);
    assert.equal((await link(user, bc, { advertiserIds: ['9001', '9002'], action: 'LINK' })).status, 200);
    let entry;
    for (let i = 0; i < 40 && !entry; i += 1) {
      entry = (await user.client.get('/api/team/activity?range=365')).json.entries.find((e) => e.action === 'pixel.link');
      if (!entry) await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    assert.ok(entry, 'registrou');
    assert.equal(entry.targetName, `Pixel ${CODE}`);
    assert.deepEqual([entry.details.change, entry.details.count, entry.details.accounts], ['Vinculou', 2, ['ID 9001', 'ID 9002']]);
    const all = (await user.client.get('/api/team/activity?range=365')).json.entries.filter((e) => e.action === 'pixel.link');
    assert.equal(all.length, 1, 'só o pedido que deu certo');
  });

  it('o token da conexão nunca aparece na resposta', async () => {
    const user = await owner();
    const bc = await connect(user);
    const res = await link(user, bc);
    assert.ok(!res.text.includes(GOOD_TOKEN));
    assert.ok(!(await user.client.get(`/api/tiktok/business-centers/${bc.id}/pixel-links?bcId=111&pixelCode=${CODE}`)).text.includes(GOOD_TOKEN));
  });
});

describe('Vincular pixel: limite de pedidos e registro de atividade', () => {
  let ctx;
  let fake;
  let mailer;
  before(async () => {
    fake = createFakeTiktok();
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: { ...LIMITS, tiktokPixelLink: 2 }, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer });
  });
  after(() => ctx.stop());

  it('depois de poucos pedidos seguidos o servidor responde 429 (protege os ativos da Business Center)', async () => {
    const user = await createUser(ctx, { approve: true, email: emailOf() });
    fake.state.bcs = { 111: ['9001'] };
    const bc = (await user.client.post('/api/tiktok/business-centers', { name: 'BC', bcId: '111', accessToken: GOOD_TOKEN })).json.businessCenter;
    const body = { bcId: '111', pixelCode: CODE, advertiserIds: ['9001'], action: 'LINK' };
    const url = `/api/tiktok/business-centers/${bc.id}/pixel-links`;
    assert.equal((await user.client.post(url, body)).status, 200);
    assert.equal((await user.client.post(url, body)).status, 200);
    const third = await user.client.post(url, body);
    assert.equal(third.status, 429);
    assert.equal((await user.client.get(`${url}?bcId=111&pixelCode=${CODE}`)).status, 200, 'consultar continua liberado');
  });
});
