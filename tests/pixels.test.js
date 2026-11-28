import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
const pixel = (id, name = `Pixel ${id}`, code = `C${id}ABC`, owner = undefined) => ({ pixel_id: id, pixel_code: code, pixel_name: name, owner_bc_id: owner });
let counter = 0;
const emailOf = () => `px${++counter}@example.com`;

describe('Pixels que já existem na conta de anúncio', () => {
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
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9101'] };
    fake.state.pixels = {};
    fake.state.failPixels = false;
    fake.state.calls.length = 0;
    return user;
  }
  const connect = (user, bcId = '111', token = GOOD_TOKEN) => user.client.post('/api/tiktok/business-centers', { name: `BC ${bcId}`, bcId, accessToken: token });
  const pixelCalls = () => fake.callsTo('/pixel/list/');

  it('lista os pixels da conta (ID, código e nome), pelo token da Business Center dona', async () => {
    const user = await owner();
    await connect(user);
    fake.state.pixels = { 9001: [pixel('7001', 'Loja – compra'), pixel('7002', 'Leads')] };
    const res = await user.client.get('/api/tiktok/advertisers/9001/pixels');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.pixels, [{ id: '7001', code: 'C7001ABC', name: 'Loja – compra', ownerBcId: null, events: [], ownership: null, relation: null }, { id: '7002', code: 'C7002ABC', name: 'Leads', ownerBcId: null, events: [], ownership: null, relation: null }]);
    assert.equal(pixelCalls()[0].query.advertiser_id, '9001');
    assert.equal(pixelCalls()[0].token ?? pixelCalls()[0].headers?.['Access-Token'], pixelCalls()[0].token ?? GOOD_TOKEN);
    assert.deepEqual((await user.client.get('/api/tiktok/advertisers/9002/pixels')).json, { pixels: [] }, 'conta sem pixel: lista vazia');
  });

  it('devolve a Business Center dona do pixel (owner_bc_id), necessária para vincular o pixel a outras contas; valor estranho vira nulo', async () => {
    const user = await owner();
    await connect(user);
    fake.state.pixels = { 9001: [pixel('7010', 'Com dona', 'C7010ABC', '111'), pixel('7011', 'Dona inválida', 'C7011ABC', 'abc<script>')] };
    const { pixels } = (await user.client.get('/api/tiktok/advertisers/9001/pixels')).json;
    assert.deepEqual(pixels.map((p) => p.ownerBcId), ['111', null]);
  });

  it('o nome do pixel vem como TEXTO (HTML não é interpretado) e valores estranhos são descartados', async () => {
    const user = await owner();
    await connect(user);
    fake.state.pixels = { 9001: [pixel('7003', '<img src=x onerror=alert(1)>', 'AB<script>'), { pixel_id: 'abc', pixel_name: 'sem id numérico' }, { pixel_id: '7003', pixel_name: 'repetido' }, { pixel_name: 'sem id' }, pixel('7004', 'x'.repeat(500))] };
    const { pixels } = (await user.client.get('/api/tiktok/advertisers/9001/pixels')).json;
    assert.deepEqual(pixels.map((p) => p.id), ['7003', '7004'], 'só IDs numéricos, sem repetição');
    assert.equal(pixels[0].name, '<img src=x onerror=alert(1)>', 'devolvido como dado; a tela usa nó de texto');
    assert.equal(pixels[0].code, 'ABscript', 'o código só mantém letras, números, _ e -');
    assert.equal(pixels[1].name.length, 120, 'nome limitado');
  });

  it('pagina quando há muitos pixels (o TikTok aceita no máximo 20 por página)', async () => {
    const user = await owner();
    await connect(user);
    fake.state.pixels = { 9001: Array.from({ length: 120 }, (_, i) => pixel(String(8000 + i))) };
    const { pixels } = (await user.client.get('/api/tiktok/advertisers/9001/pixels')).json;
    assert.equal(pixels.length, 120);
    assert.equal(pixelCalls().length, 6, 'seis páginas de 20');
    assert.ok(pixelCalls().every((c) => c.query.page_size === '20'), 'page_size respeita o limite oficial (1 a 20)');
  });

  it('usa cache de 60 s: a segunda consulta não vai ao TikTok', async () => {
    const user = await owner();
    await connect(user);
    fake.state.pixels = { 9001: [pixel('7001')] };
    await user.client.get('/api/tiktok/advertisers/9001/pixels');
    await user.client.get('/api/tiktok/advertisers/9001/pixels');
    assert.equal(pixelCalls().length, 1);
  });

  it('"Atualizar" (?fresh=1) ignora o cache e mostra o pixel recém-criado', async () => {
    const user = await owner();
    await connect(user);
    fake.state.pixels = { 9001: [pixel('7001')] };
    assert.equal((await user.client.get('/api/tiktok/advertisers/9001/pixels')).json.pixels.length, 1);
    fake.state.pixels = { 9001: [pixel('7001'), pixel('7002')] };
    assert.equal((await user.client.get('/api/tiktok/advertisers/9001/pixels')).json.pixels.length, 1, 'sem pedir, vale o cache');
    assert.equal((await user.client.get('/api/tiktok/advertisers/9001/pixels?fresh=1')).json.pixels.length, 2);
    assert.equal((await user.client.get('/api/tiktok/advertisers/9001/pixels')).json.pixels.length, 2, 'e o cache passa a ter a lista nova');
  });

  it('isolamento: conta de outra BC/usuário dá 404 (e nada é consultado no TikTok); ID inválido, 400', async () => {
    const user = await owner();
    const stranger = await createUser(ctx, { approve: true, email: emailOf() });
    await connect(user);
    fake.state.pixels = { 9001: [pixel('7001')] };
    fake.state.calls.length = 0;
    assert.equal((await stranger.client.get('/api/tiktok/advertisers/9001/pixels')).status, 404);
    assert.equal((await user.client.get('/api/tiktok/advertisers/9101/pixels')).status, 404, 'conta que não é das BCs dele');
    for (const bad of ['abc', '9001;DROP', '1'.repeat(25), '-1']) assert.equal((await user.client.get(`/api/tiktok/advertisers/${encodeURIComponent(bad)}/pixels`)).status, 400, bad);
    assert.equal((await ctx.client().get('/api/tiktok/advertisers/9001/pixels')).status, 401);
    assert.equal(pixelCalls().length, 0);
  });

  it('erro do TikTok vira 502 com a mensagem do TikTok (padrão do sistema); token revogado vira 409 de reautorização', async () => {
    const user = await owner();
    await connect(user);
    fake.state.failPixels = true;
    const bad = await user.client.get('/api/tiktok/advertisers/9001/pixels');
    assert.equal(bad.status, 502);
    assert.equal(bad.json.error.code, 'tiktok_error');
    assert.match(bad.json.error.message, /^TikTok: /, 'a tela pode explicar o motivo ao usuário');
    assert.ok(!bad.text.includes(GOOD_TOKEN), 'nunca o token');
    fake.state.failPixels = false;
    fake.state.validTokens.delete(GOOD_TOKEN);
    const revoked = await user.client.get('/api/tiktok/advertisers/9002/pixels');
    assert.equal(revoked.status, 409);
    fake.state.validTokens.add(GOOD_TOKEN);
  });

  it('colaborador: só com "Campanhas" ou "Contas TikTok" (e o dono vê o do espaço dele)', async () => {
    const boss = await owner();
    await connect(boss, '111', OTHER_TOKEN);
    fake.state.pixels = { 9001: [pixel('7001')] };
    async function collaborator(areas) {
      const email = emailOf();
      await boss.client.post('/api/team/invites', { email, name: 'Colega', areas });
      const client = ctx.client();
      const accepted = await client.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
      client.csrf = accepted.json.csrfToken;
      return client;
    }
    const status = async (areas) => (await (await collaborator(areas)).get('/api/tiktok/advertisers/9001/pixels')).status;
    assert.equal(await status(['campaigns']), 200);
    assert.equal(await status(['accounts']), 200);
    assert.equal(await status(['creatives']), 403);
    assert.equal(await status(['reports']), 403);
  });
});
