import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FIELDS, defaultConfig, findField, isVisible, validateConfig } from '../shared/campaign-spec.js';
import { createTiktokClient } from '../src/modules/tiktok/tiktok.client.js';
import { buildAdGroupPayload, buildAdPayload, buildCampaignPayload } from '../src/modules/tiktok/tiktok.payloads.js';
import { completeConfig } from './campaign-fixtures.js';
import { GOOD_TOKEN, createFakeTiktok } from './fake-tiktok.js';

/** Campanha de catálogo válida (Vendas de produtos + catálogo), com ajustes por seção. */
const catalog = (over = {}) => validateConfig(completeConfig('PRODUCT_SALES', over), { requireComplete: true });
const valid = (over) => {
  const { config, errors } = catalog(over);
  assert.deepEqual(errors, [], JSON.stringify(errors));
  return config;
};
const paths = (over) => catalog(over).errors.map((e) => e.path).sort();

describe('Campanha de catálogo: regras do assistente (contrato oficial de Catalog Ads)', () => {
  it('a configuração completa de catálogo é válida e usa o catálogo e a BC dona dele', () => {
    const c = valid();
    assert.deepEqual([c.adGroup.catalogId, c.adGroup.catalogBcId, c.ad.format, c.ad.productSpecificType], ['777', '111', 'CATALOG_VIDEO', 'ALL']);
  });

  it('o orçamento da campanha e as categorias especiais NÃO existem em catálogo (CBO e categorias exigem allowlist): o orçamento fica no grupo', () => {
    const cfg = defaultConfig();
    cfg.campaign.objective = 'PRODUCT_SALES';
    assert.equal(isVisible(findField('campaign', 'budgetMode'), cfg), false);
    assert.equal(isVisible(findField('campaign', 'specialIndustries'), cfg), false);
    assert.equal(isVisible(findField('adGroup', 'budget'), cfg), true, 'o grupo leva o orçamento');
    cfg.campaign.objective = 'TRAFFIC';
    assert.equal(isVisible(findField('campaign', 'budgetMode'), cfg), true);
    // um orçamento de campanha enviado à força é descartado
    const forced = valid({ campaign: { budgetMode: 'BUDGET_MODE_DAY', budget: 9000, specialIndustries: ['CREDIT'] } });
    assert.deepEqual([forced.campaign.budgetMode, forced.campaign.budget, forced.campaign.specialIndustries], ['BUDGET_MODE_INFINITE', undefined, undefined]);
  });

  it('catálogo e BC dona do catálogo são obrigatórios (o TikTok exige catalog_authorized_bc_id para catálogo de uma BC)', () => {
    const cfg = completeConfig('PRODUCT_SALES');
    delete cfg.adGroup.catalogId; delete cfg.adGroup.catalogBcId;
    const errors = validateConfig(cfg, { requireComplete: true }).errors.map((e) => e.path);
    assert.ok(errors.includes('adGroup.catalogId') && errors.includes('adGroup.catalogBcId'));
    assert.ok(paths({ adGroup: { catalogBcId: 'abc' } }).includes('adGroup.catalogBcId'), 'só números');
  });

  it('metas: Cliques, Conversões e Valor; o pixel só existe nas metas de conversão', () => {
    const cfg = defaultConfig();
    cfg.campaign.objective = 'PRODUCT_SALES';
    const pixel = findField('adGroup', 'pixelId');
    cfg.adGroup.optimizationGoal = 'CLICK';
    assert.equal(isVisible(pixel, cfg), false, 'com Cliques o TikTok recusa o pixel');
    for (const goal of ['CONVERT', 'VALUE']) { cfg.adGroup.optimizationGoal = goal; assert.equal(isVisible(pixel, cfg), true, goal); }
    cfg.campaign.objective = 'WEB_CONVERSIONS';
    cfg.adGroup.optimizationGoal = 'CONVERT';
    assert.equal(isVisible(pixel, cfg), true, 'Conversões no site continua usando pixel');
    cfg.campaign.objective = 'TRAFFIC';
    assert.equal(isVisible(pixel, cfg), false);
    // meta Cliques sem pixel é válida; meta Conversões sem pixel não
    assert.deepEqual(paths({ adGroup: { optimizationGoal: 'CLICK', billingEvent: 'CPC', pixelId: undefined, optimizationEvent: undefined } }), []);
    const noPixel = completeConfig('PRODUCT_SALES'); delete noPixel.adGroup.pixelId;
    assert.ok(validateConfig(noPixel, { requireComplete: true }).errors.some((e) => e.path === 'adGroup.pixelId'));
  });

  it('combinações da meta com cobrança, evento, lance, ritmo e posicionamento seguem o contrato', () => {
    assert.ok(paths({ adGroup: { optimizationGoal: 'CLICK', billingEvent: 'OCPM' } }).includes('adGroup.billingEvent'), 'Cliques = CPC');
    assert.deepEqual(paths({ adGroup: { optimizationGoal: 'CLICK', billingEvent: 'CPC' } }), []);
    assert.ok(paths({ adGroup: { optimizationGoal: 'CONVERT', billingEvent: 'CPC' } }).includes('adGroup.billingEvent'), 'Conversão = oCPM');
    assert.ok(paths({ adGroup: { optimizationGoal: 'VALUE', optimizationEvent: 'ADD_TO_CART' } }).includes('adGroup.optimizationEvent'), 'Valor = Compra (geral)');
    assert.ok(paths({ adGroup: { optimizationGoal: 'VALUE', optimizationEvent: 'SHOPPING', bidType: 'BID_TYPE_CUSTOM', bidPrice: 500 } }).includes('adGroup.bidType'), 'Valor = menor custo');
    assert.deepEqual(paths({ adGroup: { optimizationGoal: 'VALUE', optimizationEvent: 'SHOPPING' } }), []);
    assert.ok(paths({ adGroup: { bidType: 'BID_TYPE_NO_BID', pacing: 'PACING_MODE_FAST' } }).includes('adGroup.pacing'), 'menor custo = ritmo padrão');
    assert.deepEqual(paths({ adGroup: { bidType: 'BID_TYPE_CUSTOM', bidPrice: 800, pacing: 'PACING_MODE_FAST' } }), []);
    assert.ok(paths({ adGroup: { placementType: 'PLACEMENT_TYPE_NORMAL', placements: ['PLACEMENT_TIKTOK', 'PLACEMENT_PANGLE'] } }).includes('adGroup.placements'), 'sem Pangle');
    assert.deepEqual(paths({ adGroup: { placementType: 'PLACEMENT_TYPE_NORMAL', placements: ['PLACEMENT_TIKTOK'] } }), []);
  });

  it('formatos do anúncio: vídeo do catálogo ou vídeo único; imagem e carrossel genéricos NÃO existem em catálogo', () => {
    assert.deepEqual(FIELDS.ad.find((f) => f.key === 'format').optionsBy.map.PRODUCT_SALES.map((o) => o.value), ['CATALOG_VIDEO', 'SINGLE_VIDEO']);
    assert.deepEqual(FIELDS.ad.find((f) => f.key === 'format').optionsBy.map.TRAFFIC.map((o) => o.value), ['SINGLE_VIDEO', 'SINGLE_IMAGE', 'CAROUSEL_ADS']);
    assert.equal(validateConfig({ campaign: { objective: 'PRODUCT_SALES' }, ad: { format: 'CAROUSEL_ADS', imageCreativeIds: [1, 2] } }).config.ad.format, 'SINGLE_VIDEO', 'o carrossel de imagens não existe em catálogo');
    assert.ok(paths({ ad: { identityType: 'TT_USER' } }).includes('ad.identityType'), 'vídeo do catálogo exige identidade personalizada');
    // vídeo único: o seu vídeo + capa obrigatória
    assert.deepEqual(paths({ ad: { format: 'SINGLE_VIDEO', videoCreativeId: 1, coverCreativeId: 2, identityType: 'TT_USER' } }), []);
    const noCover = validateConfig(completeConfig('PRODUCT_SALES', { ad: { format: 'SINGLE_VIDEO', videoCreativeId: 1 } }), { requireComplete: true }).errors.map((e) => e.path);
    assert.ok(noCover.includes('ad.coverCreativeId'), 'a capa é obrigatória em catálogo');
    const noVideo = validateConfig(completeConfig('PRODUCT_SALES', { ad: { format: 'SINGLE_VIDEO', coverCreativeId: 2 } }), { requireComplete: true }).errors.map((e) => e.path);
    assert.ok(noVideo.includes('ad.videoCreativeId'));
    // vídeo do catálogo não pede (e descarta) vídeo e capa
    const generated = valid({ ad: { format: 'CATALOG_VIDEO', videoCreativeId: 1, coverCreativeId: 2 } });
    assert.deepEqual([generated.ad.videoCreativeId, generated.ad.coverCreativeId], [undefined, undefined]);
  });

  it('produtos do anúncio: todos, um conjunto (ID obrigatório) ou até 20 SKUs (obrigatórios, sem repetir, sem emoji)', () => {
    assert.deepEqual(paths({ ad: { productSpecificType: 'ALL' } }), []);
    assert.deepEqual(paths({ ad: { productSpecificType: 'PRODUCT_SET' } }), ['ad.productSetId']);
    assert.deepEqual(paths({ ad: { productSpecificType: 'PRODUCT_SET', productSetId: '4242' } }), []);
    assert.deepEqual(paths({ ad: { productSpecificType: 'PRODUCT_SET', productSetId: 'x' } }), ['ad.productSetId']);
    assert.deepEqual(paths({ ad: { productSpecificType: 'CUSTOMIZED_PRODUCTS' } }), ['ad.skuIds']);
    assert.deepEqual(paths({ ad: { productSpecificType: 'CUSTOMIZED_PRODUCTS', skuIds: ['A-1', 'B 2'] } }), []);
    assert.deepEqual(paths({ ad: { productSpecificType: 'CUSTOMIZED_PRODUCTS', skuIds: Array.from({ length: 21 }, (_, i) => `S${i}`) } }), ['ad.skuIds'], 'até 20');
    assert.deepEqual(paths({ ad: { productSpecificType: 'CUSTOMIZED_PRODUCTS', skuIds: Array.from({ length: 20 }, (_, i) => `S${i}`) } }), []);
    assert.deepEqual(paths({ ad: { productSpecificType: 'CUSTOMIZED_PRODUCTS', skuIds: ['camisa 😀'] } }), ['ad.skuIds']);
    assert.deepEqual(paths({ ad: { productSpecificType: 'CUSTOMIZED_PRODUCTS', skuIds: ['a'.repeat(101)] } }), ['ad.skuIds']);
    assert.deepEqual(validateConfig({ ...completeConfig('PRODUCT_SALES'), ad: { ...completeConfig('PRODUCT_SALES').ad, productSpecificType: 'CUSTOMIZED_PRODUCTS', skuIds: ['A', 'A', 'B'] } }).config.ad.skuIds, ['A', 'B'], 'repetidos viram um só');
    // trocar de seleção descarta os campos da outra
    const all = valid({ ad: { productSpecificType: 'ALL', productSetId: '4242', skuIds: ['A'] } });
    assert.deepEqual([all.ad.productSetId, all.ad.skuIds], [undefined, undefined]);
  });

  it('botão de chamada para ação e URL da loja são obrigatórios em catálogo', () => {
    const cfg = completeConfig('PRODUCT_SALES'); delete cfg.ad.callToAction; delete cfg.ad.landingPageUrl;
    const errors = validateConfig(cfg, { requireComplete: true }).errors.map((e) => e.path);
    assert.ok(errors.includes('ad.callToAction') && errors.includes('ad.landingPageUrl'));
  });

  it('um valor que nunca foi opção (ex.: formato "GIF") é erro; só valor que valia para o objetivo anterior é descartado sem erro', () => {
    assert.ok(validateConfig({ campaign: { objective: 'TRAFFIC' }, ad: { format: 'GIF' } }).errors.some((e) => e.path === 'ad.format'));
    const switched = validateConfig({ campaign: { objective: 'PRODUCT_SALES' }, ad: { format: 'CAROUSEL_ADS' } });
    assert.ok(!switched.errors.some((e) => e.path === 'ad.format'), 'carrossel valia em Tráfego: trocar o objetivo só descarta');
    assert.equal(switched.config.ad.format, 'SINGLE_VIDEO', 'e volta ao padrão');
  });
});

