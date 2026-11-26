import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MAX_HIDDEN_PER_USER, MAX_HIDE_BATCH, STATUS_FILTERS, bcOptions, filterCatalogs, hasActiveFilters, normalizeFilters, normalizeHideInput, regionOptions } from '../shared/catalog-filters.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, catalogRead: 5000, catalogRefresh: 5000, catalogWrite: 5000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `chd${++counter}@example.com`;
const cat = (n, extra = {}) => ({ id: String(n), bcId: '111', bcName: 'Minha BC', name: `Catálogo ${n}`, regionCode: 'US', currency: 'USD', adCreationEligible: true, hidden: false, ...extra });

describe('Filtros e "ocultar" do catálogo: regras compartilhadas', () => {
  const list = [
    cat(1), cat(2, { adCreationEligible: false }), cat(3, { bcId: '222', bcName: 'Agência Dezy' }), cat(4, { bcId: '222', bcName: 'Agência Dezy', regionCode: 'BR', currency: 'BRL', hidden: true }),
    cat(5, { name: 'Moda Praia' }),
  ];
  const ids = (filters) => filterCatalogs(list, filters).map((c) => c.id);

  it('sem filtro mostra todos, MENOS os ocultos (só aparecem ao pedir)', () => {
    assert.deepEqual(ids({}), ['1', '2', '3', '5']);
    assert.deepEqual(ids({ showHidden: true }), ['1', '2', '3', '4', '5']);
    assert.deepEqual(ids(null), ['1', '2', '3', '5']);
  });

  it('filtra por Business Center (uma opção por BC, não por conexão)', () => {
    assert.deepEqual(ids({ bcId: '222' }), ['3']);
    assert.deepEqual(ids({ bcId: '222', showHidden: true }), ['3', '4']);
    assert.deepEqual(ids({ bcId: '999' }), []);
  });

  it('filtra por situação, por país/moeda e por busca (nome, ID, nome da BC; sem acento nem maiúsculas)', () => {
    assert.deepEqual(ids({ status: 'ready' }), ['1', '3', '5']);
    assert.deepEqual(ids({ status: 'empty' }), ['2']);
    assert.deepEqual(ids({ region: 'US · USD' }), ['1', '2', '3', '5']);
    assert.deepEqual(ids({ region: 'BR · BRL', showHidden: true }), ['4']);
    assert.deepEqual(ids({ q: 'moda' }), ['5']);
    assert.deepEqual(ids({ q: '  3 ' }), ['3']);
    assert.deepEqual(ids({ q: 'AGENCIA' }), ['3'], 'a busca ignora o acento de "Agência"');
    assert.deepEqual(ids({ q: 'agência', bcId: '222', status: 'ready' }), ['3'], 'os filtros se combinam');
    assert.deepEqual(ids({ q: 'nada disso' }), []);
  });

  it('valores inválidos viram "sem filtro" (nunca quebram a tela)', () => {
    assert.deepEqual(normalizeFilters({ bcId: '1; DROP', status: 'hack', region: 5, q: {}, showHidden: 'sim' }), { bcId: '', status: '', region: '', q: '', showHidden: false });
    assert.equal(normalizeFilters({ q: 'x'.repeat(500) }).q.length, 100);
    assert.equal(hasActiveFilters(normalizeFilters({})), false);
    assert.equal(hasActiveFilters(normalizeFilters({ status: 'ready' })), true);
    assert.equal(hasActiveFilters(normalizeFilters({ q: '   ' })), false, 'só espaços não é filtro');
    assert.equal(hasActiveFilters(normalizeFilters({ showHidden: true })), false, '"mostrar ocultos" não conta como filtro');
    assert.deepEqual(STATUS_FILTERS.map(([k]) => k), ['', 'ready', 'empty']);
  });

  it('opções do filtro: uma por BC com nome e contagem (sem os ocultos); países e moedas distintos', () => {
    assert.deepEqual(bcOptions(list), [
      { bcId: '222', name: 'Agência Dezy', count: 1 },
      { bcId: '111', name: 'Minha BC', count: 3 },
    ]);
    assert.deepEqual(bcOptions(list, { countHidden: true }).map((o) => [o.bcId, o.count]), [['222', 2], ['111', 3]]);
    assert.deepEqual(regionOptions(list), ['US · USD']);
    assert.deepEqual(regionOptions(list, { countHidden: true }), ['BR · BRL', 'US · USD']);
    assert.deepEqual(bcOptions([cat(1, { bcName: null })]), [{ bcId: '111', name: 'BC 111', count: 1 }], 'sem nome: "BC 111"');
    assert.deepEqual(bcOptions([cat(1, { bcName: null }), cat(2)]), [{ bcId: '111', name: 'Minha BC', count: 2 }], 'usa o nome assim que algum catálogo o informa');
  });

  it('pedido de ocultar: 1 a 100 catálogos com IDs numéricos, sem repetidos, e "hidden" verdadeiro/falso', () => {
    assert.deepEqual(normalizeHideInput({ hidden: true, items: [{ bcId: '111', catalogId: '5' }, { bcId: '111', catalogId: '5' }, { bcId: '111', catalogId: '6' }] }), { value: { hidden: true, items: [{ bcId: '111', catalogId: '5' }, { bcId: '111', catalogId: '6' }] }, errors: [] });
    const bad = (body) => normalizeHideInput(body).errors.length > 0;
    for (const body of [null, [], {}, { hidden: true }, { hidden: true, items: [] }, { hidden: 'true', items: [{ bcId: '1', catalogId: '2' }] }, { hidden: true, items: [{ bcId: '1' }] }, { hidden: true, items: [{ bcId: 'a', catalogId: '2' }] }, { hidden: true, items: [{ bcId: '1', catalogId: '2; x' }] }, { hidden: true, items: [{ bcId: '1', catalogId: 2 }] }, { hidden: true, items: [null] }, { hidden: true, items: Array.from({ length: MAX_HIDE_BATCH + 1 }, (_, i) => ({ bcId: '1', catalogId: String(i) })) }]) {
      assert.ok(bad(body), JSON.stringify(body)?.slice(0, 80));
    }
    assert.equal(bad({ hidden: false, items: Array.from({ length: MAX_HIDE_BATCH }, (_, i) => ({ bcId: '1', catalogId: String(i) })) }), false, '100 é o limite');
  });
});

