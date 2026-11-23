import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { localParts, previousDate, safeTimeZone, zonedToUtc } from '../src/lib/timezone.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, one, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, hourlyRefresh: 3, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `hr${++counter}@example.com`;
const m = (spend, extra = {}) => ({ spend, impressions: spend * 100, clicks: spend * 3, conversion: 1, ...extra });

describe('Fuso horário (Intl, sem biblioteca)', () => {
  it('converte a hora local da conta para UTC, inclusive horário de verão e fusos de meia hora', () => {
    assert.equal(zonedToUtc('2026-11-23 14:00:00', 'America/Sao_Paulo').toISOString(), '2026-11-23T17:00:00.000Z');
    assert.equal(zonedToUtc('2026-11-23 14:00:00', 'America/New_York').toISOString(), '2026-11-23T19:00:00.000Z', 'inverno: UTC-5');
    assert.equal(zonedToUtc('2026-07-01 14:00:00', 'America/New_York').toISOString(), '2026-07-01T18:00:00.000Z', 'verão: UTC-4');
    assert.equal(zonedToUtc('2026-11-23 14:00:00', 'Asia/Kolkata').toISOString(), '2026-11-23T08:30:00.000Z', 'UTC+5:30');
    assert.equal(zonedToUtc('2026-11-23 00:00:00', 'UTC').toISOString(), '2026-11-23T00:00:00.000Z');
  });
  it('texto fora do formato vira null e fuso inválido vira UTC', () => {
    for (const bad of ['', null, 'ontem', '2026-13-45 99:99:99x', '23/11/2026 14:00']) assert.equal(zonedToUtc(bad, 'UTC'), null);
    assert.equal(safeTimeZone('Marte/Olimpo'), 'UTC');
    assert.equal(zonedToUtc('2026-11-23 14:00:00', 'Marte/Olimpo').toISOString(), '2026-11-23T14:00:00.000Z');
  });
  it('data e hora locais de um instante; data anterior', () => {
    assert.deepEqual(localParts(new Date('2026-11-23T02:30:00Z'), 'America/Sao_Paulo'), { date: '2026-11-22', hour: 23 });
    assert.deepEqual(localParts(new Date('2026-11-23T17:20:00Z'), 'America/Sao_Paulo'), { date: '2026-11-23', hour: 14 });
    assert.equal(previousDate('2026-03-01'), '2026-02-28');
    assert.equal(previousDate('2026-01-01', 2), '2025-12-30');
  });
});