describe('Campanha de catálogo: requisições ao TikTok (formato idêntico ao da documentação oficial)', () => {
  const campaignOf = (over) => buildCampaignPayload('9001', valid(over));
  const groupOf = (over) => buildAdGroupPayload('9001', '7001', valid(over), { timezone: 'America/Sao_Paulo', now: new Date('2026-11-24T12:00:00Z') });
  const adOf = (over, assets) => buildAdPayload('9001', '7002', valid(over), assets).creatives[0];

  it('CAMPANHA: objective PRODUCT_SALES com campaign_product_source CATALOG, pausada e SEM otimização de orçamento', () => {
    assert.deepEqual(campaignOf(), { advertiser_id: '9001', campaign_name: 'Black Friday', objective_type: 'PRODUCT_SALES', campaign_product_source: 'CATALOG', budget_mode: 'BUDGET_MODE_INFINITE', operation_status: 'DISABLE' });
    const other = buildCampaignPayload('9001', validateConfig(completeConfig('TRAFFIC')).config);
    assert.equal('campaign_product_source' in other, false, 'os outros objetivos não mudam');
  });

  it('GRUPO (meta Conversões): VIDEO + CATALOG + catálogo e BC, WEBSITE, pixel + evento, oCPM, retargeting OFF, sem identidade', () => {
    const g = groupOf();
    assert.deepEqual(
      { shopping_ads_type: g.shopping_ads_type, product_source: g.product_source, catalog_id: g.catalog_id, catalog_authorized_bc_id: g.catalog_authorized_bc_id, promotion_type: g.promotion_type, pixel_id: g.pixel_id, optimization_event: g.optimization_event, optimization_goal: g.optimization_goal, billing_event: g.billing_event, shopping_ads_retargeting_type: g.shopping_ads_retargeting_type, bid_type: g.bid_type },
      { shopping_ads_type: 'VIDEO', product_source: 'CATALOG', catalog_id: '777', catalog_authorized_bc_id: '111', promotion_type: 'WEBSITE', pixel_id: '123456', optimization_event: 'SHOPPING', optimization_goal: 'CONVERT', billing_event: 'OCPM', shopping_ads_retargeting_type: 'OFF', bid_type: 'BID_TYPE_NO_BID' },
    );
    for (const key of ['identity_type', 'identity_id', 'store_id', 'creative_material_mode', 'auto_targeting_enabled']) assert.equal(key in g, false, `${key} não é enviado`);
    assert.equal(g.budget_mode, 'BUDGET_MODE_DAY');
    assert.equal(g.budget, 50, 'o orçamento fica no grupo');
    assert.equal(g.operation_status, 'DISABLE');
  });

  it('GRUPO (meta Cliques): CPC, bid_price no lance manual e NENHUM pixel nem evento', () => {
    const g = groupOf({ adGroup: { optimizationGoal: 'CLICK', billingEvent: 'CPC', pixelId: undefined, optimizationEvent: undefined, bidType: 'BID_TYPE_CUSTOM', bidPrice: 120 } });
    assert.deepEqual([g.optimization_goal, g.billing_event, g.bid_type, g.bid_price, 'conversion_bid_price' in g, 'pixel_id' in g, 'optimization_event' in g], ['CLICK', 'CPC', 'BID_TYPE_CUSTOM', 1.2, false, false, false]);
  });

  it('GRUPO (Conversões com lance manual): o valor vai em conversion_bid_price, nunca em bid_price', () => {
    const g = groupOf({ adGroup: { bidType: 'BID_TYPE_CUSTOM', bidPrice: 800 } });
    assert.deepEqual([g.conversion_bid_price, 'bid_price' in g], [8, false]);
    // fora do catálogo nada muda: Conversões no site continua com bid_price
    const web = buildAdGroupPayload('9001', '7001', validateConfig(completeConfig('WEB_CONVERSIONS', { adGroup: { bidType: 'BID_TYPE_CUSTOM', bidPrice: 800 } })).config);
    assert.deepEqual([web.bid_price, 'conversion_bid_price' in web, 'shopping_ads_type' in web, 'catalog_id' in web], [8, false, false, false]);
  });

  it('GRUPO (meta Valor/ROAS): menor custo + deep_bid_type VO_HIGHEST_VALUE e evento SHOPPING', () => {
    const g = groupOf({ adGroup: { optimizationGoal: 'VALUE', optimizationEvent: 'SHOPPING' } });
    assert.deepEqual([g.optimization_goal, g.optimization_event, g.bid_type, g.deep_bid_type, g.billing_event, 'bid_price' in g, 'conversion_bid_price' in g], ['VALUE', 'SHOPPING', 'BID_TYPE_NO_BID', 'VO_HIGHEST_VALUE', 'OCPM', false, false]);
  });

  it('ANÚNCIO (vídeo do catálogo): CATALOG_VIDEOS, todos os produtos, destino dinâmico nas conversões, URL como plano B, sem vídeo nem capa', () => {
    const c = adOf();
    assert.deepEqual(
      { ad_format: c.ad_format, vertical_video_strategy: c.vertical_video_strategy, dynamic_format: c.dynamic_format, catalog_id: c.catalog_id, product_specific_type: c.product_specific_type, dynamic_destination: c.dynamic_destination, shopping_ads_fallback_type: c.shopping_ads_fallback_type, landing_page_url: c.landing_page_url, call_to_action: c.call_to_action, identity_type: c.identity_type, ad_text: c.ad_text },
      { ad_format: 'SINGLE_VIDEO', vertical_video_strategy: 'CATALOG_VIDEOS', dynamic_format: 'UNSET', catalog_id: '777', product_specific_type: 'ALL', dynamic_destination: 'DLP', shopping_ads_fallback_type: 'CUSTOM', landing_page_url: 'https://loja.example.com/promo', call_to_action: 'SHOP_NOW', identity_type: 'CUSTOMIZED_USER', ad_text: 'Aproveite agora!' },
    );
    for (const key of ['video_id', 'image_ids', 'product_set_id', 'sku_ids', 'music_id', 'card_id']) assert.equal(key in c, false, key);
    assert.equal(adOf({ adGroup: { optimizationGoal: 'CLICK', billingEvent: 'CPC', pixelId: undefined, optimizationEvent: undefined } }).dynamic_destination, 'UNSET', 'Cliques: sem destino dinâmico');
  });

  it('ANÚNCIO (conjunto e SKUs): product_set_id só com PRODUCT_SET e sku_ids só com CUSTOMIZED_PRODUCTS', () => {
    const set = adOf({ ad: { productSpecificType: 'PRODUCT_SET', productSetId: '4242' } });
    assert.deepEqual([set.product_specific_type, set.product_set_id, 'sku_ids' in set], ['PRODUCT_SET', '4242', false]);
    const skus = adOf({ ad: { productSpecificType: 'CUSTOMIZED_PRODUCTS', skuIds: ['A-1', 'B-2'] } });
    assert.deepEqual([skus.product_specific_type, skus.sku_ids, 'product_set_id' in skus], ['CUSTOMIZED_PRODUCTS', ['A-1', 'B-2'], false]);
  });

  it('ANÚNCIO (vídeo único): vertical_video_strategy SINGLE_VIDEO com video_id e a capa em image_ids', () => {
    const c = adOf({ ad: { format: 'SINGLE_VIDEO', videoCreativeId: 1, coverCreativeId: 2 } }, { videoId: 'v10033g5000abc', coverImageId: 'ad-site-i18n/cover1' });
    assert.deepEqual([c.ad_format, c.vertical_video_strategy, c.video_id, c.image_ids], ['SINGLE_VIDEO', 'SINGLE_VIDEO', 'v10033g5000abc', ['ad-site-i18n/cover1']]);
  });

  describe('o TikTok (simulado com o contrato oficial) aceita a campanha inteira', () => {
    let fake;
    let api;
    before(() => {
      fake = createFakeTiktok();
      api = createTiktokClient({ config: { tiktok: { apiBase: 'https://business-api.tiktok.com' } }, fetchFn: fake.fetchFn });
    });

    async function publish(over, assets = {}) {
      const config = valid(over);
      const campaignId = await api.createCampaign(GOOD_TOKEN, buildCampaignPayload('9001', config));
      const adGroupId = await api.createAdGroup(GOOD_TOKEN, buildAdGroupPayload('9001', campaignId, config, { timezone: 'America/Sao_Paulo' }));
      return api.createAd(GOOD_TOKEN, buildAdPayload('9001', adGroupId, config, assets));
    }

    const cases = {
      'Conversões + vídeo do catálogo + todos os produtos': {},
      'Cliques + CPC + lance manual': { adGroup: { optimizationGoal: 'CLICK', billingEvent: 'CPC', pixelId: undefined, optimizationEvent: undefined, bidType: 'BID_TYPE_CUSTOM', bidPrice: 150 } },
      'Cliques sem lance manual': { adGroup: { optimizationGoal: 'CLICK', billingEvent: 'CPC', pixelId: undefined, optimizationEvent: undefined } },
      'Conversões + lance manual (conversion_bid_price)': { adGroup: { bidType: 'BID_TYPE_CUSTOM', bidPrice: 900, pacing: 'PACING_MODE_FAST' } },
      'Valor (ROAS)': { adGroup: { optimizationGoal: 'VALUE', optimizationEvent: 'SHOPPING' } },
      'posicionamento só TikTok': { adGroup: { placementType: 'PLACEMENT_TYPE_NORMAL', placements: ['PLACEMENT_TIKTOK'] } },
      'conjunto de produtos': { ad: { productSpecificType: 'PRODUCT_SET', productSetId: '4242' } },
      'até 20 SKUs': { ad: { productSpecificType: 'CUSTOMIZED_PRODUCTS', skuIds: Array.from({ length: 20 }, (_, i) => `SKU-${i}`) } },
    };
    for (const [name, over] of Object.entries(cases)) {
      it(name, async () => {
        const id = await publish(over);
        assert.match(String(id), /^\d+$/);
      });
    }

    it('vídeo único com a capa', async () => {
      const id = await publish({ ad: { format: 'SINGLE_VIDEO', videoCreativeId: 1, coverCreativeId: 2 } }, { videoId: 'v10033g5000abc', coverImageId: 'ad-site-i18n/cover1' });
      assert.match(String(id), /^\d+$/);
    });

    it('o simulado estrito RECUSA o que fugir do contrato (a prova de que ele confere): sem catálogo da BC, sem campaign_product_source e com CBO', async () => {
      const config = valid();
      await assert.rejects(api.createCampaign(GOOD_TOKEN, { ...buildCampaignPayload('9001', config), campaign_product_source: undefined }), /campaign_product_source/);
      await assert.rejects(api.createCampaign(GOOD_TOKEN, { ...buildCampaignPayload('9001', config), budget_optimize_on: true }), /Budget Optimization/);
      const campaignId = await api.createCampaign(GOOD_TOKEN, buildCampaignPayload('9001', config));
      const group = buildAdGroupPayload('9001', campaignId, config, { timezone: 'UTC' });
      await assert.rejects(api.createAdGroup(GOOD_TOKEN, { ...group, catalog_authorized_bc_id: undefined }), /catalog_authorized_bc_id/);
      await assert.rejects(api.createAdGroup(GOOD_TOKEN, { ...group, shopping_ads_type: undefined }), /shopping_ads_type/);
      await assert.rejects(api.createAdGroup(GOOD_TOKEN, { ...group, optimization_event: undefined }), /pixel_id and optimization_event/);
      const adGroupId = await api.createAdGroup(GOOD_TOKEN, group);
      const ad = buildAdPayload('9001', adGroupId, config).creatives[0];
      await assert.rejects(api.createAd(GOOD_TOKEN, { advertiser_id: '9001', adgroup_id: adGroupId, creatives: [{ ...ad, product_specific_type: undefined }] }), /product_specific_type/);
      await assert.rejects(api.createAd(GOOD_TOKEN, { advertiser_id: '9001', adgroup_id: adGroupId, creatives: [{ ...ad, call_to_action: undefined }] }), /call_to_action/);
      await assert.rejects(api.createAd(GOOD_TOKEN, { advertiser_id: '9001', adgroup_id: adGroupId, creatives: [{ ...ad, catalog_id: '999' }] }), /catalog_id must match/);
    });
  });
});
