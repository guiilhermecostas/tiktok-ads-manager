import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MAX_CREATE_ADVERTISERS, accountNames, normalizeCountry, normalizeCurrency, normalizeTimezone } from '../shared/advertiser-create.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, one, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, tiktokCreate: 1000, tiktokCallback: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
const FORM = { bcId: '111', count: 1, name: 'Loja Nova', currency: 'USD', timezone: 'America/Sao_Paulo', company: 'Acme Ltda', registeredArea: 'US', industry: '290501' };
let counter = 0;
const emailOf = () => `ca${++counter}@example.com`;

describe('Regras compartilhadas da criação de contas (+ CA)', () => {
  it('nomes: uma conta mantém o nome; várias ganham número com dois dígitos', () => {
    assert.deepEqual(accountNames('  Loja ', 1), ['Loja']);
    assert.deepEqual(accountNames('Loja', 3), ['Loja 01', 'Loja 02', 'Loja 03']);
    assert.equal(accountNames('Loja', MAX_CREATE_ADVERTISERS).at(-1), 'Loja 10');
  });
  it('moeda, país e fuso: normalizam o que é válido e recusam o resto', () => {
    assert.equal(normalizeCurrency(' usd '), 'USD');
    for (const bad of ['US', 'USDX', '123', '', null, 5]) assert.equal(normalizeCurrency(bad), null);
    assert.equal(normalizeCountry('br'), 'BR');
    for (const bad of ['B', 'BRA', '1A', '', undefined]) assert.equal(normalizeCountry(bad), null);
    assert.equal(normalizeTimezone('America/Sao_Paulo'), 'America/Sao_Paulo');
    for (const bad of ['', 'Marte/Olimpo', "America/Sao_Paulo'; DROP", '../etc', 'a', null]) assert.equal(normalizeTimezone(bad), null);
  });
});

