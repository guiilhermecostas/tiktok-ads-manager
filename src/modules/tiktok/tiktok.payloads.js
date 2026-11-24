import { COUNTRIES, findField, isVisible } from '../../../shared/campaign-spec.js';

/**
 * Converte a configuração validada do assistente nos corpos de requisição da Marketing API v1.3.
 * Funções puras (fáceis de testar). TUDO é criado pausado (operation_status = DISABLE), inclusive o
 * criativo (o padrão do TikTok para anúncios seria ENABLE): nada gasta até o usuário ativar no TikTok.
 *
 * Os nomes dos campos seguem os modelos do SDK oficial (tiktok/tiktok-business-api-sdk).
 * Valores monetários são guardados em centavos e enviados em unidades da moeda da conta.
 */
const FROM_NOW_LEAD_MS = 5 * 60 * 1000; // "começar agora" = daqui a 5 min (o TikTok recusa início no passado)
const toUnits = (cents) => Number((cents / 100).toFixed(2));
const toTikTokTime = (local) => `${local.replace('T', ' ')}:00`; // "2026-11-20T09:30" -> "2026-11-20 09:30:00"
const COUNTRY_ID = Object.fromEntries(COUNTRIES.map((c) => [c.value, c.locationId]));

/** Só inclui chaves com valor (evita enviar null/undefined/lista vazia ao TikTok). */
const compact = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)));

const visible = (config, section, key) => isVisible(findField(section, key), config);

/** "YYYY-MM-DD HH:MM:SS" de um instante no fuso da conta de anúncio (UTC se o fuso for desconhecido/inválido). */
export function formatInTimeZone(date, timeZone) {
  const build = (zone) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
        .formatToParts(date)
        .map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  };
  try {
    return build(timeZone || 'UTC');
  } catch {
    return build('UTC');
  }
}

/** Campanha de catálogo = Vendas de produtos com os produtos vindos de um catálogo (Catalog Ads / Video Shopping Ads). */
const isCatalog = (config) => config.campaign.objective === 'PRODUCT_SALES';

function promotionType(config) {
  const { objective } = config.campaign;
  if (objective === 'APP_PROMOTION') return config.adGroup.appPlatform; // APP_ANDROID | APP_IOS
  if (objective === 'LEAD_GENERATION' && config.adGroup.leadDestination === 'INSTANT_FORM') return 'LEAD_GENERATION';
  return 'WEBSITE';
}

export function buildCampaignPayload(advertiserId, config) {
  const c = config.campaign;
  const hasBudget = c.budgetMode !== 'BUDGET_MODE_INFINITE';
  return compact({
    advertiser_id: advertiserId,
    campaign_name: c.name,
    objective_type: c.objective,
    campaign_product_source: isCatalog(config) ? 'CATALOG' : undefined,
    budget_mode: c.budgetMode,
    budget: hasBudget ? toUnits(c.budget) : undefined,
    // Orçamento no nível da campanha = otimização de orçamento da campanha (o grupo não leva orçamento próprio). Campanha de catálogo
    // nunca usa (CBO é allowlist-only para catálogo; o orçamento fica no grupo de anúncios).
    budget_optimize_on: hasBudget && !isCatalog(config) ? true : undefined,
    app_promotion_type: c.objective === 'APP_PROMOTION' ? c.appPromotionType : undefined,
    special_industries: c.specialIndustries,
    operation_status: 'DISABLE',
  });
}

/**
 * @param {{ timezone?: string|null, now?: Date }} [context] fuso da conta de anúncio e relógio (injetável em testes)
 */
export function buildAdGroupPayload(advertiserId, campaignId, config, { timezone = null, now = new Date() } = {}) {
  const g = config.adGroup;
  const has = (key) => visible(config, 'adGroup', key);
  const budgetOnGroup = has('budget');
  const startEnd = g.scheduleType === 'SCHEDULE_START_END';
  const catalog = isCatalog(config);
  // Contrato oficial de Catalog Ads: meta de valor = menor custo + deep_bid_type; lance manual de conversão vai em conversion_bid_price (bid_price só no CPC).
  const valueGoal = catalog && g.optimizationGoal === 'VALUE';
  const conversionBid = catalog && g.optimizationGoal !== 'CLICK';
  return compact({
    advertiser_id: advertiserId,
    campaign_id: campaignId,
    adgroup_name: g.name,
    promotion_type: promotionType(config),
    placement_type: g.placementType,
    placements: has('placements') ? g.placements : undefined,
    comment_disabled: g.commentDisabled === true ? true : undefined,
    video_download_disabled: g.videoDownloadDisabled === true ? true : undefined,
    location_ids: (g.locations ?? []).map((code) => COUNTRY_ID[code]),
    gender: g.gender,
    age_groups: g.ageGroups,
    languages: g.languages,
    operating_systems: g.operatingSystems,
    interest_category_ids: g.interestCategoryIds,
    audience_ids: g.audienceIds,
    budget_mode: budgetOnGroup ? g.budgetMode : undefined,
    budget: budgetOnGroup ? toUnits(g.budget) : undefined,
    schedule_type: g.scheduleType,
    // O início é obrigatório também em "começar agora" (SDK oficial): usamos o instante atual + margem, no fuso da conta.
    schedule_start_time: startEnd ? toTikTokTime(g.scheduleStart) : formatInTimeZone(new Date(now.getTime() + FROM_NOW_LEAD_MS), timezone),
    schedule_end_time: startEnd ? toTikTokTime(g.scheduleEnd) : undefined,
    optimization_goal: g.optimizationGoal,
    optimization_event: has('optimizationEvent') ? g.optimizationEvent : undefined,
    billing_event: g.billingEvent,
    bid_type: valueGoal ? 'BID_TYPE_NO_BID' : g.bidType,
    bid_price: has('bidPrice') && !conversionBid ? toUnits(g.bidPrice) : undefined,
    conversion_bid_price: has('bidPrice') && conversionBid && !valueGoal ? toUnits(g.bidPrice) : undefined,
    deep_bid_type: valueGoal ? 'VO_HIGHEST_VALUE' : undefined,
    pacing: g.pacing,
    pixel_id: has('pixelId') ? g.pixelId : undefined,
    app_id: has('appId') ? g.appId : undefined,
    shopping_ads_type: catalog ? 'VIDEO' : undefined,
    product_source: catalog ? 'CATALOG' : undefined,
    catalog_id: has('catalogId') ? g.catalogId : undefined,
    catalog_authorized_bc_id: has('catalogBcId') ? g.catalogBcId : undefined,
    shopping_ads_retargeting_type: catalog ? 'OFF' : undefined,
    frequency: has('frequency') ? g.frequency : undefined,
    frequency_schedule: has('frequencyDays') ? g.frequencyDays : undefined,
    operation_status: 'DISABLE',
  });
}

