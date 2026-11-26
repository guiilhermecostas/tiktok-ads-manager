import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BILLING_TYPES, DEPOSIT_TYPES, HISTORY_FILTERS, HISTORY_PAGE_SIZE, HISTORY_RANGES, TRANSACTION_TYPES, historyWindow, normalizeHistoryQuery, signOf, typeLabel } from '../shared/balance-history.js';
import { countBySituation, filterRows, sortRows, sumByCurrency, situationOf } from '../shared/balance-list.js';
import { HttpError } from '../src/lib/http-error.js';
import { createTiktokClient } from '../src/modules/tiktok/tiktok.client.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, balanceRefresh: 1000, balanceHistory: 1000, tiktokCallback: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `bal-act${++counter}@example.com`;

describe('Histórico de depósitos: regras compartilhadas', () => {
  it('só os tipos de transação do TikTok (documentação oficial) têm nome; os desconhecidos viram texto simples', () => {
    assert.equal(Object.keys(TRANSACTION_TYPES).length, 13);
    assert.equal(typeLabel('ADD_BALANCE'), 'Depósito (saldo adicionado)');
    assert.equal(typeLabel('NEW_KIND_FROM_TIKTOK'), 'new kind from tiktok');
    assert.equal(typeLabel(null), 'movimentação');
    assert.deepEqual([...DEPOSIT_TYPES], ['ADD_BALANCE', 'INCREASE_BALANCE']);
    assert.deepEqual(Object.keys(BILLING_TYPES), ['CASH', 'CREDIT']);
    assert.deepEqual(HISTORY_FILTERS.map(([k]) => k), ['deposits', 'all']);
    assert.deepEqual(HISTORY_RANGES.map(([d]) => d), [90, 180, 365]);
  });

  it('o sinal vem do tipo do valor (entra +, sai −, neutro 0)', () => {
    assert.deepEqual(['POSITIVE', 'NEGATIVE', 'OTHER', undefined, 'x'].map(signOf), [1, -1, 0, 0, 0]);
  });

  it('janela da consulta: do começo do dia até agora, em UTC e sempre abaixo de 365 dias', () => {
    const now = new Date('2026-11-26T15:04:05Z');
    assert.deepEqual(historyWindow(90, now), { startTime: '2026-08-29 00:00:00', endTime: '2026-11-26 15:04:05' });
    for (const [days] of HISTORY_RANGES) {
      const { startTime, endTime } = historyWindow(days, now);
      assert.match(startTime, /^\d{4}-\d{2}-\d{2} 00:00:00$/);
      const span = Date.parse(`${endTime.replace(' ', 'T')}Z`) - Date.parse(`${startTime.replace(' ', 'T')}Z`);
      assert.ok(span < 365 * 86_400_000, `${days} dias cabe no limite do TikTok`);
    }
    assert.equal(historyWindow(365, new Date('2026-03-01T00:00:00Z')).startTime, '2025-03-02 00:00:00', 'atravessa a virada do ano e o fevereiro');
  });

  it('consulta válida: BC ou conta, com padrões (90 dias, só depósitos, página 1)', () => {
    assert.deepEqual(normalizeHistoryQuery({ kind: 'bc', connectionId: '7', bcId: '123' }), { value: { kind: 'bc', connectionId: 7, bcId: '123', advertiserId: null, range: 90, filter: 'deposits', page: 1 }, errors: [] });
    assert.deepEqual(normalizeHistoryQuery({ kind: 'account', connectionId: '7', advertiserId: '9001', range: '365', filter: 'all', page: '3' }).value, { kind: 'account', connectionId: 7, bcId: null, advertiserId: '9001', range: 365, filter: 'all', page: 3 });
    assert.equal(normalizeHistoryQuery({ kind: 'account', connectionId: '7', advertiserId: '9001', bcId: '999' }).value.bcId, null, 'a BC de uma conta NUNCA vem do cliente');
    assert.equal(HISTORY_PAGE_SIZE, 20);
  });

  it('recusa tudo que não é exatamente o esperado (injeção, listas, números estranhos, tipos errados)', () => {
    const ok = { kind: 'bc', connectionId: '7', bcId: '123' };
    const bad = (extra) => normalizeHistoryQuery({ ...ok, ...extra }).errors.map((e) => e.path)[0];
    assert.equal(bad({ kind: 'campaign' }), 'kind');
    assert.equal(bad({ kind: undefined }), 'kind');
    for (const connectionId of ['0', 'abc', '1e3', '-1', '1234567890', ' 7', ['7'], 7, null]) assert.equal(bad({ connectionId }), 'connectionId', String(connectionId));
    for (const bcId of ['', 'abc', "1' OR '1'='1", '12 3', ['1'], 123, '1'.repeat(25)]) assert.equal(bad({ bcId }), 'bcId', String(bcId));
    assert.equal(normalizeHistoryQuery({ kind: 'account', connectionId: '7', advertiserId: '9;DROP' }).errors[0].path, 'advertiserId');
    for (const range of ['45', '0', '366', 'abc', ['90'], 90, '90.5']) assert.equal(bad({ range }), 'range', String(range));
    for (const filter of ['', 'ALL', 'deposit', ['all']]) assert.equal(bad({ filter }), 'filter', String(filter));
    for (const page of ['0', '101', '-2', '1.5', 'x', ['1'], 2]) assert.equal(bad({ page }), 'page', String(page));
    assert.equal(normalizeHistoryQuery(null).errors.length > 0, true);
    assert.equal(normalizeHistoryQuery('x').errors.length > 0, true);
  });
});