describe('Criar contas de anúncio dentro de uma Business Center (+ CA)', () => {
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
    await run(ctx.db, 'DELETE FROM tiktok_business_centers WHERE owner_id = $1', [user.id ?? (await one(ctx.db, 'SELECT id FROM users WHERE lower(email) = $1', [user.email.toLowerCase()])).id]);
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9101'], 555: [] };
    fake.state.validTokens.add(GOOD_TOKEN);
    fake.state.createdAdvertisers = [];
    fake.state.createdNames = {};
    fake.state.currencies = { 9001: 'BRL', 9002: 'USD', 9003: 'BRL' };
    fake.state.failAdvertiserCreateOnCall = 0;
    fake.state.hideCreatedAdvertisers = false;
    fake.state.omitCreatedAdvertiserId = false;
    fake.state.rejectFields = false;
    fake.state.bcInfo = {};
    fake.state.createDelayMs = 0;
    fake.state.calls.length = 0;
    return user;
  }
  const connect = async (user, bcId = '111') => (await user.client.post('/api/tiktok/business-centers', { name: `BC ${bcId}`, bcId, accessToken: GOOD_TOKEN })).json.businessCenter;
  const create = (user, bc, body = {}) => user.client.post(`/api/tiktok/business-centers/${bc.id}/advertisers`, { ...FORM, ...body });
  const createCalls = () => fake.callsTo('/bc/advertiser/create/');

  it('cria uma conta com o token da BC, no formato do TikTok, e ela já aparece na lista', async () => {
    const user = await owner();
    const bc = await connect(user);
    const res = await create(user, bc);
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.requested, 1);
    assert.equal(res.json.created.length, 1);
    assert.equal(res.json.created[0].name, 'Loja Nova');
    assert.match(res.json.created[0].id, /^\d+$/);
    assert.equal(res.json.visible, 1, 'a conta nova foi relida e já está na conexão');
    assert.equal(res.json.failure, null);
    assert.equal(res.json.businessCenter.advertiserCount, 3);

    const call = createCalls()[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.token, GOOD_TOKEN);
    assert.deepEqual(call.body, {
      bc_id: '111',
      advertiser_info: { name: 'Loja Nova', currency: 'USD', timezone: 'America/Sao_Paulo', type: 'AUCTION' },
      customer_info: { company: 'Acme Ltda', registered_area: 'US', industry: 290501 },
    });
    const list = (await user.client.get('/api/tiktok/advertisers')).json.advertisers;
    const made = list.find((a) => a.id === res.json.created[0].id);
    assert.ok(made, 'a conta aparece em Contas de anúncio');
    assert.equal(made.currency, 'USD');
    assert.equal(made.name, 'Loja Nova');
    assert.ok(!res.text.includes(GOOD_TOKEN), 'o token nunca volta ao navegador');
  });

  it('cria várias, uma de cada vez, com nomes numerados; contato e ramo opcionais vão no corpo', async () => {
    const user = await owner();
    const bc = await connect(user);
    const res = await create(user, bc, { count: 3, name: ' Loja   Escala ', contactEmail: 'Ads@Acme.Example', contactName: 'Maria', industry: '290104' });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.json.created.map((c) => c.name), ['Loja Escala 01', 'Loja Escala 02', 'Loja Escala 03']);
    assert.equal(new Set(res.json.created.map((c) => c.id)).size, 3, 'IDs diferentes');
    assert.equal(res.json.visible, 3);
    assert.deepEqual(createCalls().map((c) => c.body.advertiser_info.name), ['Loja Escala 01', 'Loja Escala 02', 'Loja Escala 03']);
    assert.deepEqual(createCalls()[0].body.contact_info, { email: 'ads@acme.example', name: 'Maria' });
    assert.equal(createCalls()[0].body.customer_info.industry, 290104);
  });

  it('o TikTok exige o ramo: sem ele o pedido é recusado aqui mesmo (nunca chega ao TikTok com o erro "only one industry param")', async () => {
    const user = await owner();
    const bc = await connect(user);
    const res = await create(user, bc, { industry: undefined });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /ramo de atividade/);
    assert.equal(createCalls().length, 0);
  });

  it('o ramo é lido da conta existente (advertiser/info) para vir preenchido, e se o TikTok recusar esse campo o restante ainda vem', async () => {
    const user = await owner();
    const bc = await connect(user);
    const ok = await user.client.get(`/api/tiktok/business-centers/${bc.id}/advertiser-defaults?bcId=111`);
    assert.equal(ok.json.defaults.industry, '292109');
    assert.ok(JSON.parse(fake.callsTo('/advertiser/info/').at(-1).query.fields).includes('industry'));
    fake.state.advertiserProfile = { company: 'Outra', country: 'US', industry: 'abc;drop' }; // valor estranho nunca é repassado
    assert.equal((await user.client.get(`/api/tiktok/business-centers/${bc.id}/advertiser-defaults?bcId=111`)).json.defaults.industry, null);
    fake.state.advertiserProfile = { company: 'Acme Ltda', country: 'BR', email: 'ads@acme.example', industry: '292109' };
  });

  it('valida TUDO antes de falar com o TikTok (nada é enviado quando algo está errado)', async () => {
    const user = await owner();
    const bc = await connect(user);
    const long = 'x'.repeat(91);
    const bad = [
      { count: 0 }, { count: 11 }, { count: 1.5 }, { count: '2' }, { count: null }, { count: undefined },
      { name: 'x' }, { name: long }, { name: '' }, { name: 'Linha\u0001quebrada' },
      { currency: 'US' }, { currency: 'REAL' }, { currency: '' },
      { timezone: 'Marte/Olimpo' }, { timezone: '' }, { company: '' }, { company: 'a' },
      { registeredArea: 'BRA' }, { registeredArea: '' }, { registeredArea: 'ZZ' }, { timezone: 'Etc/GMT+5' }, { industry: 999999 }, { industry: '1' }, { promotionLink: 'ftp://x.com' }, { promotionLink: 'javascript:alert(1)' }, { promotionLink: 'https://' + 'a'.repeat(300) + '.com' }, { promotionLink: 5 },
      { contactEmail: 'sem-arroba' }, { industry: 'abc' }, { industry: -4 }, { industry: 1.5 }, { industry: undefined }, { industry: '' }, { industry: null }, { industry: '12345678901' },
      { bcId: 'abc' }, { bcId: '' },
    ];
    for (const patch of bad) {
      const res = await create(user, bc, patch);
      assert.equal(res.status, 400, `${JSON.stringify(patch).slice(0, 60)} deveria ser recusado: ${res.text}`);
    }
    assert.equal((await user.client.post(`/api/tiktok/business-centers/${bc.id}/advertisers`, [])).status, 400, 'corpo que não é objeto');
    assert.equal(createCalls().length, 0, 'nenhuma chamada de criação saiu para o TikTok');
  });

  it('só cria na Business Center do TikTok que pertence à conexão', async () => {
    const user = await owner();
    const bc = await connect(user);
    const res = await create(user, bc, { bcId: '222' });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /não pertence a esta conexão/);
    assert.equal(createCalls().length, 0);
  });

  it('só o dono da conexão: outro usuário recebe 404 e nada é criado', async () => {
    const user = await owner();
    const bc = await connect(user);
    const stranger = await createUser(ctx, { approve: true, email: emailOf() });
    const res = await create(stranger, bc);
    assert.equal(res.status, 404);
    assert.equal((await stranger.client.get(`/api/tiktok/business-centers/${bc.id}/advertiser-defaults?bcId=111`)).status, 404);
    assert.equal(createCalls().length, 0);
  });

  it('colaborador: só com a área "Contas TikTok" (e age em nome do dono); sem ela, 403', async () => {
    const user = await owner();
    const bc = await connect(user);
    async function collaborator(areas) {
      const email = emailOf();
      const invited = await user.client.post('/api/team/invites', { email, name: 'Maria Colab', areas });
      assert.equal(invited.status, 201, invited.text);
      const client = ctx.client();
      const accepted = await client.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
      assert.equal(accepted.status, 201, accepted.text);
      client.csrf = accepted.json.csrfToken;
      return client;
    }
    const campaigns = await collaborator(['campaigns']);
    const denied = await campaigns.post(`/api/tiktok/business-centers/${bc.id}/advertisers`, FORM);
    assert.equal(denied.status, 403);
    assert.equal(createCalls().length, 0);
    const accounts = await collaborator(['accounts']);
    const allowed = await accounts.post(`/api/tiktok/business-centers/${bc.id}/advertisers`, { ...FORM, name: 'Feita pela equipe' });
    assert.equal(allowed.status, 201, allowed.text);
    assert.equal(allowed.json.created[0].name, 'Feita pela equipe');
  });

  it('sem sessão: 401', async () => {
    const res = await ctx.client().post('/api/tiktok/business-centers/1/advertisers', FORM);
    assert.equal(res.status, 401);
  });

  it('erro do TikTok na primeira conta: o motivo chega à tela e nada fica pela metade', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.failAdvertiserCreateOnCall = 1;
    fake.state.advertiserCreateError = 'No permission to create ad accounts';
    const res = await create(user, bc, { count: 3 });
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'tiktok_error');
    assert.match(res.json.error.message, /No permission to create ad accounts/);
    assert.equal(createCalls().length, 1, 'parou na primeira: as outras nem foram tentadas');
    assert.equal((await user.client.get('/api/tiktok/business-centers')).json.businessCenters[0].status, 'active', 'erro de permissão não derruba a conexão');
  });

  it('falha no meio: devolve o que foi criado, avisa o motivo e NÃO tenta as demais', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.failAdvertiserCreateOnCall = 2;
    fake.state.advertiserCreateError = 'Ad account limit reached';
    const res = await create(user, bc, { count: 4 });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.created.length, 1);
    assert.equal(res.json.requested, 4);
    assert.match(res.json.failure.message, /Ad account limit reached/);
    assert.equal(createCalls().length, 2, 'a 3ª e a 4ª não foram tentadas');
    assert.equal(res.json.visible, 1);
  });

  it('TikTok aceita mas não devolve o ID: conta contada como criada, sem ID, e a tela é avisada', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.omitCreatedAdvertiserId = true;
    const res = await create(user, bc);
    assert.equal(res.status, 201);
    assert.deepEqual(res.json.created, [{ id: null, name: 'Loja Nova' }]);
    assert.equal(res.json.visible, 0);
  });

  it('conta que o TikTok ainda não lista: criada, mas "visible" é 0 (a tela orienta a atualizar)', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.hideCreatedAdvertisers = true;
    const res = await create(user, bc, { count: 2 });
    assert.equal(res.status, 201);
    assert.equal(res.json.created.length, 2);
    assert.equal(res.json.visible, 0);
    assert.equal(res.json.businessCenter.advertiserCount, 2);
  });

  it('dois pedidos ao mesmo tempo na mesma conexão: só um roda, o outro recebe 409', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.createDelayMs = 150;
    const [a, b] = await Promise.all([create(user, bc), create(user, bc)]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    const refused = a.status === 409 ? a : b;
    assert.equal(refused.json.error.code, 'create_in_progress');
    assert.equal(createCalls().length, 1, 'apenas uma conta foi criada');
    fake.state.createDelayMs = 0;
    assert.equal((await create(user, bc)).status, 201, 'depois que termina, a trava é liberada');
  });

  it('a trava é liberada mesmo quando a criação falha', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.failAdvertiserCreateOnCall = 1;
    assert.equal((await create(user, bc)).status, 502);
    fake.state.failAdvertiserCreateOnCall = 0;
    assert.equal((await create(user, bc)).status, 201);
  });

  it('token revogado: pede para renovar o acesso e marca a conexão com erro', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.validTokens.delete(GOOD_TOKEN);
    const res = await create(user, bc);
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'tiktok_reauth');
    assert.equal((await user.client.get('/api/tiktok/business-centers')).json.businessCenters[0].status, 'error');
    const again = await create(user, bc);
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, 'tiktok_connection_error', 'conexão com erro: nem tenta');
  });

  describe('regras oficiais do TikTok por tipo de Business Center', () => {
    const info = (extra = {}) => ({ type: 'SELF_SERVICE', currency: 'USD', timezone: 'America/New_York', registered_area: 'US', company: 'Dezy BC', user_role: 'ADMIN', ...extra });

    it('BC de AGENCIA: o site da empresa é obrigatório (recusado aqui, antes de falar com o TikTok) e vai em qualification_info.promotion_link', async () => {
      const user = await owner();
      const bc = await connect(user);
      fake.state.bcInfo = { 111: info({ type: 'AGENCY' }) };
      const missing = await create(user, bc);
      assert.equal(missing.status, 400);
      assert.equal(missing.json.error.code, 'promotion_link_required');
      assert.equal(createCalls().length, 0);
      const ok = await create(user, bc, { promotionLink: 'https://minhaempresa.com/loja' });
      assert.equal(ok.status, 201, ok.text);
      assert.deepEqual(createCalls()[0].body.qualification_info, { promotion_link: 'https://minhaempresa.com/loja' });
      fake.state.bcInfo = { 111: info({ type: 'SELF_SERVICE_AGENCY' }) };
      assert.equal((await create(user, bc)).status, 400, 'agência de autoatendimento também exige');
    });

    it('BC DIRECT não pode receber qualification_info: o site, se vier, NÃO é enviado; BC comum não exige', async () => {
      const user = await owner();
      const bc = await connect(user);
      fake.state.bcInfo = { 111: info({ type: 'DIRECT' }) };
      const res = await create(user, bc, { promotionLink: 'https://minhaempresa.com' });
      assert.equal(res.status, 201, res.text);
      assert.equal(createCalls()[0].body.qualification_info, undefined);
      fake.state.bcInfo = { 111: info({ type: 'SELF_SERVICE' }) };
      assert.equal((await create(user, bc, { name: 'Outra' })).status, 201, 'sem site, BC de autoatendimento cria normalmente');
      assert.equal(createCalls().at(-1).body.qualification_info, undefined);
    });

    it('a moeda precisa ser a da BC e só administrador cria (checado antes de criar)', async () => {
      const user = await owner();
      const bc = await connect(user);
      fake.state.bcInfo = { 111: info({ currency: 'BRL' }) };
      const wrong = await create(user, bc, { currency: 'USD' });
      assert.equal(wrong.status, 400);
      assert.equal(wrong.json.error.code, 'currency_mismatch');
      assert.match(wrong.json.error.message, /BRL/);
      fake.state.bcInfo = { 111: info({ user_role: 'STANDARD' }) };
      const notAdmin = await create(user, bc);
      assert.equal(notAdmin.status, 403);
      assert.equal(notAdmin.json.error.code, 'bc_not_admin');
      assert.equal(createCalls().length, 0);
    });

    it('países que exigem documentos (BR, MX, FR, CN, HK) são recusados com explicação, tanto na conta quanto na BC', async () => {
      const user = await owner();
      const bc = await connect(user);
      for (const area of ['BR', 'MX', 'FR', 'CN', 'HK']) {
        const res = await create(user, bc, { registeredArea: area });
        assert.equal(res.status, 400, area);
        assert.equal(res.json.error.code, 'documents_required');
      }
      fake.state.bcInfo = { 111: info({ registered_area: 'BR' }) };
      assert.equal((await create(user, bc, { registeredArea: 'US' })).json.error.code, 'documents_required', 'BC registrada no Brasil também exige');
      assert.equal(createCalls().length, 0);
    });

    it('o ramo precisa ser da lista oficial do tipo da BC (autoatendimento tem lista menor)', async () => {
      const user = await owner();
      const bc = await connect(user);
      fake.state.bcInfo = { 111: info({ type: 'SELF_SERVICE' }) };
      const res = await create(user, bc, { industry: '292109' }); // só existe na lista das BCs de agência/diretas
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'invalid_industry');
      fake.state.bcInfo = { 111: info({ type: 'AGENCY' }) };
      assert.equal((await create(user, bc, { industry: '292109', promotionLink: 'https://x.com' })).status, 201);
      assert.equal(createCalls().length, 1);
    });

    it('o fuso do TikTok é rígido: código fora da tabela oficial (ex.: Etc/GMT+5, copiado de uma conta antiga) é recusado aqui', async () => {
      const user = await owner();
      const bc = await connect(user);
      const res = await create(user, bc, { timezone: 'Etc/GMT+5' });
      assert.equal(res.status, 400);
      assert.match(res.json.error.message, /lista do TikTok/);
      assert.equal(createCalls().length, 0);
    });

    it('sugestões vêm da BC (tipo, moeda, fuso, país, papel) e só aceitam fuso da tabela oficial', async () => {
      const user = await owner();
      const bc = await connect(user);
      fake.state.bcInfo = { 111: info({ type: 'AGENCY', currency: 'USD', timezone: 'Etc/GMT+5', registered_area: 'US', company: 'Dezy BC' }) };
      const res = await user.client.get(`/api/tiktok/business-centers/${bc.id}/advertiser-defaults?bcId=111`);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json.bc, { type: 'AGENCY', currency: 'USD', timezone: 'Etc/GMT+5', registeredArea: 'US', company: 'Dezy BC', name: 'BC 111', status: 'ENABLE', userRole: 'ADMIN', requiresPromotionLink: true, isAdmin: true, needsDocuments: false });
      assert.equal(res.json.defaults.timezone, 'America/Sao_Paulo', 'o fuso inválido da BC é descartado; vale o da conta (da tabela oficial)');
      assert.equal(res.json.defaults.currency, 'USD');
      assert.equal(res.json.defaults.country, 'US');
      assert.equal(res.json.defaults.industry, '292109');
      assert.deepEqual(fake.callsTo('/bc/get/').at(-1).query, { bc_id: '111', page: '1', page_size: '10' });
      fake.state.bcInfo = { 111: info({ type: 'SELF_SERVICE', timezone: 'America/New_York', user_role: 'STANDARD', registered_area: 'BR' }) };
      const second = (await user.client.get(`/api/tiktok/business-centers/${bc.id}/advertiser-defaults?bcId=111`)).json;
      assert.equal(second.defaults.timezone, 'America/New_York');
      assert.equal(second.defaults.industry, null, '292109 não vale em BC de autoatendimento');
      assert.deepEqual([second.bc.isAdmin, second.bc.needsDocuments, second.bc.requiresPromotionLink], [false, true, false]);
    });
  });

  it('erros comuns do TikTok viram instruções em português (com a mensagem original entre parênteses)', async () => {
    const user = await owner();
    const bc = await connect(user);
    const cases = [
      ['Information for this time zone does not exist.', /fuso horário.*\(TikTok: Information for this time zone/],
      ['You need to set only one industry param.', /ramo de atividade/],
      ['promotion_link is required', /site da empresa/],
      ['The daily quota of ad accounts has been exceeded', /Limite de contas.*Desative contas antigas/],
      ['No permission to create ad accounts', /administrador da Business Center/],
    ];
    for (const [message, expected] of cases) {
      fake.state.failAdvertiserCreateOnCall = fake.state.createdAdvertisers.length + 1;
      fake.state.advertiserCreateError = message;
      const res = await create(user, bc);
      assert.equal(res.status, 502, message);
      assert.match(res.json.error.message, expected, message);
      assert.ok(res.json.error.message.includes(message), 'a mensagem original continua visível');
    }
  });

  describe('sugestões do formulário', () => {
    it('traz moeda e fuso da conta existente e empresa/país/contato do cadastro dela', async () => {
      const user = await owner();
      const bc = await connect(user);
      fake.state.currencies = { ...fake.state.currencies, 9001: 'USD' }; // a conta modelo (a de menor ID) está em dólar
      const res = await user.client.get(`/api/tiktok/business-centers/${bc.id}/advertiser-defaults?bcId=111`);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.bc, null, 'sem dados da BC no TikTok');
      assert.deepEqual(res.json.defaults, { currency: 'USD', timezone: 'America/Sao_Paulo', company: 'Acme Ltda', country: 'BR', contactEmail: 'ads@acme.example', industry: '292109' });
      const info = fake.callsTo('/advertiser/info/').at(-1);
      assert.deepEqual(JSON.parse(info.query.advertiser_ids), ['9001']);
    });

    it('se o TikTok recusar os campos cadastrais, ainda sugere moeda e fuso que o sistema já conhece', async () => {
      const user = await owner();
      const bc = await connect(user);
      fake.state.rejectFields = true;
      const res = await user.client.get(`/api/tiktok/business-centers/${bc.id}/advertiser-defaults?bcId=111`);
      assert.equal(res.status, 200);
      assert.equal(res.json.defaults.currency, 'BRL');
      assert.equal(res.json.defaults.timezone, 'America/Sao_Paulo');
      assert.equal(res.json.defaults.company, null);
      assert.equal(res.json.defaults.industry, null);
    });

    it('recusa BC que não é da conexão e ID inválido', async () => {
      const user = await owner();
      const bc = await connect(user);
      assert.equal((await user.client.get(`/api/tiktok/business-centers/${bc.id}/advertiser-defaults?bcId=222`)).status, 400);
      assert.equal((await user.client.get(`/api/tiktok/business-centers/${bc.id}/advertiser-defaults?bcId=abc`)).status, 400);
      assert.equal((await user.client.get(`/api/tiktok/business-centers/${bc.id}/advertiser-defaults`)).status, 400);
    });
  });

  describe('conexão por link (várias Business Centers do TikTok)', () => {
    async function linkConnection(user, { bcId = '555', advertisers = ['9001'] } = {}) {
      const start = await user.client.post('/api/tiktok/connect', { name: 'Conta global 01' });
      assert.equal(start.status, 201, start.text);
      fake.grantAuthCode(`code-ca-${++counter}-xxxxxxxx`, { advertisers, bcId });
      const code = [...fake.state.authCodes.keys()].at(-1);
      const back = await ctx.client().get(`/api/tiktok/callback?auth_code=${code}&state=${encodeURIComponent(new URL(start.json.url).searchParams.get('state'))}`);
      assert.equal(back.status, 302);
      return (await user.client.get('/api/tiktok/business-centers')).json.businessCenters.at(0);
    }

    it('só aceita as BCs do TikTok identificadas na conexão; cria usando o token do link', async () => {
      const user = await owner();
      const bc = await linkConnection(user);
      assert.deepEqual(bc.bcIds, ['555']);
      assert.equal((await create(user, bc, { bcId: '111' })).status, 400, 'BC fora da conexão');
      const res = await create(user, bc, { bcId: '555', name: 'Conta via link' });
      assert.equal(res.status, 201, res.text);
      assert.equal(createCalls().length, 1);
      assert.equal(createCalls()[0].body.bc_id, '555');
      assert.match(createCalls()[0].token, /^oauth-token-/);
      assert.equal(res.json.created.length, 1);
      assert.equal(res.json.visible, 0, 'o token do link só lista as contas autorizadas: a nova precisa de "Renovar acesso"');
    });
  });
});

describe('Criar contas: limite de pedidos', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: { ...LIMITS, tiktokCreate: 2 }, config: tiktokTestConfig(), fetchFn: fake.fetchFn });
  });
  after(() => ctx.stop());

  it('depois de poucos pedidos em 10 minutos, o sistema responde 429 sem falar com o TikTok', async () => {
    const user = await createUser(ctx, { approve: true, email: emailOf() });
    fake.state.bcs = { 111: ['9001'] };
    const bc = (await user.client.post('/api/tiktok/business-centers', { name: 'BC', bcId: '111', accessToken: GOOD_TOKEN })).json.businessCenter;
    fake.state.createdAdvertisers = [];
    for (let i = 0; i < 2; i += 1) assert.equal((await user.client.post(`/api/tiktok/business-centers/${bc.id}/advertisers`, FORM)).status, 201);
    const limited = await user.client.post(`/api/tiktok/business-centers/${bc.id}/advertisers`, FORM);
    assert.equal(limited.status, 429);
    assert.equal(fake.callsTo('/bc/advertiser/create/').length, 2);
  });
});