/** Acrescenta UTM à URL de destino sem duplicar parâmetros já existentes. */
export function withUtm(landingPageUrl, utmParams) {
  if (!landingPageUrl || !utmParams) return landingPageUrl;
  const url = new URL(landingPageUrl);
  for (const [key, value] of new URLSearchParams(utmParams)) if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * @param {{ videoId?: string, imageIds?: string[], coverImageId?: string }} [assets]
 *   IDs que o TikTok devolveu ao receber os criativos da biblioteca para esta conta de anúncio
 *   (resolvidos pelo servidor antes de criar qualquer coisa no TikTok).
 */
export function buildAdPayload(advertiserId, adGroupId, config, assets = {}) {
  const a = config.ad;
  const has = (key) => visible(config, 'ad', key);
  const hasGroup = (key) => visible(config, 'adGroup', key);
  const catalog = isCatalog(config);
  const catalogVideo = catalog && a.format === 'CATALOG_VIDEO'; // vídeo gerado com os produtos: sem vídeo nem capa do usuário
  const conversionGoal = ['CONVERT', 'VALUE'].includes(config.adGroup.optimizationGoal);
  const creative = compact({
    ad_name: a.name,
    // Catálogo: o formato é sempre SINGLE_VIDEO; o que muda é a estratégia (vídeos do catálogo × vídeo do usuário).
    ad_format: catalog ? 'SINGLE_VIDEO' : a.format,
    vertical_video_strategy: catalog ? (catalogVideo ? 'CATALOG_VIDEOS' : 'SINGLE_VIDEO') : undefined,
    dynamic_format: catalog ? 'UNSET' : undefined,
    identity_type: a.identityType,
    identity_id: a.identityId,
    display_name: has('displayName') ? a.displayName : undefined,
    video_id: a.format === 'SINGLE_VIDEO' && !catalogVideo ? assets.videoId : undefined,
    image_ids: a.format === 'SINGLE_IMAGE' || a.format === 'CAROUSEL_ADS' ? assets.imageIds : undefined,
    ad_text: a.text,
    call_to_action: a.callToAction,
    landing_page_url: has('landingPageUrl') ? withUtm(a.landingPageUrl, has('utmParams') ? a.utmParams : undefined) : undefined,
    deeplink: has('deeplinkUrl') ? a.deeplinkUrl : undefined,
    impression_tracking_url: a.impressionTrackingUrl,
    click_tracking_url: a.clickTrackingUrl,
    // Catálogo: o anúncio repete o catálogo do grupo e diz quais produtos mostra (todos, um conjunto ou até 20 SKUs).
    catalog_id: catalog && hasGroup('catalogId') ? config.adGroup.catalogId : undefined,
    product_specific_type: has('productSpecificType') ? a.productSpecificType : undefined,
    product_set_id: has('productSetId') ? a.productSetId : undefined,
    sku_ids: has('skuIds') ? a.skuIds : undefined,
    // Destino: metas de conversão usam o destino dinâmico (página de destino ou página instantânea); "Cliques", o site. A URL é sempre o plano B.
    dynamic_destination: catalog ? (conversionGoal ? 'DLP' : 'UNSET') : undefined,
    shopping_ads_fallback_type: catalog ? 'CUSTOM' : undefined,
    // Leads por formulário instantâneo: o ID da página/formulário vai no criativo (page_id numérico).
    page_id: hasGroup('leadFormId') ? Number(config.adGroup.leadFormId) : undefined,
    // O padrão do TikTok para criativos é ENABLE: forçamos pausado, como campanha e grupo.
    operation_status: 'DISABLE',
  });
  if (a.format === 'SINGLE_VIDEO' && assets.coverImageId) creative.image_ids = [assets.coverImageId];
  return { advertiser_id: advertiserId, adgroup_id: adGroupId, creatives: [creative] };
}