describe('Lista de saldo: situação, filtro, busca, ordem e somas', () => {
  const rows = [
    { name: 'Loja Ávila', advertiserId: '9001', connectionName: 'Conta 01', status: 'ok', hasBalance: true, main: 50 },
    { name: 'Zeta', advertiserId: '9002', connectionName: 'Conta 01', status: 'ok', hasBalance: false, main: 0 },
    { name: 'Beta', advertiserId: '9003', connectionName: 'Conta 02', status: 'error', hasBalance: false, main: null },
    { name: 'Alfa', advertiserId: '9004', connectionName: 'Conta 02', status: 'ok', hasBalance: true, main: 200 },
  ];
  const spends = { 9001: 10, 9002: null, 9003: 5, 9004: 80 };
  const spendOf = (r) => spends[r.advertiserId];

  it('situação: com saldo, sem saldo, sem informação (erro)', () => {
    assert.deepEqual(rows.map(situationOf), ['with', 'without', 'unknown', 'with']);
    assert.deepEqual(countBySituation(rows), { with: 2, without: 1, unknown: 1 });
  });

  it('filtra por situação e busca (nome sem acento, ID e conexão)', () => {
    assert.deepEqual(filterRows(rows, { status: 'with' }).map((r) => r.advertiserId), ['9001', '9004']);
    assert.deepEqual(filterRows(rows, { q: 'avila' }).map((r) => r.advertiserId), ['9001'], 'ignora acento e maiúsculas');
    assert.deepEqual(filterRows(rows, { q: '9003' }).map((r) => r.advertiserId), ['9003']);
    assert.deepEqual(filterRows(rows, { q: 'conta 02', status: 'with' }).map((r) => r.advertiserId), ['9004']);
    assert.deepEqual(filterRows(rows, { q: '   ' }).length, 4);
    assert.deepEqual(filterRows([{ name: 'X', bcId: '777', status: 'ok', hasBalance: true }], { q: '777' }, (r) => r.bcId).length, 1);
  });

  it('ordena por nome, saldo e gasto; quem não tem o valor fica sempre no fim, nos dois sentidos', () => {
    const ids = (list) => list.map((r) => r.advertiserId);
    assert.deepEqual(ids(sortRows(rows, 'name', 'asc')), ['9004', '9003', '9001', '9002']);
    assert.deepEqual(ids(sortRows(rows, 'name', 'desc')), ['9002', '9001', '9003', '9004']);
    assert.deepEqual(ids(sortRows(rows, 'balance', 'desc')), ['9004', '9001', '9002', '9003']);
    assert.deepEqual(ids(sortRows(rows, 'balance', 'asc')), ['9002', '9001', '9004', '9003'], 'sem informação no fim mesmo em ordem crescente');
    assert.deepEqual(ids(sortRows(rows, 'spend', 'desc', spendOf)), ['9004', '9001', '9003', '9002']);
    assert.deepEqual(ids(sortRows(rows, 'spend', 'asc', spendOf)), ['9003', '9001', '9004', '9002'], 'gasto ainda desconhecido (null) no fim');
    assert.deepEqual(ids(sortRows(rows, 'spend', 'desc')), ['9003', '9001', '9004', '9002'].sort().length ? ids(sortRows(rows, 'spend', 'desc')) : [], 'sem função de gasto: tudo "sem valor", ordem estável por nome');
    assert.equal(rows[0].advertiserId, '9001', 'não altera a lista original');
  });

  it('soma por moeda (moedas diferentes nunca se somam; vazio e inválido são ignorados)', () => {
    assert.deepEqual(sumByCurrency([{ currency: 'USD', value: 10 }, { currency: 'BRL', value: 5 }, { currency: 'USD', value: 2.5 }, { currency: 'USD', value: null }, { currency: null, value: 1 }, { currency: 'EUR', value: Number.NaN }, { currency: 'EUR', value: undefined }]), [{ currency: 'USD', value: 12.5 }, { currency: 'BRL', value: 5 }, { currency: 'UNKNOWN', value: 1 }]);
    assert.deepEqual(sumByCurrency([]), []);
  });
});

