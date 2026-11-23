import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { balanceLabel, hasBalance, isBalanceKey, mainAmount, sortAmounts } from '../shared/balance-fields.js';
import { numericFields } from '../src/modules/tiktok/tiktok.client.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, balanceRefresh: 1000, tiktokCallback: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `bal${++counter}@example.com`;

describe('Saldo: regras e leitura tolerante dos campos', () => {
  it('lê todos os campos numéricos (número ou texto), um nível de objetos aninhados, e ignora id/data/situação/paginação/lixo', () => {
    const fields = numericFields({
      advertiser_id: '7710676164989337601', advertiser_name: 'Loja', advertiser_status: 'STATUS_ENABLE', currency: 'USD', create_time: 1700000000, budget_mode: 'BUDGET_MODE_DAY',
      valid_account_balance: '120.50', account_balance: 150.5, tax: '0', frozen_balance: '30', empty: '', text: 'abc', big: '1e9', nan: 'NaN', neg: '-4.25', nested_list: [1, 2],
      info: { cash_balance: '100', page: 1, total_number: 4, grant_balance: '50.5' }, nulo: null, 'chave inválida': 5, UPPER_KEY: '7',
    });
    assert.deepEqual(Object.fromEntries(fields.map((f) => [f.key, f.value])), { valid_account_balance: 120.5, account_balance: 150.5, tax: 0, frozen_balance: 30, neg: -4.25, cash_balance: 100, grant_balance: 50.5, upper_key: 7 });
    assert.deepEqual(numericFields(null), []);
    assert.equal(numericFields(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`campo_${i}`, i]))).length, 40, 'no máximo 40 campos');
  });

  it('nomes em português, saldo principal, "tem saldo" e ordem de exibição', () => {
    assert.equal(balanceLabel('valid_account_balance'), 'Saldo disponível');
    assert.equal(balanceLabel('credit_line_amount'), 'Credit line amount', 'campo desconhecido: nome humanizado');
    assert.equal(balanceLabel(''), 'Valor');
    const amounts = [{ key: 'tax', value: 5 }, { key: 'cash_balance', value: 10 }, { key: 'valid_account_balance', value: 7 }, { key: 'zeta', value: 1 }, { key: 'alfa', value: 1 }];
    assert.deepEqual(sortAmounts(amounts).map((a) => a.key), ['valid_account_balance', 'cash_balance', 'tax', 'alfa', 'zeta']);
    assert.equal(mainAmount(amounts), 7, 'o saldo disponível tem prioridade');
    assert.equal(mainAmount([{ key: 'cash_balance', value: 3 }]), 3);
    assert.equal(mainAmount([{ key: 'tax', value: 3 }]), null, 'só imposto: sem saldo principal');
    assert.equal(mainAmount([]), null);
    assert.equal(hasBalance([{ key: 'tax', value: 9 }, { key: 'frozen_balance', value: 9 }, { key: 'budget', value: 9 }]), false, 'imposto, bloqueio e orçamento não são saldo');
    assert.equal(hasBalance([{ key: 'grant_balance', value: 0.01 }]), true);
    assert.equal(hasBalance([{ key: 'valid_account_balance', value: 0 }]), false);
    for (const key of ['valid_cash_balance', 'coupon_balance', 'credit_balance']) assert.equal(isBalanceKey(key), true, key);
    for (const key of ['frozen_balance', 'tax', 'budget', 'budget_cost', 'credit_limit']) assert.equal(isBalanceKey(key), false, key);
  });
});

