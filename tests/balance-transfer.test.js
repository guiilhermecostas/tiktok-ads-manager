import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MAX_TRANSFER_AMOUNT, OPERATION_ID_RE, TRANSFER_TYPE_IDS, describeTransfer, parseTransferAmount, transferEligibility, validateTransferInput } from '../shared/balance-transfer.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { USER_PASSWORD, all, createUser, one, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, balanceRefresh: 1000, balanceTransfer: 1000, balanceTransferPassword: 5, tiktokCallback: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `trf${++counter}@example.com`;
let opCounter = 0;
const opId = () => (++opCounter).toString(16).padStart(32, '0');

describe('Transferência de saldo: regras compartilhadas', () => {
  it('valor: positivo, até 2 casas, até o teto; nunca arredonda dinheiro em silêncio', () => {
    for (const [raw, expected] of [['25', 25], ['25,5', 25.5], ['25.50', 25.5], [25, 25], [0.01, 0.01], [' 7 ', 7], [MAX_TRANSFER_AMOUNT, MAX_TRANSFER_AMOUNT], ['0,10', 0.1]]) assert.equal(parseTransferAmount(raw), expected, String(raw));
    for (const bad of [0, '0', '0,00', -1, '-1', '1.234', '10.999', '1e3', '1.234,56', '1,234.56', MAX_TRANSFER_AMOUNT + 0.01, '', ' ', 'abc', null, undefined, NaN, Infinity, {}, [], true, '12abc', '١٢', 1.005]) assert.equal(parseTransferAmount(bad), null, String(bad));
  });

  it('o pedido é validado campo a campo e só os campos conhecidos passam', () => {
    const ok = { connectionId: 3, bcId: '111', advertiserId: '9001', type: 'RECHARGE', amount: '10,50', operationId: 'a'.repeat(32), password: 'x', hack: 'y' };
    const { value, errors } = validateTransferInput(ok);
    assert.deepEqual(errors, []);
    assert.deepEqual(value, { connectionId: 3, bcId: '111', advertiserId: '9001', type: 'RECHARGE', amount: 10.5, operationId: 'a'.repeat(32), password: 'x' });
    const bad = [
      [{ connectionId: '3' }, 'connectionId'], [{ connectionId: 0 }, 'connectionId'], [{ connectionId: 1.5 }, 'connectionId'], [{ bcId: '11a' }, 'bcId'], [{ bcId: 111 }, 'bcId'], [{ bcId: '1'.repeat(25) }, 'bcId'],
      [{ advertiserId: '9001; DROP' }, 'advertiserId'], [{ type: 'DELETE' }, 'type'], [{ type: 'recharge' }, 'type'], [{ amount: 0 }, 'amount'], [{ amount: '1.001' }, 'amount'],
      [{ operationId: 'A'.repeat(32) }, 'operationId'], [{ operationId: 'a'.repeat(31) }, 'operationId'], [{ operationId: undefined }, 'operationId'], [{ password: '' }, 'password'], [{ password: 'x'.repeat(201) }, 'password'], [{ password: 5 }, 'password'],
    ];
    for (const [patch, path] of bad) {
      const result = validateTransferInput({ ...ok, ...patch });
      assert.equal(result.value, null, JSON.stringify(patch));
      assert.equal(result.errors[0].path, path, JSON.stringify(patch));
    }
    for (const nothing of [null, undefined, [], 'x', 5]) assert.equal(validateTransferInput(nothing).value, null);
    assert.deepEqual(TRANSFER_TYPE_IDS, ['RECHARGE', 'REFUND']);
    assert.equal(OPERATION_ID_RE.test('0123456789abcdef0123456789abcdef'), true);
  });

  it('elegibilidade: só conta com saldo próprio, mesma moeda e BC lida; devolve os limites (BC / transferível)', () => {
    const account = (extra = {}) => ({ status: 'ok', currency: 'USD', main: 25, mainSource: 'account', amounts: [], ...extra });
    const bc = (extra = {}) => ({ status: 'ok', currency: 'USD', main: 100, portfolioType: null, ...extra });
    assert.deepEqual(transferEligibility(account(), bc()), { ok: true, reason: null, maxRecharge: 100, maxRefund: 25 });
    assert.equal(transferEligibility(account({ amounts: [{ key: 'transferable_amount', value: 20 }] }), bc()).maxRefund, 20, 'o "valor transferível" do TikTok exclui o bloqueado');
    assert.equal(transferEligibility(account({ main: -5 }), bc({ main: -1 })).maxRefund, 0);
    for (const [a, b, pattern] of [
      [null, bc(), /não informou/], [account({ status: 'unknown' }), bc(), /não informou/], [account(), null, /Business Center/], [account(), bc({ status: 'error' }), /Business Center/],
      [account({ mainSource: 'portfolio' }), bc(), /compartilhado/], [account(), bc({ portfolioType: 'SHARED' }), /compartilhado/], [account({ mainSource: 'budget' }), bc(), /orçamento/],
      [account({ currency: null }), bc(), /Moeda desconhecida/], [account({ currency: 'BRL' }), bc(), /moedas diferentes/], [account({ main: null }), bc(), /Saldo desconhecido/], [account(), bc({ main: null }), /Saldo desconhecido/],
    ]) {
      const result = transferEligibility(a, b);
      assert.equal(result.ok, false, String(pattern));
      assert.match(result.reason, pattern);
      assert.deepEqual([result.maxRecharge, result.maxRefund], [0, 0]);
    }
  });

  it('a frase de resumo diz de onde sai e para onde vai', () => {
    const money = (v, c) => `${c} ${v}`;
    assert.equal(describeTransfer({ type: 'RECHARGE', amount: 50, currency: 'USD', bcId: '111', advertiserName: 'Loja', advertiserId: '9001' }, money), 'USD 50 da BC 111 para a conta Loja (9001)');
    assert.equal(describeTransfer({ type: 'REFUND', amount: 5, currency: 'USD', bcId: '111', advertiserName: null, advertiserId: '9001' }, money), 'USD 5 da conta 9001 para a BC 111');
  });
});

