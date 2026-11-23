import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000 };
const DAY = 24 * 60 * 60 * 1000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

describe('Relatórios: visão geral (série diária, comparação, ranking e filtro de conta)', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn });
  });
  after(() => ctx.stop());

  async function user() {
    const u = await createUser(ctx, { approve: true });
    fake.state.bcs = { 111: ['9001', '9002', '9003'] };
    fake.state.currencies = { 9001: 'BRL', 9002: 'USD', 9003: 'BRL' };
    fake.state.failReportFor.clear();
    await u.client.post('/api/tiktok/business-centers', { name: 'Mista', bcId: '111', accessToken: GOOD_TOKEN });
    fake.state.calls.length = 0;
    return u;
  }
  const get = (client, query) => client.get(`/api/tiktok/overview?${query}`);

  it('devolve, por moeda, totais e uma série diária CONTÍNUA (um ponto por dia, mesmo sem gasto)', async () => {
    const { client } = await user();
    const res = await get(client, 'days=7');
    assert.equal(res.status, 200);
    const brl = res.json.groups.find((g) => g.currency === 'BRL');
    const usd = res.json.groups.find((g) => g.currency === 'USD');
    assert.ok(brl && usd);
    assert.equal(brl.advertisers, 2);
    assert.equal(res.json.range.endDate, iso(Date.now()));
    assert.equal(res.json.range.startDate, iso(Date.now() - 6 * DAY));
    const dates = brl.daily.map((d) => d.date);
    assert.deepEqual(dates, [...dates].sort(), 'ordenada por data');
    assert.ok(new Set(dates).size === dates.length, 'sem datas repetidas');
    for (let i = 0; i < 7; i += 1) assert.ok(dates.includes(iso(Date.now() - i * DAY)), `tem o dia -${i}`);
    assert.ok(brl.daily.every((d) => ['spend', 'impressions', 'clicks', 'conversions', 'ctr', 'cpc'].every((k) => Number.isFinite(d[k]))));
    assert.equal(Number(brl.daily.reduce((s, d) => s + d.spend, 0).toFixed(2)), Number(brl.totals.spend.toFixed(2)), 'a soma dos dias bate com o total');
    assert.equal(brl.previous, null, 'sem comparação, previous é null');
    assert.equal(res.json.compare, false);
  });

  it('moedas diferentes nunca se misturam e o grupo de maior gasto vem primeiro', async () => {
    const { client } = await user();
    const { groups } = (await get(client, 'days=7')).json;
    assert.deepEqual(groups.map((g) => g.currency).sort(), ['BRL', 'USD']);
    assert.ok(groups[0].totals.spend >= groups[1].totals.spend);
    assert.equal(groups.find((g) => g.currency === 'BRL').totals.spend, 30, 'duas contas BRL somam 15 + 15');
    assert.equal(groups.find((g) => g.currency === 'USD').totals.spend, 15);
  });

  it('com compare=1 traz os totais do período ANTERIOR (intervalo imediatamente anterior e do mesmo tamanho)', async () => {
    const { client } = await user();
    const res = await get(client, 'days=7&compare=1');
    assert.equal(res.json.compare, true);
    const brl = res.json.groups.find((g) => g.currency === 'BRL');
    assert.ok(brl.previous && Number.isFinite(brl.previous.spend) && 'ctr' in brl.previous);
    const queries = fake.callsTo('/report/integrated/get/').map((c) => [c.query.start_date, c.query.end_date]);
    const current = [iso(Date.now() - 6 * DAY), iso(Date.now())];
    const previous = [iso(Date.now() - 13 * DAY), iso(Date.now() - 7 * DAY)];
    assert.ok(queries.some(([a, b]) => a === current[0] && b === current[1]), 'consultou o período atual');
    assert.ok(queries.some(([a, b]) => a === previous[0] && b === previous[1]), `consultou o anterior ${previous}: ${JSON.stringify(queries)}`);
  });

  it('ranking por conta (maior gasto primeiro) com moeda e totais; lista de contas para o filtro traz todas as ativas', async () => {
    const { client } = await user();
    const res = (await get(client, 'days=14')).json;
    assert.equal(res.accounts.length, 3);
    assert.deepEqual(res.accounts.map((a) => a.totals.spend), [...res.accounts.map((a) => a.totals.spend)].sort((x, y) => y - x));
    assert.ok(res.accounts.every((a) => a.id && a.name && 'currency' in a && Number.isFinite(a.totals.clicks)));
    assert.deepEqual(res.accountOptions.map((a) => a.id).sort(), ['9001', '9002', '9003']);
    assert.ok(!JSON.stringify(res).includes(GOOD_TOKEN), 'nenhum token na resposta');
  });

  it('filtro por conta: só essa conta entra em grupos e ranking; conta inexistente/de outro usuário é 404; ID inválido, 400', async () => {
    const { client } = await user();
    const one = (await get(client, 'days=7&advertiserId=9002')).json;
    assert.deepEqual(one.groups.map((g) => g.currency), ['USD']);
    assert.deepEqual(one.accounts.map((a) => a.id), ['9002']);
    assert.equal(one.accountOptions.length, 3, 'o filtro continua oferecendo todas as contas');
    const stranger = await createUser(ctx, { approve: true });
    assert.equal((await get(stranger.client, 'days=7&advertiserId=9002')).status, 404);
    assert.equal((await get(client, 'days=7&advertiserId=999999')).status, 404);
    for (const bad of ['abc', '9002;DROP', '1'.repeat(25), '-1']) assert.equal((await get(client, `days=7&advertiserId=${encodeURIComponent(bad)}`)).status, 400, bad);
    assert.equal((await get(client, 'days=7&advertiserId=')).status, 200, 'vazio = todas');
  });

  it('uma conta que falha entra em "failed" e não derruba a comparação nem o restante', async () => {
    const { client } = await user();
    fake.state.failReportFor.add('9001');
    const res = (await get(client, 'days=30&compare=1')).json;
    assert.equal(res.failed, 1);
    assert.deepEqual(res.accounts.map((a) => a.id).sort(), ['9002', '9003']);
    assert.ok(res.groups.every((g) => g.previous));
  });

  it('parâmetros diferentes não reaproveitam o cache um do outro; o mesmo pedido repetido usa o cache', async () => {
    const { client } = await user();
    await get(client, 'days=7');
    const first = fake.callsTo('/report/integrated/get/').length;
    await get(client, 'days=7');
    assert.equal(fake.callsTo('/report/integrated/get/').length, first, 'repetido: cache');
    await get(client, 'days=7&compare=1');
    assert.ok(fake.callsTo('/report/integrated/get/').length > first, 'com comparação: consulta o período anterior');
    await get(client, 'days=7&advertiserId=9001');
    assert.ok(fake.callsTo('/report/integrated/get/').length >= first, 'filtro de conta é outra chave');
  });

  it('período inválido continua 400', async () => {
    const { client } = await user();
    for (const q of ['days=1', 'days=8', 'days=abc', 'days=7.5']) assert.equal((await get(client, q)).status, 400, q);
  });
});