describe('Saldo das Business Centers e das contas de anúncio', () => {
  let ctx;
  let fake;
  let mailer;
  before(async () => {
    fake = createFakeTiktok();
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer });
  });
  after(() => ctx.stop());

  const bcBalance = (extra = {}) => ({ currency: 'USD', account_balance: '150.50', valid_account_balance: '120.50', frozen_balance: '30', tax: '0', cash_balance: '100', valid_cash_balance: '90', grant_balance: '50.5', valid_grant_balance: '30.5', ...extra });
  const account = (id, extra = {}) => ({ advertiser_id: id, advertiser_name: `Conta ${id}`, advertiser_status: 'STATUS_ENABLE', currency: 'USD', account_balance: '0', valid_account_balance: '0', budget: '100', budget_mode: 'BUDGET_MODE_DAY', ...extra });

  async function setup() {
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9101'] };
    fake.state.currencies = { 9001: 'USD', 9002: 'USD', 9101: 'BRL' };
    fake.state.validTokens.add(GOOD_TOKEN);
    fake.state.validTokens.add(OTHER_TOKEN);
    fake.state.failBalanceBc = new Set();
    fake.state.failBalanceAdvertisers = new Set();
    fake.state.balanceListKey = 'advertiser_account_list';
    fake.state.balances = {
      // BC 111 COM saldo; sua conta 9001 SEM saldo (só orçamento) e 9002 com saldo.
      // BC 222 SEM saldo; mas a conta 9101 dela COM saldo.
      bc: { 111: bcBalance(), 222: { currency: 'BRL', account_balance: '0', valid_account_balance: '0', frozen_balance: '0', tax: '0' } },
      advertisers: { 111: [account('9001'), account('9002', { valid_account_balance: '25', account_balance: '25' })], 222: [account('9101', { currency: 'BRL', valid_account_balance: '10', account_balance: '10' })] },
    };
    fake.state.calls.length = 0;
    return createUser(ctx, { approve: true, email: emailOf() });
  }
  const connect = (user, bcId, token = GOOD_TOKEN) => user.client.post('/api/tiktok/business-centers', { name: `BC ${bcId}`, bcId, accessToken: token });
  const balanceCalls = () => fake.state.calls.filter((c) => c.path === '/bc/balance/get/' || c.path === '/advertiser/balance/get/');
  const overview = async (user, query = '') => (await user.client.get(`/api/tiktok/balance${query}`)).json;

  it('mostra BCs e contas SEPARADAS; BC sem saldo com conta com saldo (e o contrário) aparecem, cada uma com a sua situação', async () => {
    const user = await setup();
    await connect(user, '111');
    await connect(user, '222');
    const res = await user.client.get('/api/tiktok/balance');
    assert.equal(res.status, 200, res.text);
    const { bcs, accounts, summary } = res.json;

    assert.deepEqual(bcs.map((b) => [b.bcId, b.status, b.hasBalance, b.main, b.currency]), [['111', 'ok', true, 120.5, 'USD'], ['222', 'ok', false, 0, 'BRL']]);
    assert.deepEqual(bcs[0].amounts.map((a) => [a.key, a.label, a.value]).slice(0, 3), [['valid_account_balance', 'Saldo disponível', 120.5], ['account_balance', 'Saldo total', 150.5], ['valid_cash_balance', 'Dinheiro disponível', 90]]);
    assert.ok(bcs[0].amounts.some((a) => a.key === 'frozen_balance' && a.label === 'Saldo bloqueado' && a.value === 30), 'mostra TUDO, com nomes em português');
    assert.deepEqual([bcs[0].accountsTotal, bcs[0].accountsWithBalance, bcs[1].accountsTotal, bcs[1].accountsWithBalance], [2, 1, 1, 1]);

    const byId = Object.fromEntries(accounts.map((a) => [a.advertiserId, a]));
    assert.equal(byId['9101'].hasBalance, true, 'conta COM saldo numa BC SEM saldo aparece');
    assert.equal(byId['9101'].bcHasBalance, false, 'e diz que a BC dela está sem saldo');
    assert.equal(byId['9001'].hasBalance, false, 'conta SEM saldo numa BC COM saldo aparece');
    assert.equal(byId['9001'].bcHasBalance, true);
    assert.equal(byId['9002'].hasBalance, true);
    assert.deepEqual(accounts.map((a) => a.advertiserId), ['9002', '9101', '9001'], 'com saldo primeiro (maior primeiro)');
    assert.equal(byId['9001'].amounts.find((a) => a.key === 'budget').label, 'Orçamento', 'o orçamento também é mostrado, sem contar como saldo');
    assert.equal(byId['9002'].name, 'Conta 9002');
    assert.equal(byId['9101'].currency, 'BRL');
    assert.deepEqual(summary, { bcs: 2, bcsWithBalance: 1, bcsWithoutBalance: 1, bcsWithError: 0, accounts: 3, accountsWithBalance: 2, accountsWithoutBalance: 1, accountsUnknown: 0 });
    assert.deepEqual(res.json.totals, [{ currency: 'USD', bc: 120.5, accounts: 25 }, { currency: 'BRL', bc: 0, accounts: 10 }], 'moedas nunca se somam');
    assert.ok(!res.text.includes(GOOD_TOKEN) && !res.text.includes('access_token'), 'o token nunca volta');
    assert.ok(res.json.fetchedAt);
  });

  it('cada BC é consultada com o token da conexão e o ID da BC; só leituras (GET)', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.calls.length = 0;
    await overview(user);
    const calls = balanceCalls();
    assert.deepEqual(calls.map((c) => [c.method, c.path, c.query.bc_id]).sort(), [['GET', '/advertiser/balance/get/', '111'], ['GET', '/bc/balance/get/', '111']]);
    assert.ok(calls.every((c) => c.token === GOOD_TOKEN));
    assert.equal(calls.find((c) => c.path === '/advertiser/balance/get/').query.page_size, '50', 'respeita o limite de página do TikTok');
  });

  it('se a BC não deixa ver o saldo dela (sem permissão), as contas dela continuam aparecendo (e o contrário)', async () => {
    const user = await setup();
    await connect(user, '111');
    await connect(user, '222');
    fake.state.failBalanceBc = new Set(['111']); // sem permissão financeira na BC 111
    fake.state.failBalanceAdvertisers = new Set(['222']); // sem permissão para as contas da BC 222
    const { bcs, accounts, summary } = await overview(user);
    const bc111 = bcs.find((b) => b.bcId === '111');
    assert.equal(bc111.status, 'error');
    assert.match(bc111.error, /TikTok: No permission/);
    assert.equal(bc111.accountsError, null);
    assert.deepEqual(accounts.filter((a) => a.bcId === '111').map((a) => [a.advertiserId, a.status, a.bcHasBalance]).sort(), [['9001', 'ok', null], ['9002', 'ok', null]], 'contas da BC 111 aparecem; "a BC tem saldo?" fica desconhecido');
    const bc222 = bcs.find((b) => b.bcId === '222');
    assert.equal(bc222.status, 'ok');
    assert.match(bc222.accountsError, /TikTok: No permission/);
    const lost = accounts.find((a) => a.advertiserId === '9101');
    assert.deepEqual([lost.status, lost.hasBalance, lost.main], ['unknown', false, null], 'conta sem dado: aparece como "não informado", nunca como "sem saldo"');
    assert.match(lost.error, /No permission/);
    assert.deepEqual([summary.bcsWithError, summary.accountsUnknown], [1, 1]);
  });

  it('conta conhecida que o TikTok não devolve aparece como "não informado"', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.balances.advertisers[111] = [account('9001', { valid_account_balance: '5' })]; // sem a 9002
    const { accounts } = await overview(user);
    const missing = accounts.find((a) => a.advertiserId === '9002');
    assert.deepEqual([missing.status, missing.error], ['unknown', 'O TikTok não informou o saldo desta conta.']);
  });

  it('token revogado: avisa para renovar o acesso e, depois, a conexão aparece com erro (sem chamar o TikTok)', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.validTokens.delete(GOOD_TOKEN);
    const first = await overview(user);
    assert.equal(first.bcs[0].status, 'error');
    assert.match(first.bcs[0].error, /expirou|revogado/);
    assert.match(first.bcs[0].error, /Renove o acesso/);
    assert.ok(first.accounts.every((a) => a.status === 'unknown'));
    fake.state.calls.length = 0;
    const second = await overview(user, '?refresh=1');
    assert.match(second.bcs[0].error, /conexão está com erro de acesso/);
    assert.equal(balanceCalls().length, 0, 'conexão com erro nem é consultada');
  });

  it('usa cache de 60 s; "atualizar" (?refresh=1) vai ao TikTok de novo; consultas simultâneas compartilham o resultado', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.calls.length = 0;
    await Promise.all([overview(user), overview(user), overview(user)]);
    assert.equal(balanceCalls().length, 2, 'três pedidos ao mesmo tempo = uma rodada (BC + contas)');
    await overview(user);
    assert.equal(balanceCalls().length, 2, 'dentro de 60 s não consulta de novo');
    fake.state.balances.bc[111] = bcBalance({ valid_account_balance: '999' });
    assert.equal((await overview(user)).bcs[0].main, 120.5, 'ainda o valor em cache');
    assert.equal((await overview(user, '?refresh=1')).bcs[0].main, 999, 'atualizar mostra o novo valor');
    assert.equal(balanceCalls().length, 4);
  });

  it('conectar uma BC logo depois de ver a tela vazia mostra a BC na hora (o cache não esconde conexões novas)', async () => {
    const user = await setup();
    assert.deepEqual((await overview(user)).bcs, []);
    await connect(user, '111');
    assert.deepEqual((await overview(user)).bcs.map((b) => b.bcId), ['111']);
    const bc = (await user.client.get('/api/tiktok/business-centers')).json.businessCenters[0];
    assert.equal((await user.client.delete(`/api/tiktok/business-centers/${bc.id}`)).status, 204);
    assert.deepEqual((await overview(user)).bcs, [], 'removida: some na hora');
  });

  it('o botão "Atualizar" tem limite próprio (429), sem impedir a consulta normal', async () => {
    const lim = await startTestServer({ limits: { ...LIMITS, balanceRefresh: 2 }, config: tiktokTestConfig(), fetchFn: fake.fetchFn, isolated: true });
    try {
      const user = await createUser(lim, { approve: true, email: emailOf() });
      await setup();
      await user.client.post('/api/tiktok/business-centers', { name: 'BC', bcId: '111', accessToken: GOOD_TOKEN });
      const statuses = [];
      for (let i = 0; i < 3; i += 1) statuses.push((await user.client.get('/api/tiktok/balance?refresh=1')).status);
      assert.deepEqual(statuses, [200, 200, 429]);
      assert.equal((await user.client.get('/api/tiktok/balance')).status, 200);
    } finally {
      await lim.stop();
    }
  });

  it('pagina as contas (mais de 50 por BC) e devolve todas', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.balances.advertisers[111] = Array.from({ length: 120 }, (_, i) => account(String(8000 + i), { valid_account_balance: String(i) }));
    fake.state.calls.length = 0;
    const { accounts } = await overview(user);
    assert.equal(accounts.length >= 120, true);
    assert.equal(fake.state.calls.filter((c) => c.path === '/advertiser/balance/get/').length, 3, 'três páginas de 50');
    assert.equal(accounts[0].advertiserId, '8119', 'a de maior saldo vem primeiro');
  });

  it('tolera outro formato de resposta: lista em "list", campos aninhados e campo desconhecido', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.balances.bc[111] = { currency: 'USD', balance_info: { account_balance: '40', credit_line_amount: '500' } };
    fake.state.balances.advertisers[111] = [account('9001', { valid_account_balance: '7', pending_amount: '3.5' })];
    fake.state.balanceListKey = 'list'; // o TikTok pode chamar a lista de outro jeito: o sistema a acha mesmo assim
    const { bcs, accounts } = await overview(user);
    fake.state.balanceListKey = 'advertiser_account_list';
    assert.deepEqual(bcs[0].amounts.map((a) => [a.key, a.label, a.value]), [['account_balance', 'Saldo total', 40], ['credit_line_amount', 'Credit line amount', 500]]);
    assert.equal(bcs[0].main, 40);
    assert.equal(accounts.find((a) => a.advertiserId === '9001').amounts.some((a) => a.key === 'pending_amount' && a.label === 'Pending amount'), true, 'campo novo do TikTok aparece com nome humanizado');
  });

  it('conexão por link com várias BCs: uma linha por BC; conta sem BC informada aparece "não informado"', async () => {
    const user = await setup();
    const start = await user.client.post('/api/tiktok/connect', { name: 'Conta global' });
    fake.grantAuthCode(`code-bal-${++counter}-xxxxxxxx`, { advertisers: ['9001', '9002'], bcId: '111' });
    const code = [...fake.state.authCodes.keys()].at(-1);
    const back = await ctx.client().get(`/api/tiktok/callback?auth_code=${code}&state=${encodeURIComponent(new URL(start.json.url).searchParams.get('state'))}`);
    assert.equal(back.status, 302);
    fake.state.bcs[333] = ['9002'];
    fake.state.balances.bc[333] = bcBalance({ valid_account_balance: '8' });
    fake.state.balances.advertisers[333] = [account('9002', { valid_account_balance: '8' })];
    await run(ctx.db, "UPDATE tiktok_advertisers SET owner_bc_id = '333' WHERE advertiser_id = '9002'");
    const { bcs, accounts } = await overview(user);
    assert.deepEqual(bcs.map((b) => b.bcId).sort(), ['111', '333']);
    assert.ok(bcs.every((b) => b.connectionName === 'Conta global'));
    await run(ctx.db, "UPDATE tiktok_advertisers SET owner_bc_id = NULL WHERE advertiser_id = '9001'");
    const second = await overview(user, '?refresh=1');
    const orphan = second.accounts.find((a) => a.advertiserId === '9001');
    assert.deepEqual([orphan.status, orphan.bcId], ['unknown', null]);
    assert.match(orphan.error, /Sem Business Center informada/);
    assert.ok(accounts.length >= 2);
  });

  it('isolamento: só as conexões do próprio usuário (mesmo as compartilhadas pela equipe de outra pessoa não entram)', async () => {
    const a = await setup();
    await connect(a, '111');
    const b = await createUser(ctx, { approve: true, email: emailOf() });
    const theirs = (await connect(b, '222', OTHER_TOKEN)).json.businessCenter;
    await run(ctx.db, 'UPDATE tiktok_business_centers SET shared = true WHERE id = $1', [theirs.id]);
    const seenByA = await overview(a);
    assert.deepEqual(seenByA.bcs.map((x) => x.bcId), ['111'], 'a BC compartilhada pelo outro não aparece');
    assert.ok(!seenByA.accounts.some((x) => x.advertiserId === '9101'));
    assert.deepEqual((await overview(b)).bcs.map((x) => x.bcId), ['222']);
    const nobody = await createUser(ctx, { approve: true, email: emailOf() });
    const empty = await overview(nobody);
    assert.deepEqual([empty.bcs, empty.accounts, empty.totals], [[], [], []]);
  });

  it('exige login e a área "Contas TikTok" (colaborador de Relatórios não vê o dinheiro; o de Contas vê o do dono)', async () => {
    const owner = await setup();
    await connect(owner, '111');
    assert.equal((await ctx.client().get('/api/tiktok/balance')).status, 401);
    async function collaborator(areas) {
      const email = emailOf();
      assert.equal((await owner.client.post('/api/team/invites', { email, name: 'Maria Colab', areas })).status, 201);
      const client = ctx.client();
      const accepted = await client.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
      client.csrf = accepted.json.csrfToken;
      return client;
    }
    assert.equal((await (await collaborator(['reports'])).get('/api/tiktok/balance')).status, 403);
    assert.equal((await (await collaborator(['campaigns'])).get('/api/tiktok/balance')).status, 403);
    const accounts = await (await collaborator(['accounts'])).get('/api/tiktok/balance');
    assert.equal(accounts.status, 200);
    assert.equal(accounts.json.bcs[0].bcId, '111', 'vê os dados do dono do espaço');
  });
});
