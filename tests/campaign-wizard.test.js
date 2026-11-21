import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { OBJECTIVES, validateConfig } from '../shared/campaign-spec.js';
import { buildAdGroupPayload, buildAdPayload, buildCampaignPayload, formatInTimeZone, withUtm } from '../src/modules/tiktok/tiktok.payloads.js';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { completeConfig } from './campaign-fixtures.js';
import { uploadedId } from './media-fixtures.js';
import { createUser, loginAdmin, one, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, campaignPublish: 1000 };
const valid = (objective = 'TRAFFIC', over) => validateConfig(completeConfig(objective, over), { requireComplete: true, publish: true }).config;

describe('payloads da Marketing API', () => {
  it('campanha: pausada, orçamento em unidades e só campos presentes', () => {
    const noBudget = buildCampaignPayload('9001', valid('TRAFFIC'));
    assert.deepEqual(noBudget, { advertiser_id: '9001', campaign_name: 'Black Friday', objective_type: 'TRAFFIC', budget_mode: 'BUDGET_MODE_INFINITE', operation_status: 'DISABLE' });
    const withBudget = buildCampaignPayload('9001', valid('TRAFFIC', { campaign: { budgetMode: 'BUDGET_MODE_DAY', budget: 12345, specialIndustries: ['CREDIT'] } }));
    assert.equal(withBudget.budget, 123.45);
    assert.equal(withBudget.budget_optimize_on, true, 'orçamento na campanha liga a otimização de orçamento');
    assert.ok(!('budget_optimize_on' in noBudget));
    assert.deepEqual(withBudget.special_industries, ['CREDIT']);
    const app = buildCampaignPayload('9001', valid('APP_PROMOTION'));
    assert.equal(app.app_promotion_type, 'APP_INSTALL');
  });

  it('grupo de anúncios: público, agenda, lance e campos por objetivo', () => {
    const cfg = valid('WEB_CONVERSIONS', {
      adGroup: {
        locations: ['BR', 'PT'], gender: 'GENDER_FEMALE', ageGroups: ['AGE_25_34'], languages: ['pt'], operatingSystems: ['IOS'],
        scheduleType: 'SCHEDULE_START_END', scheduleStart: '2026-12-01T09:30', scheduleEnd: '2026-12-10T23:00',
        bidType: 'BID_TYPE_CUSTOM', bidPrice: 250, interestCategoryIds: ['111'], commentDisabled: true,
      },
    });
    const p = buildAdGroupPayload('9001', '7001', cfg);
    assert.equal(p.operation_status, 'DISABLE');
    assert.equal(p.campaign_id, '7001');
    assert.deepEqual(p.location_ids, ['3469034', '2264397']);
    assert.equal(p.budget_mode, 'BUDGET_MODE_DAY');
    assert.equal(p.budget, 50);
    assert.equal(p.schedule_start_time, '2026-12-01 09:30:00');
    assert.equal(p.schedule_end_time, '2026-12-10 23:00:00');
    assert.equal(p.bid_price, 2.5);
    assert.equal(p.pixel_id, '123456');
    assert.equal(p.optimization_event, 'SHOPPING');
    assert.equal(p.optimization_goal, 'CONVERT');
    assert.equal(p.billing_event, 'OCPM');
    assert.equal(p.comment_disabled, true);
    assert.equal(p.video_download_disabled, undefined);
    assert.equal(p.promotion_type, 'WEBSITE');
    assert.equal(p.app_id, undefined);
    assert.ok(!('placements' in p), 'automático não envia placements');
    assert.ok(!Object.values(p).some((v) => v === undefined || v === null || (Array.isArray(v) && !v.length)));
  });

  it('orçamento no nível da campanha: grupo não envia orçamento; FROM_NOW não envia datas', () => {
    const cfg = valid('TRAFFIC', { campaign: { budgetMode: 'BUDGET_MODE_DAY', budget: 9000 } });
    const p = buildAdGroupPayload('9001', '7001', cfg);
    assert.ok(!('budget' in p) && !('budget_mode' in p));
    assert.equal(p.schedule_type, 'SCHEDULE_FROM_NOW');
    assert.ok(!('schedule_end_time' in p));
    // início obrigatório também em "começar agora": agora + 5 min, no fuso da conta
    const at = new Date('2026-11-20T15:00:00Z');
    assert.equal(buildAdGroupPayload('9001', '7001', cfg, { timezone: 'America/Sao_Paulo', now: at }).schedule_start_time, '2026-11-20 12:05:00');
    assert.equal(buildAdGroupPayload('9001', '7001', cfg, { timezone: null, now: at }).schedule_start_time, '2026-11-20 15:05:00', 'sem fuso: UTC');
    assert.equal(buildAdGroupPayload('9001', '7001', cfg, { timezone: 'Fuso/Invalido', now: at }).schedule_start_time, '2026-11-20 15:05:00', 'fuso inválido: UTC');
  });

  it('promotion_type por objetivo', () => {
    assert.equal(buildAdGroupPayload('1', '2', valid('APP_PROMOTION')).promotion_type, 'APP_ANDROID');
    assert.equal(buildAdGroupPayload('1', '2', valid('APP_PROMOTION', { adGroup: { appPlatform: 'APP_IOS' } })).promotion_type, 'APP_IOS');
    assert.equal(buildAdGroupPayload('1', '2', valid('LEAD_GENERATION', { adGroup: { leadDestination: 'INSTANT_FORM', leadFormId: '88' } })).promotion_type, 'LEAD_GENERATION');
    const lead = valid('LEAD_GENERATION', { adGroup: { leadDestination: 'INSTANT_FORM', leadFormId: '88' } });
    assert.ok(!('lead_form_id' in buildAdGroupPayload('1', '2', lead)), 'não existe no grupo de anúncios (SDK oficial)');
    assert.equal(buildAdPayload('1', '2', lead).creatives[0].page_id, 88, 'vai no criativo como page_id numérico');
    assert.equal(buildAdGroupPayload('1', '2', valid('PRODUCT_SALES')).catalog_id, '777');
    const sales = valid('PRODUCT_SALES', { adGroup: { productSetId: '4242' } });
    assert.ok(!('product_set_id' in buildAdGroupPayload('1', '2', sales)), 'product_set_id não existe no grupo');
    assert.deepEqual([buildAdPayload('1', '2', sales).creatives[0].catalog_id, buildAdPayload('1', '2', sales).creatives[0].product_set_id], ['777', '4242']);
    assert.equal(buildAdGroupPayload('1', '2', valid('REACH', { adGroup: { frequency: 3, frequencyDays: 7 } })).frequency_schedule, 7);
  });

  it('anúncio: criativo por formato, UTM e rastreamento', () => {
    const video = buildAdPayload('9001', '7002', valid('TRAFFIC', { ad: { utmParams: 'utm_source=tiktok&utm_medium=cpc', callToAction: 'SHOP_NOW', clickTrackingUrl: 'https://t.example.com/c' } }), { videoId: 'v10033g5000abc' });
    assert.equal(video.adgroup_id, '7002');
    const c = video.creatives[0];
    assert.equal(c.video_id, 'v10033g5000abc', 'ID devolvido pelo TikTok ao receber o vídeo da biblioteca');
    assert.equal(c.call_to_action, 'SHOP_NOW');
    assert.equal(c.landing_page_url, 'https://loja.example.com/promo?utm_source=tiktok&utm_medium=cpc');
    assert.equal(c.click_tracking_url, 'https://t.example.com/c');
    assert.equal(c.display_name, 'Minha Loja');
    assert.equal(c.operation_status, 'DISABLE', 'criativo também nasce pausado (o padrão do TikTok seria ENABLE)');
    const carousel = buildAdPayload('9001', '7002', valid('TRAFFIC', { ad: { format: 'CAROUSEL_ADS', imageCreativeIds: [11, 12], videoCreativeId: undefined } }), { imageIds: ['ad-site-i18n/1', 'ad-site-i18n/2'], videoId: 'ignorado' }).creatives[0];
    assert.deepEqual(carousel.image_ids, ['ad-site-i18n/1', 'ad-site-i18n/2']);
    assert.ok(!('video_id' in carousel), 'formato carrossel não leva vídeo');
    const withCover = buildAdPayload('9001', '7002', valid('TRAFFIC'), { videoId: 'v10033g5000abc', coverImageId: 'ad-site-i18n/capa' }).creatives[0];
    assert.deepEqual(withCover.image_ids, ['ad-site-i18n/capa'], 'capa do vídeo');
    const app = buildAdPayload('9001', '7002', valid('APP_PROMOTION', { ad: { deeplinkUrl: 'myapp://p/1' } }), { videoId: 'v10033g5000abc' }).creatives[0];
    assert.equal(app.deeplink, 'myapp://p/1');
    assert.ok(!('landing_page_url' in app));
  });

  it('formatInTimeZone formata no fuso pedido', () => {
    const at = new Date('2026-01-05T02:30:00Z');
    assert.equal(formatInTimeZone(at, 'UTC'), '2026-01-05 02:30:00');
    assert.equal(formatInTimeZone(at, 'America/Sao_Paulo'), '2026-01-04 23:30:00');
    assert.equal(formatInTimeZone(at, 'Asia/Tokyo'), '2026-01-05 11:30:00');
    assert.equal(formatInTimeZone(at, undefined), '2026-01-05 02:30:00');
  });

  it('withUtm não duplica parâmetros existentes', () => {
    assert.equal(withUtm('https://a.com/?utm_source=x', 'utm_source=tiktok&utm_medium=cpc'), 'https://a.com/?utm_source=x&utm_medium=cpc');
    assert.equal(withUtm('https://a.com/', undefined), 'https://a.com/');
  });

  it('todos os objetivos geram payloads completos e sem valores vazios', () => {
    for (const { value } of OBJECTIVES) {
      const cfg = valid(value);
      for (const payload of [buildCampaignPayload('9001', cfg), buildAdGroupPayload('9001', '1', cfg), buildAdPayload('9001', '2', cfg).creatives[0]]) {
        assert.ok(Object.keys(payload).length > 3, value);
        assert.ok(!Object.values(payload).some((v) => v === undefined || v === null || v === ''), `${value}: ${JSON.stringify(payload)}`);
      }
    }
  });
});

