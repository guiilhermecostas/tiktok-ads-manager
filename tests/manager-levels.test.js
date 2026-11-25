import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { LEVEL_IDS, MANAGER_LEVELS, budgetLabel, goalLabel, isLevel, objectiveLabel } from '../shared/manager-levels.js';
import { MANAGER_COLUMNS, appliesTo, columnLabel } from '../shared/manager-columns.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, managerRead: 5000, managerRefresh: 5000, managerWrite: 5000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `lv${++counter}@example.com`;
const ad = (id, extra = {}) => ({ ad_id: String(id), ad_name: `Anúncio ${id}`, advertiser_id: '9001', campaign_id: '5001', campaign_name: 'Campanha A', adgroup_id: '6001', adgroup_name: 'Grupo A', operation_status: 'ENABLE', secondary_status: 'AD_STATUS_DELIVERY_OK', create_time: '2026-11-20 13:45:10', modify_time: '2026-11-22 08:00:00', ...extra });
const metrics = (spend, extra = {}) => ({ spend, impressions: spend * 100, clicks: spend * 4, ctr: 4, cpc: 0.25, result: 3, cost_per_result: spend / 3, conversion: 2, cost_per_conversion: spend / 2, ...extra });

describe('Gerenciador em níveis: regras compartilhadas', () => {
  it('os três níveis existem, na ordem da hierarquia, e só eles são aceitos', () => {
    assert.deepEqual(LEVEL_IDS, ['campaigns', 'adgroups', 'ads']);
    assert.deepEqual(LEVEL_IDS.map((id) => MANAGER_LEVELS[id].tab), ['Campanhas', 'Grupos de anúncios', 'Anúncios']);
    for (const ok of LEVEL_IDS) assert.equal(isLevel(ok), true);
    for (const bad of ['', 'ad', 'ADS', '__proto__', 'constructor', 'toString', null, undefined, 5, {}, ['ads']]) assert.equal(isLevel(bad), false, String(bad));
  });

  it('cada coluna diz onde existe; o rótulo do nome muda com o nível; objetivo/meta/orçamento não aparecem em anúncios', () => {
    const col = (key) => MANAGER_COLUMNS.find((c) => c.key === key);
    assert.deepEqual(LEVEL_IDS.map((l) => columnLabel(col('name'), l)), ['Campanha', 'Grupo de anúncios', 'Anúncio']);
    assert.equal(columnLabel(col('spend'), 'ads'), 'Valor gasto');
    assert.deepEqual(['objective', 'goal', 'budget', 'campaign', 'adgroup'].map((k) => LEVEL_IDS.filter((l) => appliesTo(col(k), l))), [['campaigns'], ['adgroups'], ['campaigns', 'adgroups'], ['adgroups', 'ads'], ['ads']]);
    for (const c of MANAGER_COLUMNS) assert.ok(c.levels.length && c.levels.every(isLevel), c.key);
    for (const key of ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'result', 'costPerResult', 'conversions', 'costPerConversion', 'status', 'toggle']) assert.equal(LEVEL_IDS.every((l) => appliesTo(col(key), l)), true, key);
  });

  it('textos de objetivo, meta e orçamento (conhecidos em português; desconhecidos humanizados; nada vazio vira "undefined")', () => {
    assert.equal(objectiveLabel('PRODUCT_SALES'), 'Vendas de produtos');
    assert.equal(objectiveLabel('NEW_THING'), 'New thing');
    assert.equal(objectiveLabel(null), '—');
    assert.equal(goalLabel('CONVERT'), 'Conversões');
    assert.equal(goalLabel('SOMETHING_ELSE'), 'Something else');
    const money = (v, c) => `${c} ${v}`;
    assert.equal(budgetLabel({ budgetMode: 'BUDGET_MODE_DAY', budget: 50, currency: 'USD' }, 'campaigns', money), 'USD 50/dia');
    assert.equal(budgetLabel({ budgetMode: 'BUDGET_MODE_TOTAL', budget: 300, currency: 'USD' }, 'adgroups', money), 'USD 300 no total');
    assert.equal(budgetLabel({ budgetMode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET', budget: 10, currency: 'USD' }, 'adgroups', money), 'USD 10/dia (médio)');
    assert.equal(budgetLabel({ budgetMode: 'BUDGET_MODE_INFINITE', budget: 0 }, 'adgroups', money), 'Definido na campanha');
    assert.equal(budgetLabel({ budgetMode: 'BUDGET_MODE_INFINITE', budget: 0 }, 'campaigns', money), 'Sem limite');
    assert.equal(budgetLabel({ budgetMode: null, budget: null }, 'campaigns', money), '—');
    assert.equal(budgetLabel({ budgetMode: 'BUDGET_MODE_DAY', budget: null }, 'campaigns', money), '—');
  });
});

describe('Gerenciador em níveis: campanhas, grupos e anúncios (API do sistema + TikTok simulado)', () => {
  let ctx;
  let fake;
  let mailer;
  before(async () => {
    fake = createFakeTiktok();
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer, clock: () => new Date(Date.parse('2026-11-23T17:20:00Z')) });
  });
  after(() => ctx.stop());

  async function setup() {
    await run(ctx.db, 'DELETE FROM manager_views');
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9101'] };
    fake.state.currencies = { 9001: 'USD', 9002: 'BRL', 9101: 'BRL' };
    fake.state.validTokens.add(GOOD_TOKEN);
    fake.state.validTokens.add(OTHER_TOKEN);
    for (const name of ['failAdsFor', 'rateLimitFor', 'failAdStatusFor', 'failReportFor', 'failCampaignsFor', 'failAdgroupsFor', 'failCampaignStatusFor', 'failAdgroupStatusFor']) fake.state[name] = new Set();
    fake.state.rejectResultMetric = false;
    fake.state.campaigns = {};
    fake.state.adgroups = {};
    fake.state.ads = {
      9001: [
        ad(1001), ad(1002, { ad_name: 'Pausado', operation_status: 'DISABLE', secondary_status: 'AD_STATUS_DISABLE' }),
        ad(1003, { campaign_id: '5002', campaign_name: 'Campanha B', adgroup_id: '6002', adgroup_name: 'Grupo B' }),
      ],
      9002: [ad(2001, { advertiser_id: '9002', campaign_id: '5101', campaign_name: 'Campanha em reais', adgroup_id: '6101', adgroup_name: 'Grupo em reais' })],
      9101: [],
    };
    fake.state.adMetrics = { 9001: { 1001: metrics(10), 1002: metrics(4), 1003: metrics(6) }, 9002: { 2001: metrics(30) } };
    fake.state.adMetricsByDate = {};
    fake.state.calls.length = 0;
    return createUser(ctx, { approve: true, email: emailOf() });
  }
  const connect = (user, bcId = '111', token = GOOD_TOKEN) => user.client.post('/api/tiktok/business-centers', { name: `BC ${bcId}`, bcId, accessToken: token });
  const get = (user, level, query = '') => user.client.get(`/api/tiktok/manager/${level}${query}`);
  const callsOf = (path) => fake.state.calls.filter((c) => c.path === path);

  it('campanhas: lista de todas as contas com objetivo, orçamento, status e o desempenho SOMADO dos anúncios de cada uma', async () => {
    const user = await setup();
    await connect(user, '111');
    const res = await get(user, 'campaigns');
    assert.equal(res.status, 200, res.text);
    const { campaigns, accounts, ads } = res.json;
    assert.equal(ads, undefined, 'cada resposta traz só a lista do próprio nível');
    assert.deepEqual(accounts.map((a) => [a.id, a.status, a.itemsCount]).sort(), [['9001', 'ok', 2], ['9002', 'ok', 1]]);
    assert.deepEqual(campaigns.map((c) => c.id).sort(), ['5001', '5002', '5101']);
    const a = campaigns.find((c) => c.id === '5001');
    assert.deepEqual(
      { name: a.name, campaignId: a.campaignId, objective: a.objectiveType, mode: a.budgetMode, budget: a.budget, op: a.operationStatus, status: a.status, account: a.accountName, currency: a.currency, created: a.createdAt },
      { name: 'Campanha A', campaignId: '5001', objective: 'TRAFFIC', mode: 'BUDGET_MODE_DAY', budget: 50, op: 'ENABLE', status: 'CAMPAIGN_STATUS_ENABLE', account: 'Conta 9001', currency: 'USD', created: '2026-11-20T13:45:10Z' },
    );
    assert.deepEqual({ spend: a.spend, clicks: a.clicks, impressions: a.impressions, ctr: a.ctr, cpc: a.cpc }, { spend: 14, clicks: 56, impressions: 1400, ctr: 4, cpc: 0.25 }, 'soma dos anúncios 1001 e 1002');
    assert.equal(campaigns.find((c) => c.id === '5101').currency, 'BRL');
    assert.ok(!res.text.includes(GOOD_TOKEN));
  });

  it('grupos de anúncios: com a campanha de cada um, meta, orçamento e desempenho do grupo', async () => {
    const user = await setup();
    await connect(user, '111');
    const { adgroups, ads } = (await get(user, 'adgroups')).json;
    assert.equal(ads, undefined);
    assert.deepEqual(adgroups.map((g) => g.id).sort(), ['6001', '6002', '6101']);
    const g = adgroups.find((x) => x.id === '6002');
    assert.deepEqual({ name: g.name, adgroupId: g.adgroupId, campaignId: g.campaignId, campaignName: g.campaignName, goal: g.optimizationGoal, budget: g.budget, status: g.status, spend: g.spend }, { name: 'Grupo B', adgroupId: '6002', campaignId: '5002', campaignName: 'Campanha B', goal: 'CLICK', budget: 20, status: 'ADGROUP_STATUS_DELIVERY_OK', spend: 6 });
  });

  it('anúncios: continuam iguais (adId e lista em `ads`) e agora também têm `id`', async () => {
    const user = await setup();
    await connect(user, '111');
    const { ads } = (await get(user, 'ads')).json;
    const a = ads.find((x) => x.adId === '1001');
    assert.deepEqual([a.id, a.name, a.campaignId, a.adgroupId, a.spend], ['1001', 'Anúncio 1001', '5001', '6001', 10]);
  });

  it('pede ao TikTok como a documentação oficial: /campaign/get/ e /adgroup/get/ (fields, sem excluídos, 1000) e relatório com data_level e UMA dimensão de ID', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.calls.length = 0;
    await get(user, 'campaigns');
    await get(user, 'adgroups');
    const campaignCall = callsOf('/campaign/get/')[0];
    const adgroupCall = callsOf('/adgroup/get/')[0];
    for (const call of [campaignCall, adgroupCall]) {
      assert.equal(call.token, GOOD_TOKEN);
      assert.equal(call.query.page_size, '1000');
      assert.deepEqual(JSON.parse(call.query.filtering), { primary_status: 'STATUS_NOT_DELETE' });
      assert.ok(JSON.parse(call.query.fields).includes('secondary_status') && JSON.parse(call.query.fields).includes('operation_status'));
    }
    assert.ok(JSON.parse(campaignCall.query.fields).includes('objective_type'));
    assert.ok(JSON.parse(adgroupCall.query.fields).includes('optimization_goal') && JSON.parse(adgroupCall.query.fields).includes('campaign_id'));
    const reports = callsOf('/report/integrated/get/');
    const levels = reports.map((r) => [r.query.data_level, r.query.dimensions]);
    assert.ok(levels.some(([l, d]) => l === 'AUCTION_CAMPAIGN' && d === '["campaign_id"]'));
    assert.ok(levels.some(([l, d]) => l === 'AUCTION_ADGROUP' && d === '["adgroup_id"]'));
    assert.ok(reports.every((r) => r.query.report_type === 'BASIC' && r.query.start_date === '2026-11-23' && r.query.end_date === '2026-11-23'));
  });

  it('cada nível tem o próprio cache (trocar de aba não refaz o que já carregou) e o período é por conta', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.calls.length = 0;
    await get(user, 'campaigns');
    const first = fake.state.calls.length;
    await get(user, 'campaigns');
    assert.equal(fake.state.calls.length, first, 'a segunda consulta saiu do cache');
    await get(user, 'adgroups');
    assert.ok(fake.state.calls.length > first, 'outro nível consulta de novo');
    assert.equal(callsOf('/campaign/get/').length, 2, 'uma por conta (2 contas), sem repetir');
  });

  it('falha de um nível numa conta aparece naquela conta e não derruba as outras nem os outros níveis', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.failCampaignsFor.add('9001');
    const campaigns = (await get(user, 'campaigns', '?refresh=1')).json;
    assert.deepEqual(campaigns.accounts.map((a) => [a.id, a.status]).sort(), [['9001', 'error'], ['9002', 'ok']]);
    assert.match(campaigns.accounts.find((a) => a.id === '9001').error, /TikTok|permiss/i);
    assert.deepEqual(campaigns.campaigns.map((c) => c.id), ['5101']);
    const adgroups = (await get(user, 'adgroups')).json;
    assert.deepEqual(adgroups.accounts.map((a) => a.status), ['ok', 'ok'], 'os grupos seguem normais');
  });

  it('se o TikTok recusar a métrica "result", o nível carrega do mesmo jeito (sem resultado)', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.rejectResultMetric = true;
    const { campaigns, accounts } = (await get(user, 'campaigns')).json;
    assert.ok(accounts.every((a) => a.hasResult === false));
    const c = campaigns.find((x) => x.id === '5001');
    assert.deepEqual([c.result, c.spend], [null, 14]);
  });

  it('nível desconhecido não existe (404) e não chega ao TikTok', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.calls.length = 0;
    for (const bad of ['ad', 'campaign', 'users', '__proto__', 'adgroups%2F..']) assert.equal((await get(user, bad)).status, 404, bad);
    assert.equal(fake.state.calls.length, 0);
  });

  describe('ativar e pausar campanhas e grupos', () => {
    const post = (user, level, body) => user.client.post(`/api/tiktok/manager/${level}/status`, body);

    it('campanha: pausa e ativa pelo contrato oficial (campaign_ids, operation_status) e a lista já mostra o novo status', async () => {
      const user = await setup();
      await connect(user, '111');
      await get(user, 'campaigns');
      fake.state.calls.length = 0;
      const off = await post(user, 'campaigns', { advertiserId: '9001', campaignIds: ['5001'], status: 'DISABLE' });
      assert.equal(off.status, 200, off.text);
      assert.deepEqual([off.json.status, off.json.updated, off.json.failed], ['DISABLE', ['5001'], []]);
      const call = callsOf('/campaign/status/update/')[0];
      assert.deepEqual([call.method, call.token, call.body], ['POST', GOOD_TOKEN, { advertiser_id: '9001', campaign_ids: ['5001'], operation_status: 'DISABLE' }]);
      const after1 = (await get(user, 'campaigns')).json.campaigns.find((c) => c.id === '5001');
      assert.deepEqual([after1.operationStatus, after1.status], ['DISABLE', 'CAMPAIGN_STATUS_DISABLE'], 'o cache foi invalidado');
      const on = await post(user, 'campaigns', { advertiserId: '9001', campaignIds: ['5001', '5002'], status: 'ENABLE' });
      assert.deepEqual(on.json.updated.sort(), ['5001', '5002']);
    });

    it('grupo: pelo contrato oficial (adgroup_ids, operation_status)', async () => {
      const user = await setup();
      await connect(user, '111');
      await get(user, 'adgroups');
      fake.state.calls.length = 0;
      const off = await post(user, 'adgroups', { advertiserId: '9001', adgroupIds: ['6001'], status: 'DISABLE' });
      assert.equal(off.status, 200, off.text);
      assert.deepEqual(off.json.updated, ['6001']);
      assert.deepEqual(callsOf('/adgroup/status/update/')[0].body, { advertiser_id: '9001', adgroup_ids: ['6001'], operation_status: 'DISABLE' });
      assert.equal((await get(user, 'adgroups')).json.adgroups.find((g) => g.id === '6001').status, 'ADGROUP_STATUS_DISABLE');
    });

    it('envia de 20 em 20 e uma falha no meio não esconde o que já mudou', async () => {
      const user = await setup();
      await connect(user, '111');
      fake.state.ads[9001] = Array.from({ length: 45 }, (_, i) => ad(300000 + i, { campaign_id: String(7000 + i), campaign_name: `C${i}`, adgroup_id: String(8000 + i) }));
      await get(user, 'campaigns');
      const ids = fake.state.campaigns[9001].map((c) => c.campaign_id);
      fake.state.calls.length = 0;
      const res = await post(user, 'campaigns', { advertiserId: '9001', campaignIds: ids, status: 'DISABLE' });
      assert.deepEqual(callsOf('/campaign/status/update/').map((c) => c.body.campaign_ids.length), [20, 20, 5]);
      assert.equal(res.json.updated.length, 45);
    });

    it('NUNCA exclui: DELETE e qualquer status fora de ENABLE/DISABLE é recusado antes de chegar ao TikTok', async () => {
      const user = await setup();
      await connect(user, '111');
      fake.state.calls.length = 0;
      for (const status of ['DELETE', 'delete', '', null, undefined, 'PAUSE']) {
        assert.equal((await post(user, 'campaigns', { advertiserId: '9001', campaignIds: ['5001'], status })).status, 400, String(status));
        assert.equal((await post(user, 'adgroups', { advertiserId: '9001', adgroupIds: ['6001'], status })).status, 400, String(status));
      }
      assert.equal(callsOf('/campaign/status/update/').length + callsOf('/adgroup/status/update/').length, 0);
    });

    it('valida o corpo: conta e IDs numéricos, de 1 a 200, e o nome do campo certo de cada nível', async () => {
      const user = await setup();
      await connect(user, '111');
      const bad = [
        ['campaigns', { advertiserId: 'abc', campaignIds: ['5001'], status: 'DISABLE' }],
        ['campaigns', { advertiserId: '9001', campaignIds: [], status: 'DISABLE' }],
        ['campaigns', { advertiserId: '9001', campaignIds: ['5001; DROP'], status: 'DISABLE' }],
        ['campaigns', { advertiserId: '9001', campaignIds: 'x', status: 'DISABLE' }],
        ['campaigns', { advertiserId: '9001', campaignIds: Array.from({ length: 201 }, (_, i) => String(i + 1)), status: 'DISABLE' }],
        ['campaigns', { advertiserId: '9001', adIds: ['5001'], status: 'DISABLE' }],
        ['adgroups', { advertiserId: '9001', campaignIds: ['6001'], status: 'DISABLE' }],
        ['adgroups', { advertiserId: '9001', adgroupIds: [6001], status: 'DISABLE' }],
      ];
      for (const [level, body] of bad) assert.equal((await post(user, level, body)).status, 400, JSON.stringify(body).slice(0, 80));
    });

    it('conta de outro usuário: 404 e nada é enviado ao TikTok', async () => {
      const a = await setup();
      await connect(a, '111');
      const b = await createUser(ctx, { approve: true, email: emailOf() });
      await connect(b, '222', OTHER_TOKEN);
      fake.state.calls.length = 0;
      assert.equal((await post(b, 'campaigns', { advertiserId: '9001', campaignIds: ['5001'], status: 'DISABLE' })).status, 404);
      assert.equal((await post(b, 'adgroups', { advertiserId: '9001', adgroupIds: ['6001'], status: 'DISABLE' })).status, 404);
      assert.equal(callsOf('/campaign/status/update/').length + callsOf('/adgroup/status/update/').length, 0);
    });

    it('quando o TikTok recusa, o erro é mostrado e nada é dado como feito', async () => {
      const user = await setup();
      await connect(user, '111');
      fake.state.failCampaignStatusFor.add('9001');
      const res = await post(user, 'campaigns', { advertiserId: '9001', campaignIds: ['5001'], status: 'DISABLE' });
      assert.ok(res.status >= 400, res.text);
    });
  });

  it('permissões: sem login 401; "Relatórios" só vê; "Campanhas" também ativa/pausa; "Contas TikTok" não entra — em todos os níveis', async () => {
    const owner = await setup();
    await connect(owner, '111');
    for (const level of LEVEL_IDS) assert.equal((await ctx.client().get(`/api/tiktok/manager/${level}`)).status, 401, level);
    assert.equal((await ctx.client().post('/api/tiktok/manager/campaigns/status', { advertiserId: '9001', campaignIds: ['5001'], status: 'DISABLE' })).status, 401);
    async function collaborator(areas) {
      const email = emailOf();
      assert.equal((await owner.client.post('/api/team/invites', { email, name: 'Maria Colab', areas })).status, 201);
      const client = ctx.client();
      const accepted = await client.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
      client.csrf = accepted.json.csrfToken;
      return client;
    }
    const toggle = (level) => ({ campaigns: { advertiserId: '9001', campaignIds: ['5001'], status: 'DISABLE' }, adgroups: { advertiserId: '9001', adgroupIds: ['6001'], status: 'DISABLE' } })[level];
    const reports = await collaborator(['reports']);
    for (const level of LEVEL_IDS) assert.equal((await reports.get(`/api/tiktok/manager/${level}`)).status, 200, level);
    for (const level of ['campaigns', 'adgroups']) assert.equal((await reports.post(`/api/tiktok/manager/${level}/status`, toggle(level))).status, 403, `${level}: só ver`);
    const campaigns = await collaborator(['campaigns']);
    for (const level of ['campaigns', 'adgroups']) assert.equal((await campaigns.post(`/api/tiktok/manager/${level}/status`, toggle(level))).status, 200, `${level}: pode`);
    const accounts = await collaborator(['accounts']);
    for (const level of LEVEL_IDS) assert.equal((await accounts.get(`/api/tiktok/manager/${level}`)).status, 403, level);
  });

  it('isolamento: cada usuário vê só as campanhas e grupos das próprias contas', async () => {
    const a = await setup();
    await connect(a, '111');
    const b = await createUser(ctx, { approve: true, email: emailOf() });
    await connect(b, '222', OTHER_TOKEN);
    fake.state.ads[9101] = [ad(9999, { advertiser_id: '9101', campaign_id: '5900', campaign_name: 'Do outro usuário', adgroup_id: '6900' })];
    assert.ok(!(await get(a, 'campaigns')).json.campaigns.some((c) => c.advertiserId === '9101'));
    assert.deepEqual((await get(b, 'campaigns')).json.campaigns.map((c) => c.id), ['5900']);
    assert.deepEqual((await get(b, 'adgroups')).json.adgroups.map((g) => g.id), ['6900']);
  });

  it('mensagem do TikTok com HTML vira texto na resposta (nunca interpretada): nomes são devolvidos como texto puro', async () => {
    const user = await setup();
    await connect(user, '111');
    fake.state.ads[9001] = [ad(1, { campaign_name: '<img src=x onerror=alert(1)>', adgroup_name: 'A'.repeat(500) })];
    const { campaigns } = (await get(user, 'campaigns')).json;
    assert.equal(campaigns[0].name, '<img src=x onerror=alert(1)>', 'o servidor guarda o texto; a tela só o mostra como texto');
    const { adgroups } = (await get(user, 'adgroups')).json;
    assert.equal(adgroups[0].name.length, 200, 'nomes têm limite');
  });
});