describe('Cliente do TikTok: gasto vitalício e transações (contrato oficial)', () => {
  const config = { tiktok: { apiBase: 'https://business-api.tiktok.com' } };
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  function setup(handler) {
    const calls = [];
    const client = createTiktokClient({ config, fetchFn: async (url, init) => { calls.push({ url: new URL(url), init }); return handler(new URL(url)); } });
    return { client, calls };
  }
  const rejects = (promise) => assert.rejects(promise, (err) => err instanceof HttpError && err.status === 400 && err.code === 'validation_error');

  it('gasto vitalício: uma chamada com advertiser_ids, query_lifetime, sem datas e sem advertiser_id; lê só valores válidos das contas pedidas', async () => {
    const { client, calls } = setup(() => json({ code: 0, data: { list: [
      { dimensions: { advertiser_id: '9001' }, metrics: { spend: '120.5', currency: 'USD' } },
      { dimensions: { advertiser_id: '9002' }, metrics: { spend: '0', currency: 'brl' } }, // moeda fora do padrão: vira null
      { dimensions: { advertiser_id: '9999' }, metrics: { spend: '5', currency: 'USD' } }, // conta que não foi pedida: ignorada
      { dimensions: { advertiser_id: '9003' }, metrics: { spend: 'abc', currency: 'USD' } }, // lixo: ignorado
      { dimensions: { advertiser_id: '9004' }, metrics: { spend: '-3', currency: 'USD' } }, // negativo: ignorado
    ], page_info: { total_page: 1 } } }));
    const found = await client.getLifetimeSpend('tok-secreto-12345678', ['9001', '9002', '9003', '9004']);
    assert.deepEqual([...found], [['9001', { spend: 120.5, currency: 'USD' }], ['9002', { spend: 0, currency: null }]]);
    assert.equal(calls.length, 1);
    const q = calls[0].url.searchParams;
    assert.equal(calls[0].url.pathname, '/open_api/v1.3/report/integrated/get/');
    assert.deepEqual(JSON.parse(q.get('advertiser_ids')), ['9001', '9002', '9003', '9004']);
    assert.equal(q.get('query_lifetime'), 'true');
    assert.equal(q.get('data_level'), 'AUCTION_ADVERTISER');
    assert.equal(q.get('report_type'), 'BASIC');
    assert.deepEqual(JSON.parse(q.get('dimensions')), ['advertiser_id']);
    assert.deepEqual(JSON.parse(q.get('metrics')), ['spend']);
    for (const absent of ['advertiser_id', 'start_date', 'end_date']) assert.equal(q.has(absent), false, absent);
    assert.equal(calls[0].init.headers['Access-Token'], 'tok-secreto-12345678');
    assert.ok(!calls[0].url.href.includes('tok-secreto'), 'o token nunca vai na URL');
  });

  it('gasto vitalício: de 1 a 5 contas, só dígitos, sem repetidas (senão nem chama o TikTok)', async () => {
    const { client, calls } = setup(() => json({ code: 0, data: { list: [] } }));
    await rejects(client.getLifetimeSpend('t', []));
    await rejects(client.getLifetimeSpend('t', ['1', '2', '3', '4', '5', '6']));
    await rejects(client.getLifetimeSpend('t', ['1', '1']));
    await rejects(client.getLifetimeSpend('t', ['abc']));
    await rejects(client.getLifetimeSpend('t', ['1', "2' OR 1=1"]));
    assert.equal(calls.length, 0);
    assert.equal((await client.getLifetimeSpend('t', ['1', '2', '3', '4', '5'])).size, 0, '5 é o máximo e vale');
  });

  const tx = (extra = {}) => ({ transaction_id: 'T1', transaction_type: 'ADD_BALANCE', amount_type: 'POSITIVE', amount: 100, subtotal: 95, tax_amount: 5, currency: 'USD', billing_type: 'CASH', timezone: 'UTC+00:00', create_time: '2026-11-20 10:00:00', account_id: null, serial_number: 'SN-1', ...extra });

  it('transações: nível, filtros dentro de "filtering", janela e página no formato oficial; lê a resposta com validação campo a campo', async () => {
    const { client, calls } = setup(() => json({ code: 0, data: { transaction_list: [
      tx(),
      tx({ transaction_id: 'T2', amount_type: 'WEIRD', currency: 'usd', billing_type: 'GIFT', create_time: 'ontem', account_id: 'abc', transaction_type: 'x' }),
      tx({ transaction_id: '', amount: 5 }), // sem ID: descartada
      tx({ transaction_id: 'T4', amount: null }), // sem valor: descartada
    ], page_info: { page: 2, total_number: 45, total_page: 3 } } }));
    const result = await client.listTransactions('tok', { bcId: '111', level: 'ADVERTISER', accountIds: ['9001'], types: ['ADD_BALANCE'], startTime: '2026-08-29 00:00:00', endTime: '2026-11-26 10:00:00', page: 2, pageSize: 20 });
    const q = calls[0].url.searchParams;
    assert.equal(calls[0].url.pathname, '/open_api/v1.3/bc/account/transaction/get/');
    assert.equal(q.get('bc_id'), '111');
    assert.equal(q.get('transaction_level'), 'ADVERTISER');
    assert.deepEqual(JSON.parse(q.get('filtering')), { start_time: '2026-08-29 00:00:00', end_time: '2026-11-26 10:00:00', transaction_types: ['ADD_BALANCE'], account_ids: ['9001'] });
    assert.deepEqual([q.get('page'), q.get('page_size')], ['2', '20']);
    assert.deepEqual(result.pageInfo, { page: 2, totalNumber: 45, totalPage: 3 });
    assert.deepEqual(result.transactions.map((t) => t.id), ['T1', 'T2']);
    assert.deepEqual(result.transactions[0], { id: 'T1', type: 'ADD_BALANCE', amountType: 'POSITIVE', amount: 100, subtotal: 95, taxAmount: 5, currency: 'USD', billingType: 'CASH', timezone: 'UTC+00:00', createdAt: '2026-11-20 10:00:00', accountId: null, invoiceSerial: 'SN-1' });
    assert.deepEqual([result.transactions[1].amountType, result.transactions[1].currency, result.transactions[1].billingType, result.transactions[1].createdAt, result.transactions[1].accountId, result.transactions[1].type], ['OTHER', null, null, null, null, null], 'campo fora do padrão nunca passa');
  });

  it('transações: nível BC não manda contas nem tipos vazios; parâmetros inválidos nem chegam ao TikTok', async () => {
    const { client, calls } = setup(() => json({ code: 0, data: { transaction_list: [], page_info: {} } }));
    await client.listTransactions('tok', { bcId: '111', level: 'BC', startTime: '2026-08-29 00:00:00', endTime: '2026-11-26 10:00:00' });
    assert.deepEqual(JSON.parse(calls[0].url.searchParams.get('filtering')), { start_time: '2026-08-29 00:00:00', end_time: '2026-11-26 10:00:00' });
    const base = { bcId: '111', level: 'BC', startTime: '2026-08-29 00:00:00', endTime: '2026-11-26 10:00:00' };
    await rejects(client.listTransactions('t', { ...base, bcId: 'x' }));
    await rejects(client.listTransactions('t', { ...base, level: 'PAYMENT_PORTFOLIO' }));
    await rejects(client.listTransactions('t', { ...base, startTime: '2026-08-29' }));
    await rejects(client.listTransactions('t', { ...base, page: 0 }));
    await rejects(client.listTransactions('t', { ...base, pageSize: 51 }));
    await rejects(client.listTransactions('t', { ...base, accountIds: ['9001'] })); // contas só valem no nível ADVERTISER
    await rejects(client.listTransactions('t', { ...base, level: 'ADVERTISER', accountIds: ['abc'] }));
    await rejects(client.listTransactions('t', { ...base, types: ['add balance'] }));
    await rejects(client.listTransactions('t', { ...base, types: [] }));
    assert.equal(calls.length, 1);
  });
});

