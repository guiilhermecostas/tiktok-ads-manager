import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { IDENTITY_NAME_MAX, IDENTITY_PHOTO_MAX_BYTES, IDENTITY_PHOTO_MIN_SIDE, LISTABLE_IDENTITY_TYPES } from '../shared/identity.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, startTestServer } from './helpers.js';
import { jpegWithSize, pngWithSize } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, tiktokIdentity: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `id${++counter}@example.com`;
const identity = (id, name, extra = {}) => ({ identity_id: id, identity_type: 'CUSTOMIZED_USER', display_name: name, ...extra });

describe('Identidade do anúncio (regras compartilhadas)', () => {
  it('quais tipos o TikTok lista, o limite do nome e as regras da foto', () => {
    assert.deepEqual([...LISTABLE_IDENTITY_TYPES], ['CUSTOMIZED_USER', 'TT_USER', 'BC_AUTH_TT']);
    assert.equal(IDENTITY_NAME_MAX, 100);
    assert.equal(IDENTITY_PHOTO_MAX_BYTES, 2 * 1024 * 1024);
    assert.equal(IDENTITY_PHOTO_MIN_SIDE, 100);
  });
});

describe('Identidades da conta de anúncio e criação de identidade personalizada (API)', () => {
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
    fake.state.identities = {};
    fake.state.identityCreates = [];
    fake.state.failIdentityCreate = '';
    fake.state.failIdentityList = false;
    fake.state.failUpload = new Set();
    fake.state.uploadCalls = {};
    fake.state.calls.length = 0;
    return user;
  }
  const connect = (user, bcId = '111') => user.client.post('/api/tiktok/business-centers', { name: `BC ${bcId}`, bcId, accessToken: GOOD_TOKEN });
  const list = (user, query = '', adv = '9001') => user.client.get(`/api/tiktok/advertisers/${adv}/identities${query}`);
  const create = (user, { name = 'Dona Now', adv = '9001', photo = null, type = 'image/png', headers = {} } = {}) => {
    const query = name === null ? '' : `?name=${encodeURIComponent(name)}`; // null: sem o parâmetro
    return photo
      ? user.client.request('POST', `/api/tiktok/advertisers/${adv}/identities${query}`, { raw: photo, headers: { 'content-type': type, ...headers } })
      : user.client.post(`/api/tiktok/advertisers/${adv}/identities${query}`, {});
  };
  const createCalls = () => fake.callsTo('/identity/create/');
  const uploadCalls = () => fake.callsTo('/file/image/ad/upload/');

  // ---------- listar ----------
  it('lista as identidades personalizadas da conta (padrão), com nome, pelo token da Business Center dona', async () => {
    const user = await owner();
    await connect(user);
    fake.state.identities = { 9001: [identity('7000000000000000011', 'Dona Now'), identity('7000000000000000012', 'Loja Bia'), { identity_id: '7000000000000000013', identity_type: 'TT_USER', display_name: 'Outra', username: 'outra' }] };
    const res = await list(user);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.identities, [
      { id: '7000000000000000011', type: 'CUSTOMIZED_USER', name: 'Dona Now', username: '', available: true },
      { id: '7000000000000000012', type: 'CUSTOMIZED_USER', name: 'Loja Bia', username: '', available: true },
    ]);
    assert.equal(fake.callsTo('/identity/get/')[0].query.identity_type, 'CUSTOMIZED_USER');
    assert.deepEqual((await list(user, '', '9002')).json, { identities: [] }, 'conta sem identidade: lista vazia');
  });

  it('contas do TikTok (TT_USER): mostra o @, e só as que o TikTok diz AVAILABLE ficam disponíveis', async () => {
    const user = await owner();
    await connect(user);
    fake.state.identities = { 9001: [
      { identity_id: '7000000000000000021', identity_type: 'TT_USER', display_name: 'Ana', username: 'ana.ads', available_status: 'AVAILABLE' },
      { identity_id: '7000000000000000022', identity_type: 'TT_USER', display_name: 'Privada', username: 'priv', available_status: 'IS_PRIVATE_ACCOUNT' },
    ] };
    const { identities } = (await list(user, '?type=TT_USER')).json;
    assert.deepEqual(identities.map((i) => [i.name, i.username, i.available]), [['Ana', 'ana.ads', true], ['Privada', 'priv', false]]);
  });

  it('conta da Business Center (BC_AUTH_TT): pergunta pela BC dona da conta; tipo que o TikTok não lista é recusado', async () => {
    const user = await owner();
    await connect(user);
    fake.state.identities = { 9001: [{ identity_id: '7000000000000000031', identity_type: 'BC_AUTH_TT', display_name: 'Da BC', username: 'dabc', available_status: 'AVAILABLE' }] };
    const res = await list(user, '?type=BC_AUTH_TT');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.identities.length, 1);
    assert.equal(fake.callsTo('/identity/get/')[0].query.identity_authorized_bc_id, '111');
    for (const type of ['AUTH_CODE', 'XX', '', 'customized_user']) assert.equal((await list(user, `?type=${type}`)).status, 400, type);
  });

  it('o nome vem como TEXTO (HTML não é interpretado); valores estranhos são descartados e IDs repetidos viram um', async () => {
    const user = await owner();
    await connect(user);
    fake.state.identities = { 9001: [
      identity('7000000000000000041', '<img src=x onerror=alert(1)>'), identity('7000000000000000041', 'repetida'), identity('x', 'id curto demais'), identity('7000000000000000042', 'n'.repeat(300)), { identity_type: 'CUSTOMIZED_USER', display_name: 'sem id' },
    ] };
    const { identities } = (await list(user)).json;
    assert.deepEqual(identities.map((i) => i.id), ['7000000000000000041', '7000000000000000042']);
    assert.equal(identities[0].name, '<img src=x onerror=alert(1)>');
    assert.equal(identities[1].name.length, 100);
  });

  it('pagina quando há muitas (o TikTok aceita no máximo 100 por página)', async () => {
    const user = await owner();
    await connect(user);
    fake.state.identities = { 9001: Array.from({ length: 150 }, (_, i) => identity(String(7000000000001000 + i), `Identidade ${i}`)) };
    assert.equal((await list(user)).json.identities.length, 150);
    assert.deepEqual(fake.callsTo('/identity/get/').map((c) => c.query.page_size), ['100', '100']);
  });

  it('guarda a lista em cache por 60 s e "?fresh=1" ignora o cache', async () => {
    const user = await owner();
    await connect(user);
    fake.state.identities = { 9001: [identity('7000000000000000051', 'Primeira')] };
    await list(user);
    fake.state.identities = { 9001: [identity('7000000000000000051', 'Primeira'), identity('7000000000000000052', 'Segunda')] };
    assert.equal((await list(user)).json.identities.length, 1, 'em cache');
    assert.equal((await list(user, '?fresh=1')).json.identities.length, 2, 'fresh lê de novo');
  });

  it('falha do TikTok vira erro claro; conta de outra pessoa é 404; exige login', async () => {
    const user = await owner();
    await connect(user);
    fake.state.failIdentityList = true;
    const res = await list(user);
    assert.equal(res.status, 502);
    assert.match(res.json.error.message, /No permission to access identities/);
    fake.state.failIdentityList = false;
    assert.equal((await list(user, '', '9101')).status, 404, 'conta que não é de uma BC dele');
    const other = await createUser(ctx, { approve: true, email: emailOf() });
    assert.equal((await list(other)).status, 404, 'a BC de outra pessoa nem aparece');
    assert.equal((await ctx.client().get('/api/tiktok/advertisers/9001/identities')).status, 401);
    assert.equal((await list(user, '', 'abc')).status, 400);
  });

  // ---------- criar ----------
  it('cria SEM foto: o TikTok recebe só advertiser_id e display_name (usa a imagem padrão); a nova aparece na lista na hora', async () => {
    const user = await owner();
    await connect(user);
    await list(user); // aquece o cache
    const res = await create(user, { name: '  Dona   Now  ' });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(Object.keys(res.json.identity).sort(), ['available', 'id', 'name', 'type', 'username']);
    assert.deepEqual([res.json.identity.name, res.json.identity.type, res.json.identity.available], ['Dona Now', 'CUSTOMIZED_USER', true], 'espaços normalizados');
    assert.deepEqual(fake.state.identityCreates, [{ advertiser_id: '9001', display_name: 'Dona Now' }]);
    assert.equal(uploadCalls().length, 0, 'sem foto, nada é enviado à biblioteca de imagens');
    assert.deepEqual((await list(user)).json.identities.map((i) => i.id), [res.json.identity.id], 'o cache foi limpo');
  });

  it('cria COM foto quadrada (PNG): envia a imagem à conta (nome único e MD5 certo) e usa o image_id como image_uri', async () => {
    const user = await owner();
    await connect(user);
    const photo = pngWithSize(300, 300);
    const res = await create(user, { photo });
    assert.equal(res.status, 201, res.text);
    const [upload] = uploadCalls();
    assert.equal(upload.body.advertiser_id, '9001');
    assert.equal(upload.body.upload_type, 'UPLOAD_BY_FILE');
    assert.equal(upload.body.image_signature, createHash('md5').update(photo).digest('hex'));
    assert.match(upload.body.file_name, /^identidade-[0-9a-f]{12}\.png$/);
    assert.equal(upload.body.image_file.size, photo.length);
    assert.match(fake.state.identityCreates[0].image_uri, /^ad-site-i18n\/img\d+$/, 'usa o ID devolvido pelo upload');
    const jpg = await create(user, { name: 'Outra', photo: jpegWithSize(256, 256), type: 'image/jpeg' });
    assert.equal(jpg.status, 201, jpg.text);
    assert.match(uploadCalls()[1].body.file_name, /\.jpg$/);
    assert.notEqual(uploadCalls()[0].body.file_name, uploadCalls()[1].body.file_name, 'cada envio tem um nome diferente (o TikTok não aceita repetido)');
  });

  it('confere a foto pelo CONTEÚDO antes de falar com o TikTok: não quadrada, pequena, não é JPG/PNG, grande demais', async () => {
    const user = await owner();
    await connect(user);
    const cases = [
      ['não quadrada', { photo: pngWithSize(300, 200) }, 400, 'photo_not_square'],
      ['pequena demais', { photo: pngWithSize(60, 60) }, 400, 'photo_too_small'],
      ['conteúdo que não é imagem (declarado como PNG)', { photo: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }, 400, 'photo_invalid'],
      ['GIF declarado como JPEG', { photo: Buffer.from('GIF89a......'), type: 'image/jpeg' }, 400, 'photo_invalid'],
      ['grande demais (tamanho avisado)', { photo: Buffer.concat([pngWithSize(300, 300), Buffer.alloc(IDENTITY_PHOTO_MAX_BYTES)]) }, 413, 'photo_too_large'],
      ['tipo de arquivo que não é aceito', { photo: pngWithSize(300, 300), type: 'image/gif' }, 415, 'unsupported_media_type'],
      ['texto puro', { photo: Buffer.from('oi'), type: 'text/plain' }, 415, 'unsupported_media_type'],
    ];
    for (const [label, options, status, code] of cases) {
      const res = await create(user, options);
      assert.equal(res.status, status, `${label}: ${res.text}`);
      assert.equal(res.json.error.code, code, label);
    }
    assert.equal(uploadCalls().length + createCalls().length, 0, 'nada chegou ao TikTok');
  });

  it('valida o nome: vazio, só espaços, grande demais, caracteres de controle, repetido na URL ou ausente', async () => {
    const user = await owner();
    await connect(user);
    for (const name of ['', '   ', 'x'.repeat(IDENTITY_NAME_MAX + 1), 'linha\u0001quebrada', null]) assert.equal((await create(user, { name })).status, 400, JSON.stringify(name));
    assert.equal((await user.client.post('/api/tiktok/advertisers/9001/identities?name=a&name=b', {})).status, 400, 'name repetido na URL');
    assert.equal((await create(user, { name: 'x'.repeat(IDENTITY_NAME_MAX) })).status, 201, '100 caracteres é o limite');
    assert.equal(createCalls().length, 1);
  });

  it('o nome é guardado e devolvido como TEXTO (HTML não é interpretado)', async () => {
    const user = await owner();
    await connect(user);
    const res = await create(user, { name: '<img src=x onerror=alert(1)>' });
    assert.equal(res.status, 201);
    assert.equal(res.json.identity.name, '<img src=x onerror=alert(1)>');
  });

  it('erro do TikTok ao criar volta com a mensagem original; se a foto falhar, a identidade nem é criada', async () => {
    const user = await owner();
    await connect(user);
    fake.state.failIdentityCreate = 'display_name is duplicated';
    const failed = await create(user);
    assert.equal(failed.status, 502);
    assert.match(failed.json.error.message, /display_name is duplicated/);
    fake.state.failIdentityCreate = '';
    fake.state.failUpload.add('image');
    const noPhoto = await create(user, { photo: pngWithSize(300, 300) });
    assert.equal(noPhoto.status, 502);
    assert.equal(createCalls().length, 1, 'só a primeira tentativa chegou à criação');
    fake.state.failUpload.delete('image');
    assert.equal((await create(user, { photo: pngWithSize(300, 300) })).status, 201, 'depois dos erros tudo volta a funcionar');
  });

  it('entra no registro de atividades da equipe (quem, qual nome, em qual conta), sem a foto', async () => {
    const user = await owner();
    await connect(user);
    assert.equal((await create(user, { name: '' })).status, 400);
    assert.equal((await create(user, { name: 'Dona Now', photo: pngWithSize(300, 300) })).status, 201);
    let entry;
    for (let i = 0; i < 40 && !entry; i += 1) {
      entry = (await user.client.get('/api/team/activity?range=365')).json.entries.find((e) => e.action === 'identity.create');
      if (!entry) await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    assert.ok(entry, 'registrou');
    assert.equal(entry.targetName, 'Dona Now');
    assert.match(entry.details.account, /9001/);
    assert.ok(!JSON.stringify(entry).includes('image'), 'a foto não é registrada');
    const entries = (await user.client.get('/api/team/activity?range=365')).json.entries.filter((e) => e.action === 'identity.create');
    assert.equal(entries.length, 1, 'só o pedido que deu certo');
  });

  it('conta de outra pessoa: 404 e nada é enviado; exige login; o token nunca aparece', async () => {
    const user = await owner();
    await connect(user);
    assert.equal((await create(user, { adv: '9101' })).status, 404);
    const other = await createUser(ctx, { approve: true, email: emailOf() });
    assert.equal((await create(other)).status, 404);
    assert.equal((await ctx.client().post('/api/tiktok/advertisers/9001/identities?name=x', {})).status, 401);
    assert.equal((await create(user, { adv: 'abc' })).status, 400);
    assert.equal(createCalls().length, 0);
    const ok = await create(user, { photo: pngWithSize(300, 300) });
    assert.ok(!ok.text.includes(GOOD_TOKEN));
  });
});

describe('Criar identidade: limite de pedidos', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: { ...LIMITS, tiktokIdentity: 2 }, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer: createFakeMailer() });
  });
  after(() => ctx.stop());

  it('depois de poucos pedidos seguidos o servidor responde 429; consultar continua liberado', async () => {
    const user = await createUser(ctx, { approve: true, email: emailOf() });
    fake.state.bcs = { 111: ['9001'] };
    await user.client.post('/api/tiktok/business-centers', { name: 'BC', bcId: '111', accessToken: GOOD_TOKEN });
    const url = '/api/tiktok/advertisers/9001/identities?name=Teste';
    assert.equal((await user.client.post(url, {})).status, 201);
    assert.equal((await user.client.post(url, {})).status, 201);
    assert.equal((await user.client.post(url, {})).status, 429);
    assert.equal((await user.client.get('/api/tiktok/advertisers/9001/identities')).status, 200);
  });
});