describe('API de campanhas em formato assistente', () => {
  let ctx;
  let fake;
  let admin;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn });
    admin = await loginAdmin(ctx);
    assert.equal((await admin.post('/api/tiktok/business-centers', { name: 'Loja', bcId: '111', accessToken: GOOD_TOKEN, shared: true })).status, 201);
  });
  after(() => ctx.stop());

  const reset = async () => {
    fake.state.calls.length = 0;
    fake.state.failCreate.clear();
  };
  const body = (config) => ({ config });
  const mediaCache = new WeakMap();
  /** Configuração completa cujo vídeo é REAL e do próprio usuário (a biblioteca confere o dono do criativo). */
  const mk = async (client, objective = 'TRAFFIC', over = {}) => {
    if (!mediaCache.has(client)) mediaCache.set(client, await uploadedId(client, { type: 'mp4' }));
    return completeConfig(objective, { ...over, ad: { videoCreativeId: mediaCache.get(client), ...over.ad } });
  };

  it('exige login e conta aprovada', async () => {
    assert.equal((await ctx.client().post('/api/campaigns', body(completeConfig()))).status, 401);
    const pending = await createUser(ctx);
    assert.equal((await pending.client.post('/api/campaigns', body(completeConfig()))).status, 403);
    assert.equal((await pending.client.post('/api/campaigns/1/publish', { confirm: true })).status, 403);
  });

  it('salva rascunho incompleto, devolve configuração normalizada e deriva o resumo', async () => {
    const { client } = await createUser(ctx, { approve: true });
    const res = await client.post('/api/campaigns', body({ campaign: { objective: 'REACH' } }));
    assert.equal(res.status, 201);
    assert.equal(res.json.campaign.name, 'Rascunho sem nome');
    assert.equal(res.json.campaign.objective, 'REACH');
    assert.equal(res.json.campaign.status, 'draft');
    assert.equal(res.json.campaign.wizard, true);
    assert.equal(res.json.campaign.publish.status, 'none');
    assert.equal(res.json.campaign.config.campaign.budgetMode, 'BUDGET_MODE_INFINITE', 'defaults aplicados');

    const full = await client.post('/api/campaigns', body(await mk(client, 'TRAFFIC')));
    assert.equal(full.json.campaign.name, 'Black Friday');
    assert.equal(full.json.campaign.dailyBudget, 5000);
    assert.equal(full.json.campaign.advertiserId, '9001');
  });

  it('lista sem a configuração completa e detalhe com ela', async () => {
    const { client } = await createUser(ctx, { approve: true });
    const { id } = (await client.post('/api/campaigns', body(await mk(client)))).json.campaign;
    const list = (await client.get('/api/campaigns')).json.campaigns;
    assert.equal(list.length, 1);
    assert.ok(!('config' in list[0]));
    const detail = (await client.get(`/api/campaigns/${id}`)).json.campaign;
    assert.equal(detail.config.adGroup.locations[0], 'BR');
  });

  it('rejeita configuração inválida com a lista de campos (details)', async () => {
    const { client } = await createUser(ctx, { approve: true });
    const cfg = await mk(client);
    cfg.ad.landingPageUrl = 'javascript:alert(1)';
    cfg.adGroup.budget = -5;
    cfg.campaign.name = 'x';
    const res = await client.post('/api/campaigns', body(cfg));
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'validation_error');
    const paths = res.json.error.details.map((d) => d.path).sort();
    assert.deepEqual(paths, ['ad.landingPageUrl', 'adGroup.budget', 'campaign.name']);
    assert.equal((await client.post('/api/campaigns', body({}))).json.error.details[0].path, 'campaign.objective');
    assert.equal((await client.post('/api/campaigns', body('texto'))).status, 400);
    assert.equal((await client.get('/api/campaigns')).json.campaigns.length, 0, 'nada foi salvo');
  });

  it('descarta campos desconhecidos (mass assignment) e não persiste lixo', async () => {
    const { client, id: userId } = await createUser(ctx, { approve: true });
    const cfg = await mk(client);
    cfg.campaign.status = 'active';
    cfg.hack = { a: 1 };
    const res = await client.post('/api/campaigns', { config: cfg, status: 'active', userId: 1, tiktok_campaign_id: '999' });
    assert.equal(res.status, 201);
    assert.equal(res.json.campaign.status, 'draft');
    assert.equal(res.json.campaign.publish.status, 'none');
    assert.equal(res.json.campaign.config.hack, undefined);
    assert.equal(res.json.campaign.config.campaign.status, undefined);
    assert.equal((await one(ctx.db, 'SELECT user_id FROM campaigns WHERE id = $1', [res.json.campaign.id])).user_id, userId);
  });

  it('edita o rascunho; troca de objetivo descarta o que não vale mais', async () => {
    const { client } = await createUser(ctx, { approve: true });
    const { id } = (await client.post('/api/campaigns', body(await mk(client, 'WEB_CONVERSIONS')))).json.campaign;
    const cfg = await mk(client, 'WEB_CONVERSIONS');
    cfg.campaign.objective = 'REACH';
    const res = await client.put(`/api/campaigns/${id}`, body(cfg));
    assert.equal(res.status, 200);
    assert.equal(res.json.campaign.objective, 'REACH');
    assert.equal(res.json.campaign.config.adGroup.pixelId, undefined);
    assert.equal(res.json.campaign.config.adGroup.optimizationGoal, undefined);
  });

  it('isola campanhas entre usuários (sem IDOR) também para o assistente e a publicação', async () => {
    const a = await createUser(ctx, { approve: true });
    const b = await createUser(ctx, { approve: true });
    const { id } = (await a.client.post('/api/campaigns', body(await mk(a.client)))).json.campaign;
    await reset();
    assert.equal((await b.client.get(`/api/campaigns/${id}`)).status, 404);
    assert.equal((await b.client.put(`/api/campaigns/${id}`, body(completeConfig()))).status, 404);
    assert.equal((await b.client.post(`/api/campaigns/${id}/publish`, { confirm: true })).status, 404);
    assert.equal((await b.client.delete(`/api/campaigns/${id}`)).status, 404);
    assert.equal(fake.state.calls.length, 0);
  });

  it('exige CSRF e aceita corpo de até 64 kb (recusa maior)', async () => {
    const { client } = await createUser(ctx, { approve: true });
    assert.equal((await client.post('/api/campaigns', body(completeConfig()), { withCsrf: false })).json.error.code, 'bad_csrf');
    const big = completeConfig();
    big.ad.text = 'x'.repeat(70_000);
    assert.equal((await client.post('/api/campaigns', body(big))).status, 413);
    // lista de IDs no limite continua cabendo no corpo
    const heavy = await mk(client);
    heavy.adGroup.interestCategoryIds = Array.from({ length: 50 }, (_, i) => String(1000000000 + i));
    heavy.adGroup.audienceIds = Array.from({ length: 50 }, (_, i) => String(2000000000 + i));
    assert.equal((await client.post('/api/campaigns', body(heavy))).status, 201);
  });

  describe('publicação no TikTok', () => {
    const draft = async (client, objective = 'TRAFFIC', over) => (await client.post('/api/campaigns', body(await mk(client, objective, over)))).json.campaign;

    it('cria campanha, grupo e anúncio PAUSADOS e registra os IDs', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const { id } = await draft(client);
      await reset();
      const res = await client.post(`/api/campaigns/${id}/publish`, { confirm: true });
      assert.equal(res.status, 200);
      assert.equal(res.json.campaign.publish.status, 'published');
      assert.equal(res.json.campaign.status, 'paused');
      assert.ok(res.json.campaign.publish.campaignId && res.json.campaign.publish.adGroupId && res.json.campaign.publish.adId);
      assert.ok(res.json.campaign.publish.publishedAt);

      const [c, g, a] = ['/campaign/create/', '/adgroup/create/', '/ad/create/'].map((p) => fake.callsTo(p)[0]);
      assert.equal(c.method, 'POST');
      assert.equal(c.token, GOOD_TOKEN);
      assert.equal(c.body.operation_status, 'DISABLE');
      assert.equal(g.body.operation_status, 'DISABLE');
      assert.equal(g.body.campaign_id, res.json.campaign.publish.campaignId, 'o grupo usa o ID da campanha criada');
      assert.equal(a.body.adgroup_id, res.json.campaign.publish.adGroupId);
      assert.equal(c.body.advertiser_id, '9001');
      assert.ok(!JSON.stringify(res.json).includes(GOOD_TOKEN));
    });

    it('exige confirmação explícita e não chama o TikTok sem ela', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const { id } = await draft(client);
      await reset();
      assert.equal((await client.post(`/api/campaigns/${id}/publish`, {})).json.error.code, 'confirmation_required');
      assert.equal((await client.post(`/api/campaigns/${id}/publish`, { confirm: 'true' })).status, 400);
      assert.equal(fake.state.calls.length, 0);
    });

    it('valida tudo no servidor antes de publicar (rascunho incompleto -> 400 com details)', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const { id } = (await client.post('/api/campaigns', body({ campaign: { objective: 'TRAFFIC', name: 'Incompleta' } }))).json.campaign;
      await reset();
      const res = await client.post(`/api/campaigns/${id}/publish`, { confirm: true });
      assert.equal(res.status, 400);
      const paths = res.json.error.details.map((d) => d.path);
      assert.ok(paths.includes('account.advertiserId') && paths.includes('adGroup.locations') && paths.includes('ad.text'));
      assert.equal(fake.state.calls.length, 0);
    });

    it('só publica em conta de anúncio de uma Business Center cadastrada', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const { id } = await draft(client, 'TRAFFIC', { account: { advertiserId: '123456' } });
      await reset();
      const res = await client.post(`/api/campaigns/${id}/publish`, { confirm: true });
      assert.equal(res.status, 404);
      assert.equal(fake.callsTo('/campaign/create/').length, 0);
    });

    it('é idempotente: segunda publicação é recusada (409) e a campanha publicada não pode ser editada', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const { id } = await draft(client);
      await client.post(`/api/campaigns/${id}/publish`, { confirm: true });
      await reset();
      assert.equal((await client.post(`/api/campaigns/${id}/publish`, { confirm: true })).status, 409);
      const edit = await client.put(`/api/campaigns/${id}`, body(await mk(client)));
      assert.equal(edit.status, 409);
      assert.equal(edit.json.error.code, 'already_published');
      assert.equal(fake.state.calls.length, 0);
      assert.equal((await client.delete(`/api/campaigns/${id}`)).status, 204, 'pode remover o registro local');
    });

    it('falha no meio: registra o que foi criado e a nova tentativa RETOMA sem duplicar', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const { id } = await draft(client);
      await reset();
      fake.state.failCreate.add('ad');
      const failed = await client.post(`/api/campaigns/${id}/publish`, { confirm: true });
      assert.equal(failed.status, 502);
      assert.match(failed.json.error.message, /Identity not found/);

      let detail = (await client.get(`/api/campaigns/${id}`)).json.campaign;
      assert.equal(detail.publish.status, 'partial');
      assert.ok(detail.publish.campaignId && detail.publish.adGroupId && !detail.publish.adId);
      assert.match(detail.publish.error, /Identity not found/);
      assert.equal(detail.status, 'draft');

      fake.state.failCreate.clear();
      const created = { c: fake.callsTo('/campaign/create/').length, g: fake.callsTo('/adgroup/create/').length };
      const retry = await client.post(`/api/campaigns/${id}/publish`, { confirm: true });
      assert.equal(retry.status, 200);
      assert.equal(fake.callsTo('/campaign/create/').length, created.c, 'campanha não foi recriada');
      assert.equal(fake.callsTo('/adgroup/create/').length, created.g, 'grupo não foi recriado');
      assert.equal(fake.callsTo('/ad/create/').length, 2, 'só o anúncio foi tentado de novo');
      detail = (await client.get(`/api/campaigns/${id}`)).json.campaign;
      assert.equal(detail.publish.status, 'published');
      assert.equal(detail.publish.error, null);
    });

    it('publicação parcial: níveis já criados ficam travados na edição; o anúncio pode ser corrigido', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const { id } = await draft(client);
      fake.state.failCreate.add('ad');
      await client.post(`/api/campaigns/${id}/publish`, { confirm: true });
      fake.state.failCreate.clear();

      const edited = await mk(client, 'TRAFFIC', { campaign: { name: 'Nome alterado' }, adGroup: { name: 'Grupo alterado' }, ad: { identityId: 'id-corrigido' } });
      const res = await client.put(`/api/campaigns/${id}`, body(edited));
      assert.equal(res.status, 200);
      assert.equal(res.json.campaign.config.campaign.name, 'Black Friday', 'campanha já criada não muda');
      assert.equal(res.json.campaign.config.adGroup.name, 'Grupo 1', 'grupo já criado não muda');
      assert.equal(res.json.campaign.config.ad.identityId, 'id-corrigido', 'anúncio ainda editável');

      await reset();
      await client.post(`/api/campaigns/${id}/publish`, { confirm: true });
      assert.equal(fake.callsTo('/ad/create/')[0].body.creatives[0].identity_id, 'id-corrigido');
    });

    it('publicações simultâneas da mesma campanha: uma vence, a outra recebe 409 e NADA é duplicado no TikTok', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const { id } = await draft(client);
      await reset();
      fake.state.createDelayMs = 80;
      try {
        const [x, y, z] = await Promise.all([
          client.post(`/api/campaigns/${id}/publish`, { confirm: true }),
          client.post(`/api/campaigns/${id}/publish`, { confirm: true }),
          client.post(`/api/campaigns/${id}/publish`, { confirm: true }),
        ]);
        assert.deepEqual([x.status, y.status, z.status].sort(), [200, 409, 409]);
        const blocked = [x, y, z].find((r) => r.status === 409);
        assert.ok(['publish_in_progress', 'already_published'].includes(blocked.json.error.code));
        assert.equal(fake.callsTo('/campaign/create/').length, 1, 'uma única campanha criada');
        assert.equal(fake.callsTo('/adgroup/create/').length, 1);
        assert.equal(fake.callsTo('/ad/create/').length, 1);
      } finally {
        fake.state.createDelayMs = 0;
      }
    });

    it('durante a publicação não é possível editar nem excluir; depois que termina, a trava é liberada', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const { id } = await draft(client);
      await reset();
      fake.state.createDelayMs = 100;
      try {
        const publishing = client.post(`/api/campaigns/${id}/publish`, { confirm: true });
        await new Promise((r) => setTimeout(r, 40));
        const edit = await client.put(`/api/campaigns/${id}`, body(await mk(client, 'TRAFFIC', { campaign: { name: 'Mudança no meio' } })));
        const del = await client.delete(`/api/campaigns/${id}`);
        assert.equal(edit.json.error.code, 'publish_in_progress');
        assert.equal(del.json.error.code, 'publish_in_progress');
        assert.equal((await publishing).status, 200);
      } finally {
        fake.state.createDelayMs = 0;
      }
      assert.equal((await client.get(`/api/campaigns/${id}`)).json.campaign.config.campaign.name, 'Black Friday');
      assert.equal((await client.delete(`/api/campaigns/${id}`)).status, 204, 'trava liberada');
    });

    it('a trava é liberada também quando a publicação falha (permite tentar de novo)', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const { id } = await draft(client);
      await reset();
      fake.state.failCreate.add('campaign');
      assert.equal((await client.post(`/api/campaigns/${id}/publish`, { confirm: true })).status, 502);
      fake.state.failCreate.clear();
      assert.equal((await client.post(`/api/campaigns/${id}/publish`, { confirm: true })).status, 200);
    });

    it('falha ao criar a campanha: nada registrado, mensagem do TikTok exibível', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const { id } = await draft(client);
      fake.state.failCreate.add('campaign');
      const res = await client.post(`/api/campaigns/${id}/publish`, { confirm: true });
      assert.equal(res.status, 502);
      const detail = (await client.get(`/api/campaigns/${id}`)).json.campaign;
      assert.equal(detail.publish.status, 'none');
      assert.match(detail.publish.error, /already exists/);
      fake.state.failCreate.clear();
    });

    it('publica todos os objetivos suportados', async () => {
      const { client } = await createUser(ctx, { approve: true });
      for (const { value } of OBJECTIVES) {
        const { id } = await draft(client, value);
        const res = await client.post(`/api/campaigns/${id}/publish`, { confirm: true });
        assert.equal(res.status, 200, `${value}: ${res.text}`);
        assert.equal(res.json.campaign.publish.status, 'published', value);
      }
    });

    it('token da BC revogado: 409 na primeira tentativa, BC marcada com erro, depois 404; trocar o token normaliza', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const { id } = await draft(client);
      const original = new Set(fake.state.validTokens);
      fake.state.validTokens.delete(GOOD_TOKEN);
      const first = await client.post(`/api/campaigns/${id}/publish`, { confirm: true });
      assert.equal(first.status, 409);
      assert.equal(first.json.error.code, 'tiktok_reauth');
      assert.equal((await admin.get('/api/tiktok/business-centers')).json.businessCenters[0].status, 'error');
      assert.equal((await client.get(`/api/campaigns/${id}`)).json.campaign.publish.status, 'none');
      assert.equal((await client.post(`/api/campaigns/${id}/publish`, { confirm: true })).status, 404, 'BC com erro não serve contas');

      fake.state.validTokens = original;
      const bcId = (await admin.get('/api/tiktok/business-centers')).json.businessCenters[0].id;
      assert.equal((await admin.patch(`/api/tiktok/business-centers/${bcId}`, { accessToken: GOOD_TOKEN })).status, 200);
      assert.equal((await client.post(`/api/campaigns/${id}/publish`, { confirm: true })).status, 200);
    });

    it('limita a frequência de publicações (429)', async () => {
      const limited = await startTestServer({ limits: { ...LIMITS, campaignPublish: 2 }, config: tiktokTestConfig(), fetchFn: fake.fetchFn, isolated: true });
      try {
        const adminLimited = await loginAdmin(limited);
        await adminLimited.post('/api/tiktok/business-centers', { name: 'Loja', bcId: '111', accessToken: GOOD_TOKEN, shared: true });
        const { client } = await createUser(limited, { approve: true });
        const { id } = (await client.post('/api/campaigns', body(await mk(client)))).json.campaign;
        assert.equal((await client.post(`/api/campaigns/${id}/publish`, {})).status, 400);
        assert.equal((await client.post(`/api/campaigns/${id}/publish`, {})).status, 400);
        const blocked = await client.post(`/api/campaigns/${id}/publish`, { confirm: true });
        assert.equal(blocked.status, 429);
      } finally {
        await limited.stop();
      }
    });
  });

  describe('compatibilidade com a API simples anterior', () => {
    it('continua criando, editando e removendo campanhas simples', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const created = await client.post('/api/campaigns', { name: 'Simples', objective: 'TRAFFIC', dailyBudget: 1000, status: 'active' });
      assert.equal(created.status, 201);
      assert.equal(created.json.campaign.wizard, false);
      const { id } = created.json.campaign;
      assert.equal((await client.put(`/api/campaigns/${id}`, { name: 'Simples 2', objective: 'REACH', dailyBudget: 2000, status: 'paused' })).json.campaign.name, 'Simples 2');
      assert.equal((await client.post(`/api/campaigns/${id}/publish`, { confirm: true })).json.error.code, 'legacy_campaign');
      assert.equal((await client.put(`/api/campaigns/${id}`, body(completeConfig()))).json.error.code, 'legacy_campaign');
      assert.equal((await client.delete(`/api/campaigns/${id}`)).status, 204);
    });
    it('campanha do assistente não aceita PUT simples', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const { id } = (await client.post('/api/campaigns', body(await mk(client)))).json.campaign;
      assert.equal((await client.put(`/api/campaigns/${id}`, { name: 'x1', objective: 'TRAFFIC', dailyBudget: 1 })).json.error.code, 'wizard_required');
    });
    it('o resumo do Início conta campanhas do assistente', async () => {
      const { client } = await createUser(ctx, { approve: true });
      await client.post('/api/campaigns', body(await mk(client)));
      assert.equal((await client.get('/api/campaigns/summary')).json.summary.total, 1);
    });
  });

  it('serve o módulo compartilhado ao navegador (e só ele)', async () => {
    const c = ctx.client();
    const res = await c.get('/shared/campaign-spec.js');
    assert.equal(res.status, 200);
    assert.match(res.text, /export function validateConfig/);
    assert.equal((await c.get('/shared/../package.json')).status === 200 && (await c.get('/shared/../package.json')).text.includes('"dependencies"'), false);
    assert.notEqual((await c.get('/shared/nao-existe.js')).status, 200);
  });
});