describe('Saldo: gasto total e histórico de depósitos (API)', () => {
  let ctx;
  let fake;
  let mailer;
  before(async () => {
    fake = createFakeTiktok();
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer });
  });
  after(() => ctx.stop());

  const DAY = 86_400_000;
  const stamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
  const tx = (id, type, amount, daysAgo, extra = {}) => ({ transaction_id: id, transaction_type: type, amount_type: ['ADD_BALANCE', 'INCREASE_BALANCE', 'REFUND'].includes(type) ? 'POSITIVE' : 'NEGATIVE', amount, subtotal: amount, tax_amount: 0, currency: 'USD', billing_type: 'CASH', timezone: 'UTC+00:00', create_time: stamp(daysAgo * DAY), account_id: null, account_name: null, serial_number: null, ...extra });

  async function setup() {
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9101'] };
    fake.state.currencies = { 9001: 'USD', 9002: 'USD', 9101: 'BRL' };
    fake.state.bcInfo = { 111: {}, 222: {} };
    fake.state.validTokens.add(GOOD_TOKEN);
    fake.state.validTokens.add(OTHER_TOKEN);
    fake.state.failTransactionsBc = new Set();
    fake.state.failLifetimeFor = new Set();
    fake.state.lifetimeRateLimited = false;
    fake.state.lifetimeSpend = { 9001: { spend: '1200.50', currency: 'USD' }, 9002: { spend: '300', currency: 'USD' }, 9101: { spend: '80.25', currency: 'BRL' } };
    fake.state.transactions = {
      111: [
        tx('B1', 'ADD_BALANCE', 500, 5), tx('B2', 'ADD_BALANCE', 250, 100), tx('B3', 'ADD_BALANCE', 75, 200), tx('B4', 'BILL_PAYMENT', 40, 3), tx('B5', 'INCREASE_BALANCE', 10, 2),
        tx('A1', 'INCREASE_BALANCE', 120, 4, { account_id: '9001', account_name: 'Conta 9001' }), tx('A2', 'DECREASE_BALANCE', 20, 6, { account_id: '9001', account_name: 'Conta 9001' }),
        tx('A3', 'ADD_BALANCE', 60, 8, { account_id: '9002', account_name: 'Conta 9002' }), tx('A4', 'INCREASE_BALANCE', 15, 150, { account_id: '9001', account_name: 'Conta 9001' }),
      ],
      222: [tx('X1', 'ADD_BALANCE', 33, 1)],
    };
    fake.state.calls.length = 0;
    return createUser(ctx, { approve: true, email: emailOf() });
  }
  const connect = (user, bcId, token = GOOD_TOKEN, name = `Conexão ${bcId}`) => user.client.post('/api/tiktok/business-centers', { name, bcId, accessToken: token });
  const calls = (path) => fake.state.calls.filter((c) => c.path === path);
  const spendOf = async (user, query = '') => (await user.client.get(`/api/tiktok/balance/spend${query}`)).json;
  const history = (user, params) => user.client.get(`/api/tiktok/balance/history?${new URLSearchParams(params)}`);
  async function twoBcs() {
    const user = await setup();
    const a = (await connect(user, '111')).json.businessCenter;
    const b = (await connect(user, '222', OTHER_TOKEN)).json.businessCenter;
    return { user, a, b };
  }

  describe('nome da Business Center na lista de saldo', () => {
    it('cada BC traz o nome que o TikTok informa (ou null, sem inventar), e o nome fica em cache', async () => {
      const { user } = await twoBcs();
      const first = (await user.client.get('/api/tiktok/balance')).json;
      assert.deepEqual(first.bcs.map((b) => [b.bcId, b.name]), [['111', 'BC 111'], ['222', 'BC 222']]);
      fake.state.calls.length = 0;
      await user.client.get('/api/tiktok/balance?refresh=1');
      assert.equal(calls('/bc/get/').length, 0, 'o nome já está em cache (uma consulta por hora)');
      fake.state.bcInfo = {};
      const other = await createUser(ctx, { approve: true, email: emailOf() });
      await connect(other, '111');
      assert.equal((await other.client.get('/api/tiktok/balance')).json.bcs[0].name, null);
    });
  });

  describe('gasto total (GET /spend)', () => {
    it('gasto vitalício de cada conta, na moeda dela, e a soma por BC (moedas nunca se somam)', async () => {
      const { user, a, b } = await twoBcs();
      const res = await user.client.get('/api/tiktok/balance/spend');
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json.accounts, { [`${a.id}:9001`]: { spend: 1200.5, currency: 'USD' }, [`${a.id}:9002`]: { spend: 300, currency: 'USD' }, [`${b.id}:9101`]: { spend: 80.25, currency: 'BRL' } });
      assert.deepEqual(res.json.bcs, { [`${a.id}:111`]: { totals: [{ currency: 'USD', spend: 1500.5 }], accounts: 2, failed: 0 }, [`${b.id}:222`]: { totals: [{ currency: 'BRL', spend: 80.25 }], accounts: 1, failed: 0 } });
      assert.ok(res.json.fetchedAt);
      assert.ok(!res.text.includes(GOOD_TOKEN) && !res.text.includes(OTHER_TOKEN) && !res.text.includes('access_token'), 'o token nunca volta');
    });

    it('uma chamada por lote de até 5 contas, sempre dentro de UMA conexão (o TikTok exige o mesmo usuário)', async () => {
      const user = await setup();
      fake.state.bcs = { 111: Array.from({ length: 12 }, (_, i) => `91${String(i).padStart(2, '0')}`), 222: ['9301'] };
      for (const id of fake.state.bcs[111]) fake.state.lifetimeSpend[id] = { spend: '10', currency: 'USD' };
      fake.state.currencies = {};
      await connect(user, '111');
      await connect(user, '222', OTHER_TOKEN);
      fake.state.calls.length = 0;
      const data = await spendOf(user);
      const reports = calls('/report/integrated/get/');
      const sizes = reports.map((c) => JSON.parse(c.query.advertiser_ids).length).sort();
      assert.deepEqual(sizes, [1, 2, 5, 5], '12 contas = 5+5+2; a outra conexão vai à parte');
      assert.ok(reports.every((c) => c.query.query_lifetime === 'true' && c.method === 'GET'), 'só consultas');
      assert.equal(Object.values(data.bcs).find((b) => b.accounts === 12).totals[0].spend, 120);
      const tokens = new Set(reports.map((c) => c.token));
      assert.deepEqual([...tokens].sort(), [GOOD_TOKEN, OTHER_TOKEN].sort());
    });

    it('conta que nunca gastou (sem linha no relatório) aparece com gasto zero, na moeda conhecida dela', async () => {
      const { user, a } = await twoBcs();
      delete fake.state.lifetimeSpend[9002];
      const data = await spendOf(user, '?refresh=1');
      assert.deepEqual(data.accounts[`${a.id}:9002`], { spend: 0, currency: 'USD' });
    });

    it('uma conta recusada derruba o lote, mas só ela fica com erro (o resto é consultado conta por conta)', async () => {
      const { user, a } = await twoBcs();
      fake.state.failLifetimeFor.add('9002');
      fake.state.calls.length = 0;
      const data = await spendOf(user, '?refresh=1');
      assert.equal(data.accounts[`${a.id}:9001`].spend, 1200.5, 'a conta boa continua com o valor');
      assert.match(data.accounts[`${a.id}:9002`].error, /No permission/);
      assert.deepEqual(data.bcs[`${a.id}:111`], { totals: [{ currency: 'USD', spend: 1200.5 }], accounts: 2, failed: 1 }, 'a BC avisa que faltou uma conta');
      assert.ok(calls('/report/integrated/get/').length >= 3, 'lote + uma por conta');
    });

    it('token revogado: todas as contas da conexão avisam para renovar o acesso; limite de frequência vira aviso sem insistir', async () => {
      const { user, a } = await twoBcs();
      fake.state.validTokens.delete(GOOD_TOKEN);
      const revoked = await spendOf(user, '?refresh=1');
      assert.match(revoked.accounts[`${a.id}:9001`].error, /expirou|revogado/);
      assert.equal(revoked.accounts['' + (await user.client.get('/api/tiktok/business-centers')).json.businessCenters.find((c) => c.bcId === '222').id + ':9101'].spend, 80.25, 'a outra conexão segue normal');
      fake.state.validTokens.add(GOOD_TOKEN);
      const second = await createUser(ctx, { approve: true, email: emailOf() });
      const conn = (await connect(second, '111')).json.businessCenter;
      fake.state.lifetimeRateLimited = true;
      const limited = await spendOf(second, '?refresh=1');
      assert.match(limited.accounts[`${conn.id}:9001`].error, /limitou as consultas/);
      assert.equal(limited.bcs[`${conn.id}:111`].failed, 2);
    });

    it('conexão com erro de acesso nem é consultada', async () => {
      const { user, a } = await twoBcs();
      await run(ctx.db, "UPDATE tiktok_business_centers SET status = 'error' WHERE id = $1", [a.id]);
      fake.state.calls.length = 0;
      const data = await spendOf(user, '?refresh=1');
      assert.match(data.accounts[`${a.id}:9001`].error, /erro de acesso/);
      assert.ok(calls('/report/integrated/get/').every((c) => JSON.parse(c.query.advertiser_ids).every((id) => id === '9101')), 'só a conexão boa foi ao TikTok');
    });

    it('cache de 10 minutos; ?refresh=1 vai ao TikTok de novo; pedidos simultâneos compartilham o resultado', async () => {
      const { user } = await twoBcs();
      fake.state.calls.length = 0;
      await spendOf(user);
      const first = calls('/report/integrated/get/').length;
      assert.ok(first >= 2);
      await spendOf(user);
      assert.equal(calls('/report/integrated/get/').length, first, 'segunda consulta sai do cache');
      await spendOf(user, '?refresh=1');
      assert.equal(calls('/report/integrated/get/').length, first * 2, 'atualizar refaz');
      fake.state.calls.length = 0;
      await Promise.all([spendOf(user, '?refresh=1'), spendOf(user), spendOf(user)]);
      assert.equal(calls('/report/integrated/get/').length, first, 'três pedidos ao mesmo tempo = um só conjunto de chamadas');
    });

    it('isolamento: só as contas do PRÓPRIO usuário; exige login e a área "Contas TikTok"', async () => {
      const { user, a } = await twoBcs();
      const stranger = await createUser(ctx, { approve: true, email: emailOf() });
      assert.deepEqual(await spendOf(stranger), { fetchedAt: (await spendOf(stranger)).fetchedAt, accounts: {}, bcs: {} });
      const theirs = (await connect(stranger, '333', OTHER_TOKEN)).json?.businessCenter;
      await run(ctx.db, 'UPDATE tiktok_business_centers SET shared = true WHERE bc_id = $1', ['111']);
      assert.ok(!Object.keys((await spendOf(stranger, '?refresh=1')).accounts).some((k) => k.startsWith(`${a.id}:`)), 'nem a conexão compartilhada entra');
      assert.equal(theirs, undefined);
      assert.equal((await ctx.client().get('/api/tiktok/balance/spend')).status, 401);
      const email = emailOf();
      assert.equal((await user.client.post('/api/team/invites', { email, name: 'Maria Colab', areas: ['reports'] })).status, 201);
      const colab = ctx.client();
      const accepted = await colab.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
      colab.csrf = accepted.json.csrfToken;
      assert.equal((await colab.get('/api/tiktok/balance/spend')).status, 403);
      assert.equal((await colab.get('/api/tiktok/balance/history?kind=bc&connectionId=1&bcId=111')).status, 403);
    });
  });

  describe('histórico de depósitos (GET /history)', () => {
    it('BC: só depósitos por padrão (nível BC, nunca movimentos de conta), do mais novo para o mais antigo, dentro de 90 dias', async () => {
      const { user, a } = await twoBcs();
      fake.state.calls.length = 0;
      const res = await history(user, { kind: 'bc', connectionId: a.id, bcId: '111' });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json.transactions.map((t) => t.id), ['B5', 'B1'], 'ADD_BALANCE e INCREASE_BALANCE da BC dentro de 90 dias');
      assert.deepEqual([res.json.kind, res.json.range, res.json.filter, res.json.page, res.json.pageSize, res.json.totalNumber, res.json.totalPages], ['bc', 90, 'deposits', 1, 20, 2, 1]);
      assert.deepEqual(res.json.transactions[1], { id: 'B1', type: 'ADD_BALANCE', amountType: 'POSITIVE', amount: 500, subtotal: 500, taxAmount: 0, currency: 'USD', billingType: 'CASH', timezone: 'UTC+00:00', createdAt: fake.state.transactions[111][0].create_time, accountId: null, invoiceSerial: null });
      const call = calls('/bc/account/transaction/get/');
      assert.equal(call.length, 1);
      assert.equal(call[0].query.transaction_level, 'BC');
      assert.equal(call[0].token, GOOD_TOKEN, 'usa o token da conexão');
      assert.deepEqual(JSON.parse(call[0].query.filtering).transaction_types, ['ADD_BALANCE', 'INCREASE_BALANCE']);
      assert.ok(!res.text.includes(GOOD_TOKEN) && !res.text.includes('access_token'));
    });

    it('períodos de 90 dias, 6 meses e 12 meses; "todas as movimentações" traz também pagamentos e reduções', async () => {
      const { user, a } = await twoBcs();
      const ids = async (extra) => (await history(user, { kind: 'bc', connectionId: a.id, bcId: '111', ...extra })).json.transactions.map((t) => t.id);
      assert.deepEqual(await ids({ range: '180' }), ['B5', 'B1', 'B2'], '100 dias atrás entra em 6 meses');
      assert.deepEqual(await ids({ range: '365' }), ['B5', 'B1', 'B2', 'B3'], '200 dias atrás só entra em 12 meses');
      assert.deepEqual(await ids({ filter: 'all', range: '90' }), ['B5', 'B4', 'B1'], 'com "todas": inclui o pagamento de fatura');
      assert.deepEqual(await ids({ filter: 'all', range: '365' }), ['B5', 'B4', 'B1', 'B2', 'B3']);
    });

    it('conta: nível ADVERTISER só com ESTA conta; a BC é descoberta no servidor (o cliente não escolhe)', async () => {
      const { user, a } = await twoBcs();
      fake.state.calls.length = 0;
      const res = await history(user, { kind: 'account', connectionId: a.id, advertiserId: '9001', range: '365', filter: 'all' });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json.transactions.map((t) => t.id), ['A1', 'A2', 'A4'], 'só as movimentações da conta 9001, não as da 9002 nem as da BC');
      assert.ok(res.json.transactions.every((t) => t.accountId === '9001'));
      const call = calls('/bc/account/transaction/get/')[0];
      assert.equal(call.query.bc_id, '111');
      assert.equal(call.query.transaction_level, 'ADVERTISER');
      assert.deepEqual(JSON.parse(call.query.filtering).account_ids, ['9001']);
      // mesmo que o cliente tente impor uma BC, ela é ignorada
      fake.state.calls.length = 0;
      await history(user, { kind: 'account', connectionId: a.id, advertiserId: '9001', bcId: '222' });
      assert.equal(calls('/bc/account/transaction/get/')[0].query.bc_id, '111');
    });

    it('pagina de 20 em 20 e informa o total', async () => {
      const { user, a } = await twoBcs();
      fake.state.transactions[111] = Array.from({ length: 45 }, (_, i) => tx(`P${String(i).padStart(2, '0')}`, 'ADD_BALANCE', i + 1, 1 + i * 0.01));
      const page = async (n) => (await history(user, { kind: 'bc', connectionId: a.id, bcId: '111', page: String(n) })).json;
      const [p1, p2, p3, p4] = [await page(1), await page(2), await page(3), await page(4)];
      assert.deepEqual([p1.transactions.length, p2.transactions.length, p3.transactions.length, p4.transactions.length], [20, 20, 5, 0]);
      assert.deepEqual([p1.totalNumber, p1.totalPages], [45, 3]);
      const all = [...p1.transactions, ...p2.transactions, ...p3.transactions].map((t) => t.id);
      assert.equal(new Set(all).size, 45, 'sem repetir nem perder');
    });

    it('mostra o que o servidor devolve, sem inventar: BC sem movimentações vem vazia', async () => {
      const { user, b } = await twoBcs();
      fake.state.transactions[222] = [];
      const res = await history(user, { kind: 'bc', connectionId: b.id, bcId: '222' });
      assert.deepEqual([res.status, res.json.transactions, res.json.totalNumber], [200, [], 0]);
    });

    it('valida os parâmetros (400) e nunca chega ao TikTok com valor inválido', async () => {
      const { user, a } = await twoBcs();
      fake.state.calls.length = 0;
      const base = { kind: 'bc', connectionId: a.id, bcId: '111' };
      for (const extra of [{ kind: 'x' }, { connectionId: 'abc' }, { bcId: "1' OR '1'='1" }, { range: '30' }, { filter: 'tudo' }, { page: '0' }, { page: '9999' }]) {
        const res = await history(user, { ...base, ...extra });
        assert.equal(res.status, 400, JSON.stringify(extra));
        assert.equal(res.json.error.code, 'validation_error');
      }
      assert.equal((await user.client.get(`/api/tiktok/balance/history?kind=bc&connectionId=${a.id}&bcId=111&bcId=222`)).status, 400, 'parâmetro repetido');
      assert.equal(calls('/bc/account/transaction/get/').length, 0);
    });

    it('conferência de dono: conexão de outra pessoa, BC que não é da conexão e conta de outra conexão são "não encontrado"', async () => {
      const { user, a, b } = await twoBcs();
      const stranger = await createUser(ctx, { approve: true, email: emailOf() });
      fake.state.calls.length = 0;
      assert.equal((await history(stranger, { kind: 'bc', connectionId: a.id, bcId: '111' })).status, 404, 'conexão de outra pessoa');
      await run(ctx.db, 'UPDATE tiktok_business_centers SET shared = true WHERE id = $1', [a.id]);
      assert.equal((await history(stranger, { kind: 'bc', connectionId: a.id, bcId: '111' })).status, 404, 'compartilhada com a equipe também não vale: dinheiro é só do dono');
      assert.equal((await history(user, { kind: 'bc', connectionId: a.id, bcId: '222' })).status, 404, 'BC que não pertence à conexão');
      assert.equal((await history(user, { kind: 'account', connectionId: a.id, advertiserId: '9101' })).status, 404, 'conta de OUTRA conexão do mesmo dono');
      assert.equal((await history(user, { kind: 'account', connectionId: b.id, advertiserId: '9001' })).status, 404);
      assert.equal((await history(user, { kind: 'account', connectionId: a.id, advertiserId: '999999' })).status, 404, 'conta desconhecida');
      assert.equal((await history(user, { kind: 'bc', connectionId: '999999', bcId: '111' })).status, 404);
      assert.equal(calls('/bc/account/transaction/get/').length, 0, 'nada disso chegou ao TikTok');
    });

    it('sem permissão financeira: explica o motivo; token revogado: manda renovar; conexão com erro: 409 sem consultar', async () => {
      const { user, a, b } = await twoBcs();
      fake.state.failTransactionsBc.add('111');
      const denied = await history(user, { kind: 'bc', connectionId: a.id, bcId: '111' });
      assert.equal(denied.status, 502, 'nunca 401/403 do TikTok: a tela trataria como sessão do sistema');
      assert.equal(denied.json.error.code, 'history_unavailable');
      assert.match(denied.json.error.message, /função financeira \(Finance Manager ou Analyst\)/);
      fake.state.validTokens.delete(OTHER_TOKEN);
      const revoked = await history(user, { kind: 'bc', connectionId: b.id, bcId: '222' });
      assert.equal(revoked.status, 502);
      assert.match(revoked.json.error.message, /Renove o acesso/);
      fake.state.calls.length = 0;
      const broken = await history(user, { kind: 'bc', connectionId: b.id, bcId: '222' });
      assert.equal(broken.status, 409);
      assert.equal(broken.json.error.code, 'tiktok_connection_error');
      assert.equal(calls('/bc/account/transaction/get/').length, 0);
    });

    it('cache curto: a mesma consulta seguida não repete a chamada; outra página ou filtro, sim', async () => {
      const { user, a } = await twoBcs();
      fake.state.calls.length = 0;
      const q = { kind: 'bc', connectionId: a.id, bcId: '111' };
      await history(user, q);
      await history(user, q);
      assert.equal(calls('/bc/account/transaction/get/').length, 1);
      await history(user, { ...q, filter: 'all' });
      await history(user, { ...q, range: '180' });
      assert.equal(calls('/bc/account/transaction/get/').length, 3);
    });

    it('limite de consultas por minuto (429) e exige login', async () => {
      const lim = await startTestServer({ limits: { ...LIMITS, balanceHistory: 2 }, config: tiktokTestConfig(), fetchFn: fake.fetchFn, isolated: true });
      try {
        const user = await createUser(lim, { approve: true, email: emailOf() });
        await setup(); // prepara o TikTok simulado (BCs, contas e transações)
        const created = await user.client.post('/api/tiktok/business-centers', { name: 'Conexão limite', bcId: '111', accessToken: GOOD_TOKEN });
        assert.equal(created.status, 201, created.text);
        const conn = created.json.businessCenter;
        const q = new URLSearchParams({ kind: 'bc', connectionId: String(conn.id), bcId: '111' });
        const statuses = [];
        for (let i = 0; i < 4; i += 1) statuses.push((await user.client.get(`/api/tiktok/balance/history?${q}`)).status);
        assert.deepEqual(statuses, [200, 200, 429, 429]);
        assert.equal((await lim.client().get(`/api/tiktok/balance/history?${q}`)).status, 401);
      } finally {
        await lim.stop();
      }
    });

    it('"Atualizar agora" refaz saldo e gasto: cada um tem o seu limite de atualizações forçadas (um não gasta o do outro)', async () => {
      const lim = await startTestServer({ limits: { ...LIMITS, balanceRefresh: 2 }, config: tiktokTestConfig(), fetchFn: fake.fetchFn, isolated: true });
      try {
        const user = await createUser(lim, { approve: true, email: emailOf() });
        await setup();
        assert.equal((await user.client.post('/api/tiktok/business-centers', { name: 'Conexão refresh', bcId: '111', accessToken: GOOD_TOKEN })).status, 201);
        const statuses = async (path) => { const out = []; for (let i = 0; i < 3; i += 1) out.push((await user.client.get(`${path}?refresh=1`)).status); return out; };
        assert.deepEqual(await statuses('/api/tiktok/balance'), [200, 200, 429]);
        assert.deepEqual(await statuses('/api/tiktok/balance/spend'), [200, 200, 429], 'o gasto tem limite próprio');
        assert.equal((await user.client.get('/api/tiktok/balance/spend')).status, 200, 'a consulta normal segue livre');
      } finally {
        await lim.stop();
      }
    });

    it('só leituras (GET) no TikTok e a lista de tipos do histórico cobre os 13 tipos da documentação', async () => {
      const { user, a } = await twoBcs();
      fake.state.calls.length = 0;
      await history(user, { kind: 'bc', connectionId: a.id, bcId: '111' });
      await spendOf(user);
      assert.ok(fake.state.calls.every((c) => c.method === 'GET'));
      assert.equal(Object.keys(TRANSACTION_TYPES).length, 13);
      assert.equal(HISTORY_RANGES.length, 3);
    });
  });
});