describe('Gasto por hora: coleta a cada 30 minutos e leitura', () => {
  let ctx;
  let fake;
  let mailer;
  let nowMs;
  const setNow = (iso) => { nowMs = Date.parse(iso); };
  before(async () => {
    fake = createFakeTiktok();
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer, clock: () => new Date(nowMs) });
  });
  after(() => ctx.stop());

  async function setup() {
    await run(ctx.db, 'DELETE FROM tiktok_hourly_spend');
    await run(ctx.db, 'DELETE FROM tiktok_business_centers');
    ctx.hourly.stop();
    setNow('2026-11-23T17:20:00Z'); // 14h20 em São Paulo
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9101'] };
    fake.state.currencies = { 9001: 'BRL', 9002: 'USD', 9101: 'BRL' };
    fake.state.validTokens.add(GOOD_TOKEN);
    fake.state.validTokens.add(OTHER_TOKEN);
    fake.state.hourly = {};
    fake.state.failHourlyFor = new Set();
    fake.state.hourlyDelayMs = 0;
    fake.state.calls.length = 0;
    return createUser(ctx, { approve: true, email: emailOf() });
  }
  const connect = async (user, bcId = '111', token = GOOD_TOKEN) => (await user.client.post('/api/tiktok/business-centers', { name: `BC ${bcId}`, bcId, accessToken: token })).json.businessCenter;
  const hourlyCalls = () => fake.state.calls.filter((c) => c.path === '/report/integrated/get/' && String(c.query.dimensions).includes('stat_time_hour'));
  const rowsOf = (advertiser) => all(ctx.db, 'SELECT hour_start, currency, spend::float AS spend, impressions::int AS impressions, clicks::int AS clicks FROM tiktok_hourly_spend WHERE advertiser_id = $1 ORDER BY hour_start', [advertiser]);

  it('primeira coleta de uma conta: hoje + 2 dias anteriores, com a hora convertida para UTC', async () => {
    const user = await setup();
    await connect(user);
    fake.state.hourly = { 9001: { '2026-11-23': { 13: m(5.5), 14: m(2) }, '2026-11-22': { 20: m(7) } } };
    fake.state.calls.length = 0;
    const summary = await ctx.hourly.collectAll();
    assert.deepEqual({ connections: summary.connections, advertisers: summary.advertisers, failed: summary.failed, rows: summary.rows }, { connections: 1, advertisers: 2, failed: 0, rows: 3 });
    const calls = hourlyCalls();
    assert.equal(calls.length, 6, '2 contas × 3 dias');
    assert.deepEqual([...new Set(calls.map((c) => c.query.start_date))].sort(), ['2026-11-21', '2026-11-22', '2026-11-23']);
    for (const c of calls) {
      assert.equal(c.query.start_date, c.query.end_date, 'só 1 dia por consulta (limite do TikTok para a dimensão hora)');
      assert.equal(c.token, GOOD_TOKEN);
      assert.equal(c.query.data_level, 'AUCTION_ADVERTISER');
    }
    const rows = await rowsOf('9001');
    assert.deepEqual(rows.map((r) => [r.hour_start.toISOString(), r.spend, r.currency]), [
      ['2026-11-22T23:00:00.000Z', 7, 'BRL'], // 20h em São Paulo
      ['2026-11-23T16:00:00.000Z', 5.5, 'BRL'],
      ['2026-11-23T17:00:00.000Z', 2, 'BRL'],
    ]);
    assert.equal(rows[1].impressions, 550);
  });

  it('coletas seguintes pedem só o dia de hoje e REGRAVAM a hora atual (sem duplicar linhas)', async () => {
    const user = await setup();
    await connect(user);
    fake.state.hourly = { 9001: { '2026-11-23': { 14: m(2) } } };
    await ctx.hourly.collectAll();
    fake.state.calls.length = 0;
    setNow('2026-11-23T17:50:00Z'); // 30 minutos depois: a hora 14h já gastou mais
    fake.state.hourly = { 9001: { '2026-11-23': { 14: m(3.5) } } };
    await ctx.hourly.collectAll();
    assert.equal(hourlyCalls().length, 2, '1 dia × 2 contas');
    assert.deepEqual(new Set(hourlyCalls().map((c) => c.query.start_date)), new Set(['2026-11-23']));
    const rows = await rowsOf('9001');
    assert.equal(rows.length, 1, 'a mesma hora continua sendo UMA linha');
    assert.equal(rows[0].spend, 3.5, 'o valor mais novo vence');
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_hourly_spend WHERE advertiser_id = $1', ['9001'])).c, 1);
  });

  it('logo depois da meia-noite (hora da conta) também reconfere o dia anterior', async () => {
    const user = await setup();
    await connect(user);
    fake.state.hourly = { 9001: { '2026-11-23': { 22: m(1) } } };
    await ctx.hourly.collectAll();
    fake.state.calls.length = 0;
    setNow('2026-11-24T04:10:00Z'); // 01h10 em São Paulo do dia 24
    fake.state.hourly = { 9001: { '2026-11-23': { 22: m(1), 23: m(4) }, '2026-11-24': {} } };
    await ctx.hourly.collectAll();
    assert.deepEqual([...new Set(hourlyCalls().map((c) => c.query.start_date))].sort(), ['2026-11-23', '2026-11-24']);
    assert.equal((await rowsOf('9001')).length, 2, 'a hora que fechou tarde (23h) foi recuperada');
  });

  it('descarta horas "do futuro" e dados fora do formato', async () => {
    const user = await setup();
    await connect(user);
    fake.state.hourly = { 9001: { '2026-11-23': { 14: m(2), 23: m(9) } } }; // 23h local = 02h UTC do dia seguinte: depois de agora + 2 h
    await ctx.hourly.collectAll();
    const rows = await rowsOf('9001');
    assert.deepEqual(rows.map((r) => r.hour_start.toISOString()), ['2026-11-23T17:00:00.000Z']);
  });

  it('falha de uma conta não impede as outras; as demais seguem sendo gravadas', async () => {
    const user = await setup();
    await connect(user);
    fake.state.hourly = { 9001: { '2026-11-23': { 14: m(2) } }, 9002: { '2026-11-23': { 14: m(8) } } };
    fake.state.failHourlyFor = new Set(['9002']);
    const summary = await ctx.hourly.collectAll();
    assert.equal(summary.failed, 1);
    assert.equal((await rowsOf('9001')).length, 1);
    assert.equal((await rowsOf('9002')).length, 0);
    fake.state.failHourlyFor = new Set();
    await ctx.hourly.collectAll();
    assert.equal((await rowsOf('9002')).length, 1, 'no ciclo seguinte a conta se recupera sozinha');
  });

  it('token revogado: a coleta não quebra, a conexão é marcada com erro e deixa de ser consultada', async () => {
    const user = await setup();
    await connect(user);
    fake.state.validTokens.delete(GOOD_TOKEN);
    const summary = await ctx.hourly.collectAll();
    assert.equal(summary.error, undefined);
    assert.equal((await user.client.get('/api/tiktok/business-centers')).json.businessCenters[0].status, 'error');
    fake.state.calls.length = 0;
    await ctx.hourly.collectAll();
    assert.equal(hourlyCalls().length, 0, 'conexão com erro não é consultada');
  });

  it('apaga o que passou de 90 dias e mantém o recente', async () => {
    const user = await setup();
    const bc = await connect(user);
    await run(ctx.db, "INSERT INTO tiktok_hourly_spend (business_center_id, advertiser_id, hour_start, spend) VALUES ($1, '9001', now() - interval '120 days', 1), ($1, '9001', now() - interval '10 days', 2)", [bc.id]);
    await ctx.hourly.collectAll();
    const rows = await all(ctx.db, 'SELECT spend::float AS spend FROM tiktok_hourly_spend WHERE advertiser_id = $1', ['9001']);
    assert.deepEqual(rows.map((r) => r.spend), [2]);
  });

  it('remover a conexão apaga o histórico dela (cascata)', async () => {
    const user = await setup();
    const bc = await connect(user);
    fake.state.hourly = { 9001: { '2026-11-23': { 14: m(2) } } };
    await ctx.hourly.collectAll();
    assert.equal((await rowsOf('9001')).length, 1);
    assert.equal((await user.client.delete(`/api/tiktok/business-centers/${bc.id}`)).status, 204);
    assert.equal((await rowsOf('9001')).length, 0);
  });

  it('o banco recusa valores inválidos (ID não numérico, gasto negativo, moeda fora do padrão)', async () => {
    const user = await setup();
    const bc = await connect(user);
    const insert = (id, spend, currency) => run(ctx.db, 'INSERT INTO tiktok_hourly_spend (business_center_id, advertiser_id, hour_start, spend, currency) VALUES ($1, $2, now(), $3, $4)', [bc.id, id, spend, currency]);
    await assert.rejects(insert('abc', 1, 'BRL'), (e) => e.code === '23514');
    await assert.rejects(insert('9001', -1, 'BRL'), (e) => e.code === '23514');
    await assert.rejects(insert('9001', 1, 'real'), (e) => e.code === '23514');
    await insert('9001', 1, null);
  });

  describe('leitura (GET /api/tiktok/hourly)', () => {
    it('devolve a série contínua por hora; a série começa na primeira hora coletada (sem zeros falsos antes)', async () => {
      const user = await setup();
      await connect(user);
      fake.state.hourly = { 9001: { '2026-11-23': { 13: m(5.5), 14: m(2) } } };
      await ctx.hourly.collectAll();
      const res = await user.client.get('/api/tiktok/hourly?hours=24');
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.hours, 24);
      assert.equal(res.json.from, '2026-11-23T16:00:00.000Z', 'primeira hora com dado');
      assert.equal(res.json.to, '2026-11-23T17:00:00.000Z', 'hora atual');
      assert.equal(res.json.everyMinutes, 30);
      assert.ok(res.json.lastCollectedAt);
      const brl = res.json.groups.find((g) => g.currency === 'BRL');
      assert.deepEqual(brl.points.map((p) => [p.hour, p.spend]), [['2026-11-23T16:00:00.000Z', 5.5], ['2026-11-23T17:00:00.000Z', 2]]);
      assert.equal(brl.totals.spend, 7.5);
      assert.deepEqual(brl.peak, { hour: '2026-11-23T16:00:00.000Z', spend: 5.5 });
      assert.equal(brl.activeHours, 2);
    });

    it('horas sem gasto no meio do período aparecem como zero; o período limita a janela', async () => {
      const user = await setup();
      await connect(user);
      fake.state.hourly = { 9001: { '2026-11-23': { 8: m(1), 14: m(2) } } };
      await ctx.hourly.collectAll();
      const brl = (await user.client.get('/api/tiktok/hourly?hours=24')).json.groups.find((g) => g.currency === 'BRL');
      assert.equal(brl.points.length, 7, 'de 8h a 14h, uma linha por hora');
      assert.deepEqual(brl.points.map((p) => p.spend), [1, 0, 0, 0, 0, 0, 2]);
      assert.equal(brl.hoursCovered, 7);
    });

    it('moedas diferentes ficam em grupos separados (nunca somadas); filtro por conta', async () => {
      const user = await setup();
      await connect(user);
      fake.state.hourly = { 9001: { '2026-11-23': { 14: m(2) } }, 9002: { '2026-11-23': { 14: m(10) } } };
      await ctx.hourly.collectAll();
      const all2 = (await user.client.get('/api/tiktok/hourly?hours=24')).json;
      assert.deepEqual(all2.groups.map((g) => [g.currency, g.totals.spend]), [['USD', 10], ['BRL', 2]]);
      assert.equal(all2.accountOptions.length, 2);
      const one2 = (await user.client.get('/api/tiktok/hourly?hours=48&advertiserId=9002')).json;
      assert.deepEqual(one2.groups.map((g) => [g.currency, g.totals.spend]), [['USD', 10]]);
    });

    it('valida os parâmetros e as contas', async () => {
      const user = await setup();
      await connect(user);
      for (const bad of ['hours=5', 'hours=abc', 'hours=24&advertiserId=abc']) assert.equal((await user.client.get(`/api/tiktok/hourly?${bad}`)).status, 400, bad);
      assert.equal((await user.client.get('/api/tiktok/hourly?hours=24&advertiserId=999999')).status, 404, 'conta que não é do usuário');
      assert.equal((await user.client.get('/api/tiktok/hourly')).status, 200, 'padrão: 24 horas');
    });

    it('sem dados ainda: lista vazia (e a tela mostra como começar)', async () => {
      const user = await setup();
      await connect(user);
      const res = await user.client.get('/api/tiktok/hourly?hours=24');
      assert.deepEqual({ groups: res.json.groups, since: res.json.collectedSince, last: res.json.lastCollectedAt, advertisers: res.json.totalAdvertisers }, { groups: [], since: null, last: null, advertisers: 2 });
    });

    it('isolamento: cada usuário vê só as próprias contas', async () => {
      const a = await setup();
      await connect(a);
      const b = await createUser(ctx, { approve: true, email: emailOf() });
      await connect(b, '222', OTHER_TOKEN);
      fake.state.hourly = { 9001: { '2026-11-23': { 14: m(2) } }, 9101: { '2026-11-23': { 14: m(40) } } };
      await ctx.hourly.collectAll();
      assert.equal((await a.client.get('/api/tiktok/hourly?hours=24')).json.groups[0].totals.spend, 2);
      assert.equal((await b.client.get('/api/tiktok/hourly?hours=24')).json.groups[0].totals.spend, 40);
      assert.equal((await a.client.get('/api/tiktok/hourly?hours=24&advertiserId=9101')).status, 404, 'conta do outro usuário: 404');
    });

    it('a mesma conta em uma conexão própria e em uma compartilhada não é somada duas vezes', async () => {
      const a = await setup();
      await connect(a);
      const b = await createUser(ctx, { approve: true, email: emailOf() });
      const shared = await connect(b, '111', OTHER_TOKEN);
      await run(ctx.db, 'UPDATE tiktok_business_centers SET shared = true WHERE id = $1', [shared.id]);
      fake.state.hourly = { 9001: { '2026-11-23': { 14: m(2) } } };
      await ctx.hourly.collectAll();
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_hourly_spend WHERE advertiser_id = $1', ['9001'])).c, 2, 'duas conexões coletaram a mesma conta');
      assert.equal((await a.client.get('/api/tiktok/hourly?hours=24')).json.groups.find((g) => g.currency === 'BRL').totals.spend, 2);
    });

    it('exige login e, para colaborador, a área "Relatórios"', async () => {
      const owner = await setup();
      await connect(owner);
      fake.state.hourly = { 9001: { '2026-11-23': { 14: m(2) } } };
      await ctx.hourly.collectAll();
      assert.equal((await ctx.client().get('/api/tiktok/hourly')).status, 401);
      async function collaborator(areas) {
        const email = emailOf();
        assert.equal((await owner.client.post('/api/team/invites', { email, name: 'Maria Colab', areas })).status, 201);
        const client = ctx.client();
        const accepted = await client.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
        client.csrf = accepted.json.csrfToken;
        return client;
      }
      const campaigns = await collaborator(['campaigns']);
      assert.equal((await campaigns.get('/api/tiktok/hourly')).status, 403);
      assert.equal((await campaigns.post('/api/tiktok/hourly/refresh', {})).status, 403);
      const reports = await collaborator(['reports']);
      const res = await reports.get('/api/tiktok/hourly?hours=24');
      assert.equal(res.status, 200);
      assert.equal(res.json.groups[0].totals.spend, 2 + 0, 'o colaborador vê os dados do dono do espaço');
    });
  });

  describe('"Atualizar agora" (POST /api/tiktok/hourly/refresh)', () => {
    it('coleta só as conexões do próprio usuário e devolve o resumo', async () => {
      const a = await setup();
      await connect(a);
      const b = await createUser(ctx, { approve: true, email: emailOf() });
      await connect(b, '222', OTHER_TOKEN);
      fake.state.hourly = { 9001: { '2026-11-23': { 14: m(2) } }, 9101: { '2026-11-23': { 14: m(40) } } };
      fake.state.calls.length = 0;
      const res = await a.client.post('/api/tiktok/hourly/refresh', {});
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { connections: 1, advertisers: 2, rows: 1, failed: 0 });
      assert.ok(hourlyCalls().every((c) => c.token === GOOD_TOKEN), 'nada foi consultado com o token do outro usuário');
      assert.equal((await rowsOf('9101')).length, 0);
      assert.equal((await a.client.get('/api/tiktok/hourly?hours=24')).json.groups[0].totals.spend, 2, 'já aparece na leitura');
    });

    it('uma coleta em andamento recusa outra (409) e depois libera', async () => {
      const a = await setup();
      await connect(a);
      fake.state.hourly = { 9001: { '2026-11-23': { 14: m(2) } } };
      fake.state.hourlyDelayMs = 200;
      const [first, second] = await Promise.all([a.client.post('/api/tiktok/hourly/refresh', {}), (async () => { await new Promise((r) => setTimeout(r, 60)); return a.client.post('/api/tiktok/hourly/refresh', {}); })()]);
      assert.deepEqual([first.status, second.status], [200, 409]);
      assert.equal(second.json.error.code, 'collect_in_progress');
      fake.state.hourlyDelayMs = 0;
      assert.equal((await a.client.post('/api/tiktok/hourly/refresh', {})).status, 200);
    });

    it('limita a poucas atualizações por 5 minutos (429)', async () => {
      const a = await setup();
      await connect(a);
      const statuses = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await a.client.post('/api/tiktok/hourly/refresh', {})).status);
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    });

    it('sem conexões: nada a coletar, sem erro', async () => {
      const a = await setup();
      const res = await a.client.post('/api/tiktok/hourly/refresh', {});
      assert.deepEqual(res.json, { connections: 0, advertisers: 0, rows: 0, failed: 0 });
    });
  });

  it('start/stop do agendador são seguros (ligar duas vezes e desligar sem estar ligado)', () => {
    ctx.hourly.stop();
    ctx.hourly.start();
    ctx.hourly.start();
    ctx.hourly.stop();
    ctx.hourly.stop();
  });
});
