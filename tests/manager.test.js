import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AD_STATUSES, adStatusInfo, isAdProblem } from '../shared/ad-status.js';
import { MANAGER_COLUMNS, MAX_VIEWS_PER_USER, defaultViewConfig, normalizeViewConfig } from '../shared/manager-columns.js';
import { parseDate, rangeDays, resolveRange } from '../src/lib/date-range.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, one, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, managerRead: 5000, managerRefresh: 5000, managerWrite: 5000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `mg${++counter}@example.com`;
const ad = (id, extra = {}) => ({ ad_id: String(id), ad_name: `Anúncio ${id}`, advertiser_id: '9001', campaign_id: '5001', campaign_name: 'Campanha A', adgroup_id: '6001', adgroup_name: 'Grupo A', operation_status: 'ENABLE', secondary_status: 'AD_STATUS_DELIVERY_OK', create_time: '2026-11-20 13:45:10', modify_time: '2026-11-22 08:00:00', ...extra });
const metrics = (spend, extra = {}) => ({ spend, impressions: spend * 100, clicks: spend * 4, ctr: 4, cpc: 0.25, result: 3, cost_per_result: spend / 3, conversion: 2, cost_per_conversion: spend / 2, ...extra });

describe('Gerenciador: visualizações e períodos (regras compartilhadas)', () => {
  it('a visualização padrão é válida e mostra as colunas pedidas (anúncio, status, ativo, publicado, resultado, gasto, CPC, cliques, CTR)', () => {
    const config = defaultViewConfig();
    assert.deepEqual(normalizeViewConfig(config), config);
    assert.deepEqual(config.columns.filter((c) => c.visible).map((c) => c.key), ['name', 'status', 'toggle', 'objective', 'goal', 'budget', 'createdAt', 'result', 'spend', 'cpc', 'clicks', 'ctr']); // objetivo, meta e orçamento só existem em campanhas/grupos
    assert.equal(config.datePreset, 'today', 'o padrão é HOJE');
    assert.equal(MANAGER_COLUMNS.length, config.columns.length);
  });

  it('normaliza: completa colunas que faltam (ocultas, no fim), descarta campos desconhecidos e mantém a ordem escolhida', () => {
    const config = normalizeViewConfig({ columns: [{ key: 'spend', visible: true }, { key: 'name', visible: true }, { key: 'status', visible: false }], sort: { key: 'clicks', dir: 'asc' }, filters: { status: 'active', accountId: '9001', onlySpent: true, hack: 1 }, datePreset: 'last7', pageSize: 50, extra: 'x' });
    assert.deepEqual(config.columns.slice(0, 3), [{ key: 'spend', visible: true }, { key: 'name', visible: true }, { key: 'status', visible: false }]);
    assert.equal(config.columns.length, MANAGER_COLUMNS.length);
    assert.ok(config.columns.slice(3).every((c) => c.visible === (['objective', 'goal', 'budget'].includes(c.key))), 'as que faltam ficam ocultas, menos as exclusivas de campanhas/grupos (a visualização antiga só tinha anúncios)');
    assert.deepEqual(Object.keys(config).sort(), ['columns', 'datePreset', 'filters', 'pageSize', 'sort']);
    assert.deepEqual(Object.keys(config.filters).sort(), ['accountId', 'onlySpent', 'status']);
  });

  it('recusa configuração inválida (coluna desconhecida/repetida, sem o nome do anúncio visível, ordenação, filtros, período, tamanho)', () => {
    const ok = defaultViewConfig();
    const bad = [
      null, [], 'x', {}, { ...ok, columns: [] }, { ...ok, columns: 'x' },
      { ...ok, columns: [{ key: 'hack', visible: true }] }, { ...ok, columns: [{ key: 'name', visible: true }, { key: 'name', visible: true }] },
      { ...ok, columns: [{ key: 'name', visible: 'sim' }] }, { ...ok, columns: [{ key: 'spend', visible: true }] }, { ...ok, columns: ok.columns.map((c) => (c.key === 'name' ? { ...c, visible: false } : c)) },
      { ...ok, columns: [...ok.columns, { key: 'extra', visible: true }] },
      { ...ok, sort: { key: 'toggleX', dir: 'asc' } }, { ...ok, sort: { key: 'spend', dir: 'up' } }, { ...ok, sort: null },
      { ...ok, filters: { status: 'hack', accountId: '', onlySpent: false } }, { ...ok, filters: { status: '', accountId: 'abc', onlySpent: false } }, { ...ok, filters: { status: '', accountId: '', onlySpent: 'x' } },
      { ...ok, datePreset: 'custom' }, { ...ok, datePreset: 'amanhã' }, { ...ok, pageSize: 7 }, { ...ok, pageSize: '100' },
    ];
    for (const config of bad) assert.equal(normalizeViewConfig(config), null, JSON.stringify(config)?.slice(0, 70));
  });

  it('períodos: "hoje" é o hoje de CADA conta (fuso), e os demais são calculados a partir dele', () => {
    const now = new Date('2026-11-24T02:30:00Z'); // 23h30 do dia 23 em São Paulo; 21h30 do dia 23 em UTC-5; já é dia 24 em UTC e Auckland
    assert.deepEqual(resolveRange('today', { timeZone: 'America/Sao_Paulo', now }), { from: '2026-11-23', to: '2026-11-23' });
    assert.deepEqual(resolveRange('today', { timeZone: 'Etc/GMT+5', now }), { from: '2026-11-23', to: '2026-11-23' });
    assert.deepEqual(resolveRange('today', { timeZone: 'Pacific/Auckland', now }), { from: '2026-11-24', to: '2026-11-24' });
    assert.deepEqual(resolveRange('today', { timeZone: null, now }), { from: '2026-11-24', to: '2026-11-24' }, 'sem fuso: UTC');
    assert.deepEqual(resolveRange('yesterday', { timeZone: 'America/Sao_Paulo', now }), { from: '2026-11-22', to: '2026-11-22' });
    assert.deepEqual(resolveRange('last7', { timeZone: 'America/Sao_Paulo', now }), { from: '2026-11-17', to: '2026-11-23' });
    assert.deepEqual(resolveRange('last30', { timeZone: 'America/Sao_Paulo', now }), { from: '2026-10-25', to: '2026-11-23' });
    assert.deepEqual(resolveRange('thisMonth', { timeZone: 'America/Sao_Paulo', now }), { from: '2026-11-01', to: '2026-11-23' });
    assert.deepEqual(resolveRange('lastMonth', { timeZone: 'America/Sao_Paulo', now }), { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(resolveRange('lastMonth', { timeZone: 'UTC', now: new Date('2026-01-05T10:00:00Z') }), { from: '2025-12-01', to: '2025-12-31' }, 'vira o ano');
    assert.equal(resolveRange('amanhã', { now }), null);
  });

  it('período personalizado: datas reais, em ordem; contagem de dias', () => {
    assert.deepEqual(resolveRange('custom', { from: '2026-11-01', to: '2026-11-15' }), { from: '2026-11-01', to: '2026-11-15' });
    for (const [from, to] of [['2026-02-30', '2026-03-01'], ['2026-11-15', '2026-11-01'], ['11/01/2026', '2026-11-02'], ['', ''], [null, '2026-11-01'], ['2026-1-1', '2026-11-01']]) assert.equal(resolveRange('custom', { from, to }), null, `${from} → ${to}`);
    assert.equal(parseDate('2028-02-29'), '2028-02-29');
    assert.equal(parseDate('2026-02-29'), null);
    assert.equal(rangeDays('2026-11-01', '2026-11-01'), 1);
    assert.equal(rangeDays('2026-11-01', '2026-11-30'), 30);
  });
});

describe('Gerenciador: rótulos de status do anúncio', () => {
  it('status sem o prefixo AD_STATUS_ (ex.: conta penalizada) saem em português, nunca crus', () => {
    assert.equal(adStatusInfo('ADVERTISER_ACCOUNT_PUNISH').label, 'Conta penalizada pelo TikTok');
    assert.equal(adStatusInfo('ADVERTISER_ACCOUNT_PUNISH').tone, 'danger');
    assert.equal(isAdProblem('ADVERTISER_ACCOUNT_PUNISH'), true);
    assert.equal(adStatusInfo('ADVERTISER_CONTRACT_PENDING').tone, 'warning');
    assert.equal(adStatusInfo('ADGROUP_STATUS_FROZEN').label, 'Grupo congelado');
  });

  it('estados de exclusão aparecem como excluído e não contam como problema', () => {
    for (const key of ['AD_STATUS_DELETE', 'AD_STATUS_CAMPAIGN_DELETE', 'AD_STATUS_ADGROUP_DELETE', 'ADGROUP_STATUS_DELETE', 'CAMPAIGN_STATUS_DELETE']) {
      assert.match(adStatusInfo(key).label, /exclu[ií]d/i, key);
      assert.equal(adStatusInfo(key).tone, 'neutral', key);
      assert.equal(isAdProblem(key), false, key);
    }
  });

  it('valor desconhecido é humanizado sem o prefixo e todo rótulo tem tom válido', () => {
    assert.equal(adStatusInfo('ADVERTISER_SOMETHING_NEW').label, 'Something new');
    assert.equal(adStatusInfo('AD_STATUS_BRAND_NEW').label, 'Brand new');
    assert.equal(adStatusInfo(null).label, 'Sem status');
    for (const [key, info] of Object.entries(AD_STATUSES)) {
      assert.ok(info.label.length > 0 && !/^[A-Z_]+$/.test(info.label), key);
      assert.ok(['success', 'neutral', 'warning', 'danger'].includes(info.tone), key);
    }
  });
});

describe('Gerenciador de anúncios', () => {
  let ctx;
  let fake;
  let mailer;
  let nowMs;
  before(async () => {
    fake = createFakeTiktok();
    mailer = createFakeMailer();
    nowMs = Date.parse('2026-11-23T17:20:00Z');
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer, clock: () => new Date(nowMs) });
  });
  after(() => ctx.stop());

  async function setup() {
    nowMs = Date.parse('2026-11-23T17:20:00Z'); // 14h20 em São Paulo
    await run(ctx.db, 'DELETE FROM manager_views');
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9101'] };
    fake.state.currencies = { 9001: 'USD', 9002: 'BRL', 9101: 'BRL' };
    fake.state.validTokens.add(GOOD_TOKEN);
    fake.state.validTokens.add(OTHER_TOKEN);
    fake.state.failAdsFor = new Set();
    fake.state.rateLimitFor = new Set();
    fake.state.failAdStatusFor = new Set();
    fake.state.failReportFor = new Set();
    fake.state.rejectResultMetric = false;
    fake.state.campaigns = {};
    fake.state.adgroups = {};
    fake.state.failCampaignsFor = new Set();
    fake.state.failAdgroupsFor = new Set();
    fake.state.failCampaignStatusFor = new Set();
    fake.state.failAdgroupStatusFor = new Set();
    fake.state.ads = {
      9001: [ad(1001), ad(1002, { ad_name: 'Pausado', operation_status: 'DISABLE', secondary_status: 'AD_STATUS_DISABLE' }), ad(1003, { ad_name: 'Sem gasto hoje' }), ad(1004, { ad_name: 'Excluído', operation_status: 'DELETE', secondary_status: 'AD_STATUS_DELETE' })],
      9002: [ad(2001, { advertiser_id: '9002', ad_name: 'Da conta em reais', campaign_name: 'Campanha B' })],
      9101: [],
    };
    fake.state.adMetrics = { 9001: { 1001: metrics(10), 1002: metrics(4) }, 9002: { 2001: metrics(30) } };
    fake.state.adMetricsByDate = {};
    fake.state.calls.length = 0;
    return createUser(ctx, { approve: true, email: emailOf() });
  }
  const connect = (user, bcId = '111', token = GOOD_TOKEN) => user.client.post('/api/tiktok/business-centers', { name: `BC ${bcId}`, bcId, accessToken: token });
  const get = (user, query = '') => user.client.get(`/api/tiktok/manager/ads${query}`);
  const callsOf = (path) => fake.state.calls.filter((c) => c.path === path);
  const adReports = () => callsOf('/report/integrated/get/').filter((c) => c.query.data_level === 'AUCTION_AD');

  it('carrega TODOS os anúncios de TODAS as contas de uma vez, com status, data de publicação e desempenho de hoje', async () => {
    const user = await setup();
    await connect(user, '111');
    await connect(user, '222');
    const res = await get(user);
    assert.equal(res.status, 200, res.text);
    const { ads, accounts, range } = res.json;
    assert.equal(range.preset, 'today');
    assert.deepEqual(accounts.map((a) => [a.id, a.status, a.adsCount]).sort(), [['9001', 'ok', 3], ['9002', 'ok', 1], ['9101', 'ok', 0]], 'o anúncio excluído não conta');
    assert.deepEqual(ads.map((a) => a.adId).sort(), ['1001', '1002', '1003', '2001']);
    const a1 = ads.find((a) => a.adId === '1001');
    assert.deepEqual({ name: a1.name, op: a1.operationStatus, status: a1.status, created: a1.createdAt, campaign: a1.campaignName, adgroup: a1.adgroupName, account: a1.accountName, currency: a1.currency }, { name: 'Anúncio 1001', op: 'ENABLE', status: 'AD_STATUS_DELIVERY_OK', created: '2026-11-20T13:45:10Z', campaign: 'Campanha A', adgroup: 'Grupo A', account: 'Conta 9001', currency: 'USD' });
    assert.deepEqual({ spend: a1.spend, clicks: a1.clicks, ctr: a1.ctr, cpc: a1.cpc, result: a1.result, cpr: a1.costPerResult, impressions: a1.impressions }, { spend: 10, clicks: 40, ctr: 4, cpc: 0.25, result: 3, cpr: 10 / 3, impressions: 1000 });
    const noSpend = ads.find((a) => a.adId === '1003');
    assert.deepEqual([noSpend.spend, noSpend.clicks, noSpend.result, noSpend.hasMetrics], [0, 0, 0, true], 'anúncio sem entrega hoje aparece com zeros');
    assert.equal(ads.find((a) => a.adId === '2001').currency, 'BRL', 'cada anúncio na moeda da própria conta');
    assert.ok(!res.text.includes(GOOD_TOKEN) && !res.text.includes('access_token'));
  });

  it('pede ao TikTok exatamente como a documentação oficial: /ad/get/ (fields, sem excluídos, 1000) e relatório por anúncio com a data de hoje da conta', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.calls.length = 0;
    await get(user);
    const list = callsOf('/ad/get/')[0];
    assert.equal(list.token, GOOD_TOKEN);
    assert.equal(list.query.page_size, '1000');
    assert.deepEqual(JSON.parse(list.query.filtering), { primary_status: 'STATUS_NOT_DELETE' });
    assert.ok(JSON.parse(list.query.fields).includes('create_time') && JSON.parse(list.query.fields).includes('secondary_status'));
    const report = adReports()[0];
    assert.deepEqual(
      { report_type: report.query.report_type, data_level: report.query.data_level, dimensions: report.query.dimensions, start: report.query.start_date, end: report.query.end_date, page_size: report.query.page_size },
      { report_type: 'BASIC', data_level: 'AUCTION_AD', dimensions: '["ad_id"]', start: '2026-11-23', end: '2026-11-23', page_size: '1000' },
    );
    assert.deepEqual(JSON.parse(report.query.metrics), ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'result', 'cost_per_result', 'conversion', 'cost_per_conversion']);
    assert.equal(callsOf('/ad/get/').length, 2, 'uma consulta de anúncios por conta (9001 e 9002)');
  });

  it('o período muda a data pedida (ontem, 7 dias, este mês, personalizado) e o padrão é HOJE', async () => {
    const user = await setup();
    await connect(user, '111');
    const dates = async (query) => {
      fake.state.calls.length = 0;
      nowMs += 20_000; // passou o prazo em que "Atualizar" reaproveita contas recém-carregadas
      const res = await get(user, `${query}${query.includes('?') ? '&' : '?'}refresh=1`);
      assert.equal(res.status, 200, res.text);
      return [adReports()[0].query.start_date, adReports()[0].query.end_date];
    };
    assert.deepEqual(await dates('?preset=today'), ['2026-11-23', '2026-11-23']);
    assert.deepEqual(await dates('?preset=yesterday'), ['2026-11-22', '2026-11-22']);
    assert.deepEqual(await dates('?preset=last7'), ['2026-11-17', '2026-11-23']);
    assert.deepEqual(await dates('?preset=thisMonth'), ['2026-11-01', '2026-11-23']);
    assert.deepEqual(await dates('?preset=lastMonth'), ['2026-10-01', '2026-10-31']);
    assert.deepEqual(await dates('?preset=custom&from=2026-11-01&to=2026-11-10'), ['2026-11-01', '2026-11-10']);
    assert.deepEqual(await dates(''), ['2026-11-23', '2026-11-23'], 'sem escolher: hoje');
  });

  it('cada conta usa o PRÓPRIO fuso para "hoje" (ex.: virou o dia na Nova Zelândia, mas não em São Paulo)', async () => {
    const user = await setup();
    await connect(user, '111');
    await run(ctx.db, "UPDATE tiktok_advertisers SET timezone = 'Pacific/Auckland' WHERE advertiser_id = '9002'");
    nowMs = Date.parse('2026-11-24T02:30:00Z');
    fake.state.calls.length = 0;
    await get(user, '?refresh=1');
    const byAccount = Object.fromEntries(adReports().map((c) => [c.query.advertiser_id, c.query.start_date]));
    assert.deepEqual(byAccount, { 9001: '2026-11-23', 9002: '2026-11-24' });
  });

  it('valida o período: personalizado sem datas, ao contrário, impossível, passando de 90 dias, ou predefinido desconhecido = 400 (nada vai ao TikTok)', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.calls.length = 0;
    for (const q of ['?preset=custom', '?preset=custom&from=2026-11-10&to=2026-11-01', '?preset=custom&from=2026-02-30&to=2026-03-01', '?preset=custom&from=2026-01-01&to=2026-11-01', '?preset=amanha', '?preset=custom&from=x&to=y']) {
      assert.equal((await get(user, q)).status, 400, q);
    }
    assert.equal(callsOf('/ad/get/').length, 0);
    assert.equal((await get(user, '?preset=custom&from=2026-09-01&to=2026-11-29')).status, 200, '90 dias exatos é permitido');
  });

  it('falha em uma conta não derruba as outras; sem o relatório, os anúncios aparecem sem números ("não carregou")', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.failAdsFor = new Set(['9002']);
    fake.state.failReportFor = new Set(['9001']);
    const { ads, accounts } = (await get(user)).json;
    const a9002 = accounts.find((a) => a.id === '9002');
    assert.equal(a9002.status, 'error');
    assert.match(a9002.error, /TikTok: No permission/);
    const a9001 = accounts.find((a) => a.id === '9001');
    assert.equal(a9001.status, 'ok');
    assert.match(a9001.metricsError, /TikTok/, 'o motivo aparece');
    const shown = ads.filter((a) => a.advertiserId === '9001');
    assert.equal(shown.length, 3, 'os anúncios da conta aparecem mesmo sem o relatório');
    assert.ok(shown.every((a) => a.hasMetrics === false && a.spend === 0));
    assert.equal(ads.some((a) => a.advertiserId === '9002'), false);
  });

  it('se o TikTok recusar a métrica "result", repete sem ela e marca "Resultado" como indisponível (null) em vez de mostrar zero falso', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.rejectResultMetric = true;
    fake.state.calls.length = 0;
    const { ads, accounts } = (await get(user)).json;
    const a1 = ads.find((a) => a.adId === '1001');
    assert.deepEqual([a1.result, a1.costPerResult, a1.spend, a1.clicks], [null, null, 10, 40]);
    assert.equal(accounts.find((a) => a.id === '9001').hasResult, false);
    assert.equal(adReports().filter((c) => c.query.advertiser_id === '9001').length, 2, 'tentou com "result" e repetiu sem ele');
  });

  it('pagina anúncios e relatório (mais de 1000 por conta)', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.ads[9001] = Array.from({ length: 1500 }, (_, i) => ad(100000 + i));
    fake.state.adMetrics[9001] = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [100000 + i, metrics(1 + (i % 7))]));
    fake.state.calls.length = 0;
    const { ads } = (await get(user)).json;
    assert.equal(ads.filter((a) => a.advertiserId === '9001').length, 1500);
    assert.equal(callsOf('/ad/get/').filter((c) => c.query.advertiser_id === '9001').length, 2, 'duas páginas de anúncios');
    assert.equal(adReports().filter((c) => c.query.advertiser_id === '9001').length, 2, 'duas páginas do relatório');
    assert.ok(ads.filter((a) => a.advertiserId === '9001').every((a) => a.spend > 0));
  });

  it('usa cache de 60 s, compartilha consultas simultâneas e "atualizar" (?refresh=1) vai ao TikTok de novo', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.calls.length = 0;
    await Promise.all([get(user), get(user), get(user)]);
    const first = callsOf('/ad/get/').length;
    assert.equal(first, 2, 'três pedidos ao mesmo tempo = uma rodada');
    await get(user);
    assert.equal(callsOf('/ad/get/').length, first, 'dentro de 60 s não consulta de novo');
    await get(user, '?preset=yesterday');
    assert.equal(callsOf('/ad/get/').length, first + 2, 'outro período = outra consulta');
    await get(user, '?refresh=1');
    assert.equal(callsOf('/ad/get/').length, first + 2, 'atualizar logo depois reaproveita as contas que acabaram de carregar certo');
    nowMs += 20_000;
    await get(user, '?refresh=1');
    assert.equal(callsOf('/ad/get/').length, first + 4, 'depois de 15 s, atualizar vai ao TikTok de novo');
  });

  it('conta SEM anúncios não pede o relatório de desempenho (menos chamadas ao TikTok)', async () => {
    const user = await setup();
    await connect(user, '111');
    await connect(user, '222');
    fake.state.calls.length = 0;
    const res = await get(user);
    assert.equal(res.status, 200, res.text);
    assert.equal(callsOf('/ad/get/').length, 3, 'as 3 contas têm a lista consultada');
    assert.deepEqual(adReports().map((c) => c.query.advertiser_id).sort(), ['9001', '9002'], 'a conta vazia (9101) não pede relatório');
  });

  it('limite de frequência do TikTok (40100): avisa, não insiste, e "Atualizar" consulta só as contas que faltaram', async () => {
    const user = await setup();
    const ids = ['9001', '9002', '9003', '9004', '9005', '9006'];
    fake.state.bcs = { 111: ids, 222: [] };
    fake.state.currencies = Object.fromEntries(ids.map((id) => [id, 'USD']));
    fake.state.ads = Object.fromEntries(ids.map((id, i) => [id, [ad(3000 + i, { advertiser_id: id })]]));
    fake.state.adMetrics = Object.fromEntries(ids.map((id, i) => [id, { [3000 + i]: metrics(5) }]));
    await connect(user, '111');
    fake.state.rateLimitFor = new Set(['9001']);
    fake.state.calls.length = 0;
    const first = (await get(user)).json;
    const failed = first.accounts.filter((a) => a.status === 'error');
    assert.ok(failed.some((a) => a.id === '9001'), 'a conta limitada aparece com erro');
    assert.ok(failed.every((a) => /limit|pausa/i.test(a.error)), `a mensagem fala do limite: ${JSON.stringify(failed.map((a) => a.error))}`);
    assert.ok(first.accounts.some((a) => a.status === 'ok'), 'as outras contas carregam');
    assert.ok(callsOf('/ad/get/').length <= 6);
    const okBefore = first.accounts.filter((a) => a.status === 'ok').map((a) => a.id);
    // o limite passou: "Atualizar" refaz SÓ o que falhou
    fake.state.rateLimitFor = new Set();
    fake.state.calls.length = 0;
    const second = (await get(user, '?refresh=1')).json;
    assert.ok(second.accounts.every((a) => a.status === 'ok'), JSON.stringify(second.accounts.map((a) => [a.id, a.status, a.error])));
    assert.deepEqual(callsOf('/ad/get/').map((c) => c.query.advertiser_id).sort(), failed.map((a) => a.id).sort(), 'só as contas que falharam foram consultadas');
    assert.ok(okBefore.every((id) => !callsOf('/ad/get/').some((c) => c.query.advertiser_id === id)));
    assert.equal(second.ads.length, 6);
  });

  it('conectar uma BC logo depois de ver a lista vazia mostra os anúncios na hora (o cache muda com as contas)', async () => {
    const user = await setup();
    assert.deepEqual((await get(user)).json.ads, []);
    await connect(user, '111');
    assert.ok((await get(user)).json.ads.length > 0);
  });

  describe('ativar e pausar', () => {
    const post = (user, body) => user.client.post('/api/tiktok/manager/ads/status', body);

    it('pausa e ativa pelo contrato oficial (ad_ids, operation_status) e a lista já mostra o novo status', async () => {
      const user = await setup();
      await connect(user, '111');
      await get(user);
      fake.state.calls.length = 0;
      const off = await post(user, { advertiserId: '9001', adIds: ['1001'], status: 'DISABLE' });
      assert.equal(off.status, 200, off.text);
      assert.deepEqual([off.json.status, off.json.updated, off.json.failed], ['DISABLE', ['1001'], []]);
      const call = callsOf('/ad/status/update/')[0];
      assert.deepEqual([call.method, call.token, call.body], ['POST', GOOD_TOKEN, { advertiser_id: '9001', ad_ids: ['1001'], operation_status: 'DISABLE' }]);
      const after1 = (await get(user)).json.ads.find((a) => a.adId === '1001');
      assert.deepEqual([after1.operationStatus, after1.status], ['DISABLE', 'AD_STATUS_DISABLE'], 'o cache foi invalidado');
      const on = await post(user, { advertiserId: '9001', adIds: ['1001', '1002'], status: 'ENABLE' });
      assert.deepEqual(on.json.updated.sort(), ['1001', '1002']);
      assert.equal((await get(user)).json.ads.find((a) => a.adId === '1002').operationStatus, 'ENABLE');
    });

    it('envia de 20 em 20 (limite do TikTok) e uma falha no meio não esconde o que já mudou', async () => {
      const user = await setup();
      await connect(user, '111');
      fake.state.ads[9001] = Array.from({ length: 45 }, (_, i) => ad(300000 + i));
      const ids = fake.state.ads[9001].map((a) => a.ad_id);
      fake.state.calls.length = 0;
      const res = await post(user, { advertiserId: '9001', adIds: ids, status: 'DISABLE' });
      assert.deepEqual(callsOf('/ad/status/update/').map((c) => c.body.ad_ids.length), [20, 20, 5]);
      assert.equal(res.json.updated.length, 45);

      fake.state.ads[9001].forEach((a) => { a.operation_status = 'ENABLE'; });
      const original = fake.state.ads[9001];
      let calls = 0;
      fake.state.failAdStatusFor = { has: () => { calls += 1; return calls === 2; } }; // só o 2º lote falha
      const partial = await post(user, { advertiserId: '9001', adIds: ids, status: 'DISABLE' });
      assert.equal(partial.status, 200, partial.text);
      assert.equal(partial.json.updated.length, 20, 'o primeiro lote mudou');
      assert.equal(partial.json.failed.length, 25);
      assert.match(partial.json.failure, /TikTok/);
      assert.equal(original.filter((a) => a.operation_status === 'DISABLE').length, 20);
    });

    it('NUNCA exclui: DELETE e qualquer outro status são recusados aqui, sem chamar o TikTok', async () => {
      const user = await setup();
      await connect(user, '111');
      fake.state.calls.length = 0;
      for (const status of ['DELETE', 'delete', 'PAUSE', '', null, undefined, 5]) assert.equal((await post(user, { advertiserId: '9001', adIds: ['1001'], status })).status, 400, String(status));
      assert.equal(callsOf('/ad/status/update/').length, 0);
    });

    it('valida os IDs e a conta; conta de outra pessoa = 404', async () => {
      const user = await setup();
      await connect(user, '111');
      const other = await createUser(ctx, { approve: true, email: emailOf() });
      fake.state.calls.length = 0;
      const bad = [
        { advertiserId: 'abc', adIds: ['1'], status: 'ENABLE' }, { advertiserId: '9001', adIds: [], status: 'ENABLE' }, { advertiserId: '9001', adIds: ['x'], status: 'ENABLE' },
        { advertiserId: '9001', adIds: [1], status: 'ENABLE' }, { advertiserId: '9001', adIds: Array.from({ length: 201 }, (_, i) => String(i + 1)), status: 'ENABLE' },
        { advertiserId: '9001', adIds: 'tudo', status: 'ENABLE' }, { adIds: ['1'], status: 'ENABLE' }, { advertiserId: 9001, adIds: ['1'], status: 'ENABLE' },
      ];
      for (const body of bad) assert.equal((await post(user, body)).status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal((await user.client.post('/api/tiktok/manager/ads/status', [])).status, 400);
      assert.equal((await post(other, { advertiserId: '9001', adIds: ['1001'], status: 'DISABLE' })).status, 404, 'conta de outra pessoa');
      assert.equal((await post(user, { advertiserId: '777', adIds: ['1001'], status: 'DISABLE' })).status, 404);
      assert.equal(callsOf('/ad/status/update/').length, 0);
    });

    it('erro do TikTok vira mensagem na tela; token revogado pede para renovar o acesso', async () => {
      const user = await setup();
      await connect(user, '111');
      fake.state.failAdStatusFor = new Set(['9001']);
      const denied = await post(user, { advertiserId: '9001', adIds: ['1001'], status: 'DISABLE' });
      assert.equal(denied.status, 502);
      assert.match(denied.json.error.message, /TikTok: No permission/);
      fake.state.failAdStatusFor = new Set();
      fake.state.validTokens.delete(GOOD_TOKEN);
      const revoked = await post(user, { advertiserId: '9001', adIds: ['1001'], status: 'DISABLE' });
      assert.equal(revoked.status, 409);
      assert.equal(revoked.json.error.code, 'tiktok_reauth');
    });
  });

  describe('visualizações salvas (de cada pessoa)', () => {
    const base = () => defaultViewConfig();
    const create = (user, body) => user.client.post('/api/tiktok/manager/views', body);

    it('lista (com a configuração padrão), cria, atualiza, define a padrão e exclui', async () => {
      const user = await setup();
      const first = await user.client.get('/api/tiktok/manager/views');
      assert.equal(first.status, 200);
      assert.deepEqual([first.json.views, normalizeViewConfig(first.json.defaultConfig)], [[], first.json.defaultConfig]);

      const config = { ...base(), columns: [{ key: 'spend', visible: true }, { key: 'name', visible: true }], sort: { key: 'clicks', dir: 'asc' }, filters: { status: 'active', accountId: '9001', onlySpent: true }, datePreset: 'last7', pageSize: 50 };
      const made = await create(user, { name: '  Só com gasto  ', config });
      assert.equal(made.status, 201, made.text);
      assert.equal(made.json.view.name, 'Só com gasto');
      assert.deepEqual(made.json.view.config.columns.slice(0, 2), [{ key: 'spend', visible: true }, { key: 'name', visible: true }], 'a ordem escolhida é guardada');
      assert.equal(made.json.view.config.columns.length, MANAGER_COLUMNS.length);
      assert.equal(made.json.view.isDefault, false);

      const second = (await create(user, { name: 'Padrão da equipe', config: base(), isDefault: true })).json.view;
      assert.equal(second.isDefault, true);
      assert.deepEqual((await user.client.get('/api/tiktok/manager/views')).json.views.map((v) => [v.name, v.isDefault]), [['Padrão da equipe', true], ['Só com gasto', false]], 'a padrão vem primeiro');

      const renamed = await user.client.patch(`/api/tiktok/manager/views/${made.json.view.id}`, { name: 'Só gasto', isDefault: true });
      assert.equal(renamed.status, 200, renamed.text);
      assert.deepEqual([renamed.json.view.name, renamed.json.view.isDefault], ['Só gasto', true]);
      const views = (await user.client.get('/api/tiktok/manager/views')).json.views;
      assert.equal(views.filter((v) => v.isDefault).length, 1, 'só uma visualização é a padrão');
      const reconfig = await user.client.patch(`/api/tiktok/manager/views/${made.json.view.id}`, { config: { ...config, datePreset: 'yesterday' } });
      assert.equal(reconfig.json.view.config.datePreset, 'yesterday');
      assert.equal(reconfig.json.view.name, 'Só gasto', 'atualizar a configuração não mexe no nome');
      assert.equal((await user.client.patch(`/api/tiktok/manager/views/${made.json.view.id}`, { isDefault: false })).json.view.isDefault, false);

      assert.equal((await user.client.delete(`/api/tiktok/manager/views/${made.json.view.id}`)).status, 204);
      assert.equal((await user.client.delete(`/api/tiktok/manager/views/${made.json.view.id}`)).status, 404);
    });

    it('valida nome e configuração: nome repetido (maiúsculas não importam) = 409; nome vazio/grande/controle e configuração inválida = 400', async () => {
      const user = await setup();
      assert.equal((await create(user, { name: 'Minha', config: base() })).status, 201);
      const dup = await create(user, { name: 'MINHA', config: base() });
      assert.equal(dup.status, 409);
      assert.equal(dup.json.error.code, 'view_exists');
      for (const name of ['', '   ', 'x'.repeat(41), 'a\u0001b', 5, null, undefined]) assert.equal((await create(user, { name, config: base() })).status, 400, JSON.stringify(name));
      for (const config of [undefined, null, [], {}, { ...base(), columns: [{ key: 'hack', visible: true }] }, { ...base(), sort: { key: 'x', dir: 'asc' } }, { ...base(), datePreset: 'custom' }]) assert.equal((await create(user, { name: 'Ruim', config })).status, 400);
      assert.equal((await user.client.post('/api/tiktok/manager/views', [])).status, 400);
      const other = (await create(user, { name: 'Outra', config: base() })).json.view;
      assert.equal((await user.client.patch(`/api/tiktok/manager/views/${other.id}`, { name: 'minha' })).status, 409, 'renomear para um nome existente');
      assert.equal((await user.client.patch(`/api/tiktok/manager/views/${other.id}`, {})).status, 400, 'nada para atualizar');
      assert.equal((await user.client.patch(`/api/tiktok/manager/views/${other.id}`, { isDefault: 'sim' })).status, 400);
      assert.equal((await user.client.patch(`/api/tiktok/manager/views/${other.id}`, { config: { columns: [] } })).status, 400);
    });

    it('no máximo 20 visualizações por pessoa', async () => {
      const user = await setup();
      const id = (await one(ctx.db, 'SELECT id FROM users WHERE lower(email) = $1', [user.email.toLowerCase()])).id;
      await run(ctx.db, "INSERT INTO manager_views (user_id, name, config) SELECT $1, 'V' || g, $2::jsonb FROM generate_series(1, $3::int) g", [id, JSON.stringify(base()), MAX_VIEWS_PER_USER]);
      const res = await create(user, { name: 'Uma a mais', config: base() });
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, 'too_many_views');
    });

    it('isolamento: cada PESSOA vê só as próprias visualizações (inclusive dentro do mesmo espaço de trabalho)', async () => {
      const owner = await setup();
      const stranger = await createUser(ctx, { approve: true, email: emailOf() });
      const mine = (await create(owner, { name: 'Do dono', config: base(), isDefault: true })).json.view;
      assert.deepEqual((await stranger.client.get('/api/tiktok/manager/views')).json.views, []);
      assert.equal((await stranger.client.patch(`/api/tiktok/manager/views/${mine.id}`, { name: 'Roubada' })).status, 404);
      assert.equal((await stranger.client.delete(`/api/tiktok/manager/views/${mine.id}`)).status, 404);
      assert.equal((await create(stranger, { name: 'Do dono', config: base() })).status, 201, 'cada um tem os próprios nomes');

      const email = emailOf();
      assert.equal((await owner.client.post('/api/team/invites', { email, name: 'Maria Colab', areas: ['campaigns'] })).status, 201);
      const collaborator = ctx.client();
      const accepted = await collaborator.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
      collaborator.csrf = accepted.json.csrfToken;
      assert.deepEqual((await collaborator.get('/api/tiktok/manager/views')).json.views, [], 'o colaborador não herda as visualizações do dono');
      assert.equal((await collaborator.post('/api/tiktok/manager/views', { name: 'Da Maria', config: base() })).status, 201);
      assert.deepEqual((await owner.client.get('/api/tiktok/manager/views')).json.views.map((v) => v.name), ['Do dono']);
    });

    it('o banco recusa configuração enorme e duas padrões; configuração adulterada no banco nunca é devolvida', async () => {
      const user = await setup();
      const id = (await one(ctx.db, 'SELECT id FROM users WHERE lower(email) = $1', [user.email.toLowerCase()])).id;
      await assert.rejects(run(ctx.db, "INSERT INTO manager_views (user_id, name, config) VALUES ($1, 'Grande', $2::jsonb)", [id, JSON.stringify({ x: 'a'.repeat(5000) })]), (e) => e.code === '23514');
      await assert.rejects(run(ctx.db, "INSERT INTO manager_views (user_id, name, config) VALUES ($1, 'Lista', '[1]'::jsonb)", [id]), (e) => e.code === '23514');
      await run(ctx.db, "INSERT INTO manager_views (user_id, name, config, is_default) VALUES ($1, 'A', $2::jsonb, true)", [id, JSON.stringify(base())]);
      await assert.rejects(run(ctx.db, "INSERT INTO manager_views (user_id, name, config, is_default) VALUES ($1, 'B', $2::jsonb, true)", [id, JSON.stringify(base())]), (e) => e.code === '23505');
      await run(ctx.db, "INSERT INTO manager_views (user_id, name, config) VALUES ($1, 'Adulterada', '{\"columns\":[{\"key\":\"<script>\",\"visible\":true}]}'::jsonb)", [id]);
      assert.deepEqual((await user.client.get('/api/tiktok/manager/views')).json.views.map((v) => v.name), ['A']);
      assert.equal((await all(ctx.db, 'SELECT 1 FROM manager_views WHERE user_id = $1', [id])).length, 2);
    });
  });

  it('permissões: sem login 401; colaborador de "Relatórios" só vê; de "Campanhas" também ativa/pausa; de "Contas TikTok" não entra', async () => {
    const owner = await setup();
    await connect(owner, '111');
    assert.equal((await ctx.client().get('/api/tiktok/manager/ads')).status, 401);
    assert.equal((await ctx.client().post('/api/tiktok/manager/ads/status', { advertiserId: '9001', adIds: ['1001'], status: 'DISABLE' })).status, 401);
    async function collaborator(areas) {
      const email = emailOf();
      assert.equal((await owner.client.post('/api/team/invites', { email, name: 'Maria Colab', areas })).status, 201);
      const client = ctx.client();
      const accepted = await client.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
      client.csrf = accepted.json.csrfToken;
      return client;
    }
    const toggle = { advertiserId: '9001', adIds: ['1001'], status: 'DISABLE' };
    const reports = await collaborator(['reports']);
    assert.equal((await reports.get('/api/tiktok/manager/ads')).status, 200);
    assert.equal((await reports.post('/api/tiktok/manager/ads/status', toggle)).status, 403, 'só ver: não ativa nem pausa');
    const campaigns = await collaborator(['campaigns']);
    assert.equal((await campaigns.get('/api/tiktok/manager/ads')).status, 200);
    assert.equal((await campaigns.post('/api/tiktok/manager/ads/status', toggle)).status, 200);
    const accounts = await collaborator(['accounts']);
    assert.equal((await accounts.get('/api/tiktok/manager/ads')).status, 403);
    assert.equal((await accounts.get('/api/tiktok/manager/views')).status, 403);
    const creatives = await collaborator(['creatives']);
    assert.equal((await creatives.post('/api/tiktok/manager/ads/status', toggle)).status, 403);
  });

  it('isolamento: cada usuário vê só os anúncios das próprias contas', async () => {
    const a = await setup();
    await connect(a, '111');
    const b = await createUser(ctx, { approve: true, email: emailOf() });
    await connect(b, '222', OTHER_TOKEN);
    fake.state.ads[9101] = [ad(9999, { advertiser_id: '9101', ad_name: 'Do outro usuário' })];
    const seenByA = (await get(a)).json;
    assert.ok(!seenByA.ads.some((x) => x.advertiserId === '9101'));
    assert.deepEqual((await get(b)).json.ads.map((x) => x.adId), ['9999']);
  });

  it('o limite de "Atualizar" (?refresh=1) tem contagem própria (429), sem impedir a consulta normal', async () => {
    const lim = await startTestServer({ limits: { ...LIMITS, managerRefresh: 2 }, config: tiktokTestConfig(), fetchFn: fake.fetchFn, isolated: true });
    try {
      const user = await createUser(lim, { approve: true, email: emailOf() });
      await setup();
      await user.client.post('/api/tiktok/business-centers', { name: 'BC', bcId: '111', accessToken: GOOD_TOKEN });
      const statuses = [];
      for (let i = 0; i < 3; i += 1) statuses.push((await user.client.get('/api/tiktok/manager/ads?refresh=1')).status);
      assert.deepEqual(statuses, [200, 200, 429]);
      assert.equal((await user.client.get('/api/tiktok/manager/ads')).status, 200);
    } finally {
      await lim.stop();
    }
  });
});