describe('Catálogo: ocultar da lista e filtrar (API)', () => {
  let ctx;
  let fake;
  let mailer;
  before(async () => {
    fake = createFakeTiktok();
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer });
  });
  after(() => ctx.stop());

  const tkCatalog = (id, bc, name, extra = {}) => ({ catalog_id: String(id), catalog_name: name, catalog_type: 'ECOM', ad_creation_eligible: 'AVAILABLE', create_time: '2026-11-20 10:00:00', update_time: '2026-11-21 10:00:00', bc_info: { bc_id: bc, bc_name: `BC ${bc}` }, catalog_conf: { country: 'US', currency: 'USD' }, ...extra });

  async function setup() {
    fake.state.bcs = { 111: ['9001'], 222: ['9101'] };
    fake.state.validTokens.add(GOOD_TOKEN);
    fake.state.validTokens.add(OTHER_TOKEN);
    fake.state.catalogs = { 111: [tkCatalog(5001, '111', 'Moda'), tkCatalog(5002, '111', 'Casa')], 222: [tkCatalog(6001, '222', 'Tech')] };
    fake.state.failCatalogFor = new Set();
    const user = await createUser(ctx, { approve: true, email: emailOf() });
    for (const [bcId, token] of [['111', GOOD_TOKEN], ['222', OTHER_TOKEN]]) {
      const res = await user.client.post('/api/tiktok/business-centers', { name: `Conexão ${bcId}`, bcId, accessToken: token });
      assert.equal(res.status, 201, res.text);
    }
    return user;
  }
  const list = async (user, query = '') => (await user.client.get(`/api/tiktok/catalogs${query}`)).json;
  const hide = (user, items, hidden = true) => user.client.put('/api/tiktok/catalogs/hidden', { items, hidden });
  const item = (catalogId, bcId = '111') => ({ bcId, catalogId });
  const collaborator = async (owner, areas = ['campaigns']) => {
    const email = emailOf();
    assert.equal((await owner.client.post('/api/team/invites', { email, name: 'Maria Colab', areas })).status, 201);
    const client = ctx.client();
    const accepted = await client.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
    assert.ok(accepted.status < 300, accepted.text);
    client.csrf = accepted.json.csrfToken;
    return client;
  };

  it('a lista vem com "hidden" em cada catálogo e a contagem de ocultos (zero no começo)', async () => {
    const user = await setup();
    const data = await list(user);
    assert.equal(data.catalogs.length, 3);
    assert.ok(data.catalogs.every((c) => c.hidden === false));
    assert.equal(data.hiddenCount, 0);
  });

  it('ocultar tira da lista dessa pessoa (marca "hidden"), é idempotente e mostrar de volta desfaz', async () => {
    const user = await setup();
    const res = await hide(user, [item('5001'), item('6001', '222')]);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, { changed: 2, hidden: true });
    const data = await list(user);
    assert.deepEqual(data.catalogs.filter((c) => c.hidden).map((c) => c.id).sort(), ['5001', '6001']);
    assert.equal(data.hiddenCount, 2);
    assert.equal(data.catalogs.length, 3, 'o servidor devolve todos; a tela decide o que mostrar');
    assert.equal((await hide(user, [item('5001')])).json.changed, 0, 'ocultar de novo não muda nada');
    assert.deepEqual((await hide(user, [item('5001')], false)).json, { changed: 1, hidden: false });
    assert.deepEqual((await list(user)).catalogs.filter((c) => c.hidden).map((c) => c.id), ['6001']);
    assert.equal((await hide(user, [item('5001')], false)).json.changed, 0, 'mostrar quem já aparece não muda nada');
  });

  it('é só visual: o TikTok não é chamado para apagar nada e o catálogo continua existindo', async () => {
    const user = await setup();
    fake.state.calls.length = 0;
    await hide(user, [item('5001')]);
    assert.equal(fake.state.calls.filter((c) => /delete|remove/i.test(c.path)).length, 0);
    assert.equal(fake.state.catalogs['111'].length, 2);
    assert.equal((await list(user, '?refresh=1')).catalogs.find((c) => c.id === '5001').hidden, true, 'continua marcado como oculto depois de atualizar do TikTok');
  });

  it('é por PESSOA: o colaborador oculta só para ele e o dono continua vendo (e vice-versa)', async () => {
    const owner = await setup();
    const colab = await collaborator(owner);
    assert.equal((await colab.get('/api/tiktok/catalogs')).json.catalogs.length, 3, 'o colaborador vê os catálogos do espaço do dono');
    assert.equal((await colab.put('/api/tiktok/catalogs/hidden', { items: [item('5002')], hidden: true })).status, 200);
    assert.equal((await colab.get('/api/tiktok/catalogs')).json.hiddenCount, 1);
    assert.equal((await list(owner)).hiddenCount, 0, 'para o dono nada mudou');
    await hide(owner, [item('6001', '222')]);
    assert.deepEqual((await colab.get('/api/tiktok/catalogs')).json.catalogs.filter((c) => c.hidden).map((c) => c.id), ['5002'], 'o do dono não aparece oculto para o colaborador');
  });

  it('só oculta catálogo de Business Center que a pessoa enxerga (BC alheia = 404) e nada fica gravado', async () => {
    const user = await setup();
    assert.equal((await hide(user, [item('7001', '999')])).status, 404);
    assert.equal((await hide(user, [item('5001'), item('7001', '999')])).status, 404, 'um inválido derruba o pedido todo');
    assert.equal((await list(user)).hiddenCount, 0, 'nada foi ocultado');
    assert.equal((await all(ctx.db, 'SELECT 1 FROM catalog_hidden WHERE user_id = $1', [user.id])).length, 0, 'nenhuma linha gravada');
  });

  it('valida o corpo (400) e exige login, CSRF e a área "Campanhas"', async () => {
    const user = await setup();
    for (const body of [{}, { hidden: true }, { hidden: true, items: [] }, { hidden: 'sim', items: [item('1')] }, { hidden: true, items: [{ bcId: '111', catalogId: '../x' }] }, { hidden: true, items: 'x' }, []]) {
      assert.equal((await user.client.put('/api/tiktok/catalogs/hidden', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await ctx.client().put('/api/tiktok/catalogs/hidden', { items: [item('5001')], hidden: true })).status, 401);
    const noCsrf = await user.client.request('PUT', '/api/tiktok/catalogs/hidden', { json: { items: [item('5001')], hidden: true }, withCsrf: false });
    assert.equal(noCsrf.status, 403);
    const reports = await collaborator(user, ['reports']);
    assert.equal((await reports.put('/api/tiktok/catalogs/hidden', { items: [item('5001')], hidden: true })).status, 403, 'sem a área Campanhas');
    assert.equal((await list(user)).hiddenCount, 0);
  });

  it('limite de ocultos por pessoa: passando disso recusa tudo (409) e não grava nada', async () => {
    const user = await setup();
    await run(ctx.db, "INSERT INTO catalog_hidden (user_id, bc_id, catalog_id) SELECT $1, '111', g::text FROM generate_series(100000, $2) g", [user.id, 100000 + MAX_HIDDEN_PER_USER - 3]);
    assert.equal((await hide(user, [item('5001')])).status, 200, 'cabe mais 1 (total = limite - 1)');
    assert.equal((await hide(user, [item('5002'), item('5002')])).status, 200, 'cabe o último: o limite exato é permitido (repetido conta uma vez)');
    const over = await hide(user, [item('6001', '222')]);
    assert.equal(over.status, 409);
    assert.equal(over.json.error.code, 'too_many_hidden');
    assert.equal((await list(user)).catalogs.find((c) => c.id === '6001').hidden, false, 'nada foi gravado');
    assert.equal((await hide(user, [item('5001')], false)).status, 200, 'mostrar de volta sempre funciona, mesmo no limite');
    assert.equal((await hide(user, [item('6001', '222')])).status, 200, 'e libera espaço para ocultar outro');
  });

  it('apagar a conta da pessoa apaga os catálogos ocultos dela (cascata) e o banco recusa IDs fora do formato', async () => {
    const user = await setup();
    await hide(user, [item('5001')]);
    assert.equal((await all(ctx.db, 'SELECT 1 FROM catalog_hidden WHERE user_id = $1', [user.id])).length, 1);
    await assert.rejects(run(ctx.db, "INSERT INTO catalog_hidden (user_id, bc_id, catalog_id) VALUES ($1, '111', 'abc')", [user.id]), (e) => e.code === '23514');
    await assert.rejects(run(ctx.db, "INSERT INTO catalog_hidden (user_id, bc_id, catalog_id) VALUES ($1, 'x', '1')", [user.id]), (e) => e.code === '23514');
    await run(ctx.db, 'DELETE FROM users WHERE id = $1', [user.id]);
    assert.equal((await all(ctx.db, 'SELECT 1 FROM catalog_hidden WHERE user_id = $1', [user.id])).length, 0);
  });
});