describe('Transferência de saldo: API (TikTok simulado)', () => {
  let ctx;
  let fake;
  let mailer;
  before(async () => {
    fake = createFakeTiktok();
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer });
  });
  after(() => ctx.stop());

  const account = (id, extra = {}) => ({ advertiser_id: id, advertiser_name: `Conta ${id}`, advertiser_status: 'SHOW_ACCOUNT_STATUS_APPROVED', currency: 'USD', account_balance: '40', valid_account_balance: '40', frozen_balance: '0', tax: '0', budget_mode: 'UNLIMITED', ...extra });
  const bcBalance = () => ({ currency: 'USD', account_balance: '200', valid_account_balance: '200', frozen_balance: '0', tax: '0' });

  async function setup() {
    await run(ctx.db, 'DELETE FROM balance_transfers');
    fake.state.bcs = { 111: ['9001', '9002'] };
    fake.state.currencies = { 9001: 'USD', 9002: 'USD' };
    fake.state.validTokens.add(GOOD_TOKEN);
    fake.state.validTokens.add(OTHER_TOKEN);
    fake.state.failBalanceBc = new Set();
    fake.state.failBalanceAdvertisers = new Set();
    fake.state.balanceListKey = 'advertiser_account_list';
    fake.state.transferFinanceRole = true;
    fake.state.transferNetworkError = false;
    fake.state.transferDelayMs = 0;
    fake.state.minRecharge = 0;
    fake.state.transfers = [];
    fake.state.balances = { bc: { 111: bcBalance() }, advertisers: { 111: [account('9001'), account('9002', { valid_account_balance: '5', account_balance: '5' })] } };
    fake.state.calls.length = 0;
    const user = await createUser(ctx, { approve: true, email: emailOf() });
    const res = await user.client.post('/api/tiktok/business-centers', { name: 'BC 111', bcId: '111', accessToken: GOOD_TOKEN });
    assert.equal(res.status, 201, res.text);
    user.connectionId = res.json.businessCenter?.id ?? res.json.id;
    return user;
  }
  const body = (user, extra = {}) => ({ connectionId: user.connectionId, bcId: '111', advertiserId: '9001', type: 'RECHARGE', amount: 50, operationId: opId(), password: USER_PASSWORD, ...extra });
  const send = (user, extra) => user.client.post('/api/tiktok/balance/transfer', body(user, extra));
  const transferCalls = () => fake.state.calls.filter((c) => c.path === '/bc/transfer/');
  const rows = () => all(ctx.db, 'SELECT * FROM balance_transfers ORDER BY id');
  const overview = async (user) => (await user.client.get('/api/tiktok/balance?refresh=1')).json;
  const message = (res) => res.json?.error?.message ?? res.text;

  it('adicionar saldo (BC → conta): pelo contrato oficial, o saldo muda dos dois lados e fica registrado', async () => {
    const user = await setup();
    const res = await send(user, { amount: '50,25' });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.duplicate, false);
    assert.deepEqual([res.json.transfer.status, res.json.transfer.direction, res.json.transfer.amount, res.json.transfer.currency, res.json.transfer.advertiserId], ['success', 'RECHARGE', 50.25, 'USD', '9001']);
    assert.equal(res.json.transfer.transactionIds.length, 2, 'os dois lados da transferência (conta e BC)');
    const call = transferCalls()[0];
    assert.deepEqual([call.method, call.token, call.body], ['POST', GOOD_TOKEN, { bc_id: '111', transfer_level: 'ADVERTISER', advertiser_id: '9001', transfer_type: 'RECHARGE', cash_amount: 50.25 }]);
    assert.equal(transferCalls().length, 1, 'uma única chamada (sem repetir sozinha)');
    const after1 = await overview(user);
    assert.deepEqual([after1.bcs[0].main, after1.accounts.find((a) => a.advertiserId === '9001').main], [149.75, 90.25]);
    const db = await rows();
    assert.deepEqual([db.length, db[0].status, db[0].direction, Number(db[0].amount), db[0].bc_id, db[0].advertiser_id, db[0].advertiser_name], [1, 'success', 'RECHARGE', 50.25, '111', '9001', 'Conta 9001']);
    assert.ok(db[0].finished_at && db[0].transaction_ids.includes(','));
    assert.ok(!res.text.includes(GOOD_TOKEN) && !res.text.includes(USER_PASSWORD) && !res.text.includes('password_hash'), 'nem token nem senha voltam');
  });

  it('retirar saldo (conta → BC)', async () => {
    const user = await setup();
    const res = await send(user, { type: 'REFUND', amount: 15 });
    assert.equal(res.status, 201, res.text);
    assert.equal(transferCalls()[0].body.transfer_type, 'REFUND');
    const after1 = await overview(user);
    assert.deepEqual([after1.bcs[0].main, after1.accounts.find((a) => a.advertiserId === '9001').main], [215, 25]);
  });

  it('o histórico lista as últimas transferências, só da própria pessoa', async () => {
    const user = await setup();
    await send(user, { amount: 10 });
    await send(user, { type: 'REFUND', amount: 5 });
    const mine = (await user.client.get('/api/tiktok/balance/transfers')).json.transfers;
    assert.deepEqual(mine.map((t) => [t.direction, t.amount, t.status]), [['REFUND', 5, 'success'], ['RECHARGE', 10, 'success']], 'a mais recente primeiro');
    const other = await createUser(ctx, { approve: true, email: emailOf() });
    assert.deepEqual((await other.client.get('/api/tiktok/balance/transfers')).json.transfers, []);
    assert.equal((await ctx.client().get('/api/tiktok/balance/transfers')).status, 401);
  });

  it('senha errada: nada é enviado ao TikTok e nada é registrado; depois de 5 erros a pessoa é bloqueada (mesmo com a senha certa)', async () => {
    const user = await setup();
    for (let i = 0; i < 5; i += 1) {
      const res = await send(user, { password: 'senha-errada' });
      assert.equal(res.status, 403, res.text);
      assert.equal(res.json.error.code, 'invalid_password');
    }
    const blocked = await send(user);
    assert.equal(blocked.status, 429, 'bloqueada por 15 minutos');
    assert.equal(transferCalls().length, 0);
    assert.equal((await rows()).length, 0);
  });

  it('só o DONO move dinheiro: colaborador (mesmo com a área "Contas TikTok") vê o saldo, mas recebe 403 ao transferir', async () => {
    const owner = await setup();
    const email = emailOf();
    assert.equal((await owner.client.post('/api/team/invites', { email, name: 'Maria Colab', areas: ['accounts'] })).status, 201);
    const collab = ctx.client();
    const accepted = await collab.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
    collab.csrf = accepted.json.csrfToken;
    const seen = await collab.get('/api/tiktok/balance');
    assert.equal(seen.status, 200);
    assert.equal(seen.json.canTransfer, false, 'a tela esconde o botão');
    assert.equal((await owner.client.get('/api/tiktok/balance')).json.canTransfer, true);
    const res = await collab.post('/api/tiktok/balance/transfer', body(owner, { password: 'SenhaDoColaborador-12' }));
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'transfer_owner_only');
    assert.equal(transferCalls().length, 0);
    assert.equal((await rows()).length, 0);
  });

  it('exige login, CSRF e a área "Contas TikTok"', async () => {
    const owner = await setup();
    assert.equal((await ctx.client().post('/api/tiktok/balance/transfer', body(owner))).status, 401);
    const noCsrf = owner.client.csrf;
    owner.client.csrf = 'invalido';
    assert.equal((await send(owner)).status, 403, 'sem o token CSRF certo');
    owner.client.csrf = noCsrf;
    assert.equal(transferCalls().length, 0);
    const other = await createUser(ctx, { approve: false, email: emailOf() });
    assert.equal((await other.client.post('/api/tiktok/balance/transfer', body(owner))).status, 403, 'conta pendente');
  });

  it('pedido inválido é recusado antes de qualquer chamada ao TikTok e sem registro', async () => {
    const user = await setup();
    const bad = [
      { amount: 0 }, { amount: -5 }, { amount: '1.234' }, { amount: '1e3' }, { amount: 100001 }, { amount: 'abc' }, { amount: null }, { type: 'DELETE' }, { type: undefined },
      { advertiserId: '9001; x' }, { bcId: 'abc' }, { connectionId: 'x' }, { operationId: 'curto' }, { operationId: undefined }, { password: '' }, { password: undefined },
    ];
    for (const patch of bad) {
      const res = await send(user, patch);
      assert.ok([400, 403].includes(res.status) && res.status === 400, `${JSON.stringify(patch)} -> ${res.status} ${res.text}`);
    }
    assert.equal((await user.client.post('/api/tiktok/balance/transfer', { connectionId: user.connectionId })).status, 400);
    assert.equal(transferCalls().length, 0);
    assert.equal((await rows()).length, 0);
  });

  it('saldo insuficiente é conferido com o saldo ATUAL antes de chamar o TikTok (BC e conta)', async () => {
    const user = await setup();
    const tooMuch = await send(user, { amount: 200.01 });
    assert.equal(tooMuch.status, 409, tooMuch.text);
    assert.equal(tooMuch.json.error.code, 'insufficient_balance');
    assert.match(message(tooMuch), /Business Center tem .*200,00.* você pediu .*200,01/);
    const refund = await send(user, { type: 'REFUND', amount: 40.01 });
    assert.equal(refund.status, 409);
    assert.match(message(refund), /a conta pode devolver .*40,00/);
    const exact = await send(user, { amount: 200 });
    assert.equal(exact.status, 201, 'o valor exato do saldo é permitido');
    assert.equal(transferCalls().length, 1);
    assert.equal((await rows()).length, 1, 'só a transferência que de fato foi ao TikTok');
  });

  it('o limite de devolução usa o "valor transferível" do TikTok (que exclui o bloqueado)', async () => {
    const user = await setup();
    fake.state.balances.advertisers[111][0] = account('9001', { valid_account_balance: '40', account_balance: '60', frozen_balance: '20', transferable_amount: '30' });
    const res = await send(user, { type: 'REFUND', amount: 35 });
    assert.equal(res.status, 409);
    assert.match(message(res), /30,00/);
    assert.equal((await send(user, { type: 'REFUND', amount: 30 })).status, 201);
  });

  it('contas que não aceitam transferência por aqui: portfólio compartilhado, orçamento da BC e moedas diferentes', async () => {
    const user = await setup();
    fake.state.balances.advertisers[111] = [
      account('9001', { payment_portfolio_id: '7000000000000000001', payment_portfolio_type: 'SHARED', balance_info: { valid_account_balance: '0', account_balance: '0' } }),
      account('9002', { budget_mode: 'DAILY_BUDGET', budget: '100', budget_cost: '10', budget_remaining: '90', valid_account_balance: '0', account_balance: '0' }),
    ];
    const shared = await send(user, { advertiserId: '9001' });
    assert.equal(shared.status, 409);
    assert.equal(shared.json.error.code, 'transfer_not_allowed');
    assert.match(message(shared), /compartilhado/);
    assert.match(message(await send(user, { advertiserId: '9002' })), /orçamento/);
    fake.state.balances.advertisers[111] = [account('9001', { currency: 'BRL' })];
    assert.match(message(await send(user, {})), /moedas diferentes/);
    assert.equal(transferCalls().length, 0);
    assert.equal((await rows()).length, 0);
  });

  it('conta, BC ou conexão de OUTRA pessoa: 404 e nada é enviado ao TikTok', async () => {
    const owner = await setup();
    const intruder = await createUser(ctx, { approve: true, email: emailOf() });
    const res = await intruder.client.post('/api/tiktok/balance/transfer', body(owner));
    assert.equal(res.status, 404, res.text);
    const own = await send(owner, { advertiserId: '9999' });
    assert.equal(own.status, 404, 'conta que não é da BC');
    assert.equal((await send(owner, { bcId: '222' })).status, 404, 'BC que não é da conexão');
    assert.equal(transferCalls().length, 0);
    assert.equal((await rows()).length, 0);
  });

  it('a mesma operação nunca move o dinheiro duas vezes (reenvio, duplo clique, repetição)', async () => {
    const user = await setup();
    const one1 = body(user, { amount: 10 });
    const first = await user.client.post('/api/tiktok/balance/transfer', one1);
    assert.equal(first.status, 201);
    const again = await user.client.post('/api/tiktok/balance/transfer', one1);
    assert.equal(again.status, 201);
    assert.equal(again.json.duplicate, true, 'devolve o resultado guardado');
    assert.equal(again.json.transfer.id, first.json.transfer.id);
    assert.equal(transferCalls().length, 1, 'o TikTok foi chamado uma vez só');
    assert.equal((await overview(user)).accounts.find((a) => a.advertiserId === '9001').main, 50, '40 + 10, uma vez');
    assert.equal((await rows()).length, 1);
  });

  it('dois pedidos AO MESMO TEMPO para a mesma conta: um passa, o outro recebe "em andamento"', async () => {
    const user = await setup();
    fake.state.transferDelayMs = 300;
    const [a, b] = await Promise.all([send(user, { amount: 10 }), send(user, { amount: 10 })]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409], `${a.text} | ${b.text}`);
    assert.equal(transferCalls().length, 1);
    assert.match(message(a.status === 409 ? a : b), /em andamento/);
    assert.equal((await rows()).length, 1);
  });

  it('o TikTok recusa por falta da função Finance Manager: erro claro, registro "failed", saldo igual; reenviar a mesma operação não vale', async () => {
    const user = await setup();
    fake.state.transferFinanceRole = false;
    const request = body(user);
    const res = await user.client.post('/api/tiktok/balance/transfer', request);
    assert.equal(res.status, 502, res.text);
    assert.equal(res.json.error.code, 'transfer_failed');
    assert.match(message(res), /Finance Manager/);
    const db = await rows();
    assert.deepEqual([db.length, db[0].status, db[0].transaction_ids], [1, 'failed', null]);
    assert.match(db[0].error_message, /Finance Manager/);
    assert.equal((await overview(user)).bcs[0].main, 200, 'nada mudou');
    const replay = await user.client.post('/api/tiktok/balance/transfer', request);
    assert.equal(replay.status, 409, 'mesma operação que falhou: precisa de uma nova');
    fake.state.transferFinanceRole = true;
    assert.equal((await send(user)).status, 201, 'operação nova, agora com permissão');
  });

  it('sem resposta do TikTok (rede): o resultado fica "unknown" e a mensagem manda conferir o saldo', async () => {
    const user = await setup();
    fake.state.transferNetworkError = true;
    const res = await send(user);
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'transfer_unconfirmed');
    assert.match(message(res), /PODE ter sido transferido/);
    const db = await rows();
    assert.deepEqual([db[0].status, db[0].finished_at !== null], ['unknown', true]);
    assert.equal(transferCalls().length, 1, 'não tentou de novo sozinho');
    fake.state.transferNetworkError = false;
  });

  it('o TikTok recusa o valor (ex.: abaixo do mínimo): a mensagem dele aparece e nada é dado como feito', async () => {
    const user = await setup();
    fake.state.minRecharge = 20;
    const res = await send(user, { amount: 10 });
    assert.equal(res.status, 502);
    assert.match(message(res), /minimum amount/);
    assert.equal((await rows())[0].status, 'failed');
  });

  it('limite de transferências por hora (por pessoa)', async () => {
    const lim = await startTestServer({ limits: { ...LIMITS, balanceTransfer: 2 }, config: tiktokTestConfig(), fetchFn: fake.fetchFn, isolated: true });
    try {
      const user = await createUser(lim, { approve: true, email: emailOf() });
      await setup();
      const bc = await user.client.post('/api/tiktok/business-centers', { name: 'BC', bcId: '111', accessToken: GOOD_TOKEN });
      const connectionId = bc.json.businessCenter?.id ?? bc.json.id;
      const make = () => user.client.post('/api/tiktok/balance/transfer', { connectionId, bcId: '111', advertiserId: '9001', type: 'RECHARGE', amount: 1, operationId: opId(), password: USER_PASSWORD });
      assert.equal((await make()).status, 201);
      assert.equal((await make()).status, 201);
      assert.equal((await make()).status, 429);
    } finally {
      await lim.stop();
    }
  });

  it('a tabela de transferências nunca é apagada junto com a conexão (histórico financeiro) e não guarda token nem senha', async () => {
    const user = await setup();
    await send(user, { amount: 3 });
    await run(ctx.db, 'DELETE FROM tiktok_business_centers WHERE id = $1', [user.connectionId]);
    const db = await one(ctx.db, 'SELECT * FROM balance_transfers');
    assert.equal(db.connection_id, null, 'o vínculo some, o registro fica');
    assert.ok(!JSON.stringify(db).includes(GOOD_TOKEN) && !JSON.stringify(db).includes(USER_PASSWORD));
  });

  it('o banco recusa registro inválido (valor negativo, operação fora do formato, status desconhecido, duplicada)', async () => {
    const user = await setup();
    const insert = (over = {}) => run(ctx.db, `INSERT INTO balance_transfers (user_id, bc_id, advertiser_id, direction, amount, operation_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [user.id, over.bc ?? '111', over.adv ?? '9001', over.dir ?? 'RECHARGE', over.amount ?? 1, over.op ?? opId(), over.status ?? 'pending']);
    await insert();
    for (const over of [{ amount: -1 }, { amount: 0 }, { amount: 1000001 }, { op: 'xyz' }, { status: 'done' }, { dir: 'DELETE' }, { bc: 'abc' }, { adv: '1; x' }]) await assert.rejects(() => insert(over), JSON.stringify(over));
    const fixed = opId();
    await insert({ op: fixed });
    await assert.rejects(() => insert({ op: fixed }), 'mesma operação da mesma pessoa');
  });
});
