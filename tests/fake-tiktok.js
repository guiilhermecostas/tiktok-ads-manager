import { randomBytes } from 'node:crypto';
import { isTikTokLocation } from '../shared/tiktok-locations.js';
import { isTikTokTimezone } from '../shared/tiktok-timezones.js';

export const GOOD_TOKEN = 'good-token-aaaaaaaaaaaaaaaaaaaa';
export const OTHER_TOKEN = 'other-token-bbbbbbbbbbbbbbbbbbb';
export const OAUTH_APP_ID = '7123456789012345678';
export const OAUTH_APP_SECRET = 'app-secret-test-0123456789';
export const OAUTH_REDIRECT_URI = 'https://painel.exemplo.com/api/tiktok/callback';

/** Config de teste com a integração TikTok ligada (chave de criptografia aleatória). */
export const tiktokTestConfig = ({ oauth = true } = {}) => ({
  tiktok: {
    apiBase: 'https://business-api.tiktok.com',
    encryptionKey: randomBytes(32),
    configured: true,
    verifyBackoffMs: [0, 0, 0], // a conferência do que foi criado não espera nos testes
    oauth: oauth
      ? { appId: OAUTH_APP_ID, appSecret: OAUTH_APP_SECRET, redirectUri: OAUTH_REDIRECT_URI, enabled: true }
      : { appId: null, appSecret: null, redirectUri: null, enabled: false },
  },
});

/** Simula a API do TikTok (formato v1.3) sem rede. Permite revogar tokens e derrubar relatórios. */
export function createFakeTiktok() {
  const state = {
    validTokens: new Set([GOOD_TOKEN, OTHER_TOKEN]),
    bcs: { 111: ['9001', '9002'], 222: ['9101'], 333: ['9201', '9202'] },
    currencies: { 9001: 'BRL', 9002: 'USD', 9003: 'BRL' },
    failReportFor: new Set(),
    calls: [],
    failCreate: new Set(), // ex.: 'ad' derruba a criação do anúncio
    failForAdvertiser: new Map(), // ID da conta -> nível ('campaign' | 'adGroup' | 'ad'): derruba a criação só nessa conta
    nextId: 7000,
    failUpload: new Set(), // 'image' | 'video'
    ownerBc: {}, // conta de anúncio -> ID da BC dona (preenchido pelas autorizações por link)
    omitOwnerBc: false, // true: o TikTok não devolve owner_bc_id
    rejectFields: false, // true: o TikTok recusa o parâmetro `fields` em advertiser/info
    bcInfo: {}, // BC -> { type, currency, timezone, registered_area, company, user_role }: o que /bc/get/?bc_id= devolve (e o que a criação de contas confere)
    accessibleBcs: [], // BCs que o token enxerga em /bc/get/ ([{ id, name }]); null = sem permissão
    exitIp: '198.51.100.23', // IP que a "proxy" mostra ao serviço de IP
    exitCountry: 'United States',
    exitCountryCode: 'US',
    failProxied: false, // true: toda chamada com dispatcher (proxy) falha por rede
    failIpCheck: null, // ex.: 'ECONNREFUSED': o serviço de IP falha
    ipifyBody: null, // sobrescreve a resposta do serviço de IP
    failUploadOnCall: {}, // ex.: { image: 2 } derruba só a 2ª imagem enviada desde o último `uploadCalls = {}`
    uploadCalls: {},
    createDelayMs: 0, // simula latência nas criações (testes de concorrência)
    pixels: {}, // conta de anúncio -> [{ pixel_id, pixel_code, pixel_name }] devolvidos por /pixel/list/
    failPixels: false, // true: /pixel/list/ responde erro do TikTok
    identities: {}, // conta de anúncio -> identidades ([{ identity_id, identity_type, display_name, username?, available_status? }]) de /identity/get/
    identityCreates: [], // corpos recebidos em /identity/create/
    failIdentityCreate: '', // texto: /identity/create/ responde este erro do TikTok
    failIdentityList: false, // true: /identity/get/ responde erro do TikTok
    failCampaignMessage: '', // texto: a falha de criação da campanha (failCreate 'campaign') usa este erro em vez de "Campaign name already exists"
    uniqueCampaignNames: false, // true: /campaign/create/ recusa nome repetido na mesma conta, como o TikTok ("Campaign name already exists")
    campaignNamesByAdvertiser: {}, // conta -> nomes de campanha já criados
    pixelEventCreates: [], // corpos recebidos em /pixel/event/create/
    // Conferência por ID (/campaign|adgroup|ad/get/ com filtering): o que as rotas de criação registraram, para o servidor confirmar que existe de verdade.
    createdEntities: { campaigns: new Map(), adgroups: new Map(), ads: new Map() }, // id -> { advertiser, lag }
    dropCreated: new Set(), // 'campaign' | 'adgroup' | 'ad': o TikTok RESPONDE que criou mas NÃO cria (o defeito que a conferência precisa pegar)
    createdLag: 0, // n > 0: o que foi criado só aparece nas consultas por ID depois de n consultas (atraso normal do TikTok para listar)
    droppedIds: new Set(), // IDs que o TikTok respondeu mas não criou, ou que foram excluídos depois: usar um deles como PAI (campanha/grupo) dá erro, como no TikTok de verdade
    failByIdGets: false, // true: as consultas por ID respondem erro (a conferência não consegue rodar)
    pixelEventDenied: new Set(), // contas de anúncio por onde /pixel/event/create/ responde "Pixel cannot be modified." (pixel só compartilhado / sem permissão)
    failPixelEventCreate: '', // texto: /pixel/event/create/ responde este erro do TikTok
    pixelLinks: {}, // "bcId:códigoDoPixel" -> contas vinculadas ([advertiserId, …]), como em /bc/pixel/link/*
    pixelLinkCalls: [], // corpos recebidos em /bc/pixel/link/update/
    failPixelLink: '', // texto: /bc/pixel/link/update/ responde este erro do TikTok
    pixelLinkDelayMs: 0, // latência de /bc/pixel/link/update/ (testes de pedidos simultâneos)
    pixelLinkPageSize: 0, // n>0: /bc/pixel/link/get/ devolve n contas por página (a página vem em `page`)
    createdAdvertisers: [], // corpos recebidos em /bc/advertiser/create/
    failAdvertiserCreateOnCall: 0, // n>0: a n-ésima criação de conta desde `createdAdvertisers = []` responde erro do TikTok
    advertiserCreateError: 'No permission to create ad accounts', // mensagem desse erro
    hideCreatedAdvertisers: false, // true: a conta criada ainda NÃO aparece nas listas (atraso do TikTok)
    omitCreatedAdvertiserId: false, // true: a criação funciona mas a resposta não traz o ID
    advertiserProfile: { company: 'Acme Ltda', country: 'BR', email: 'ads@acme.example', industry: '292109' }, // dados cadastrais de qualquer conta
    hourly: {}, // relatório por hora: conta de anúncio -> { 'YYYY-MM-DD': { 14: { spend: 5.5, impressions: 900, clicks: 30, conversion: 1 } } } (hora no fuso da conta)
    hourlyDelayMs: 0, // latência do relatório por hora (testes de coleta simultânea)
    failHourlyFor: new Set(), // contas cujo relatório por hora responde erro do TikTok
    ads: {}, // conta -> [{ ad_id, ad_name, campaign_id, campaign_name, adgroup_id, adgroup_name, operation_status, secondary_status, create_time, modify_time }]
    adMetrics: {}, // conta -> { adId -> { spend, impressions, clicks, ctr, cpc, result, cost_per_result, conversion, cost_per_conversion } } (do período pedido)
    adMetricsByDate: {}, // conta -> { 'YYYY-MM-DD': { adId -> métricas } }: tem prioridade quando start_date = end_date
    rejectResultMetric: false, // true: o relatório por anúncio recusa a métrica "result"
    failAdsFor: new Set(), // contas cuja listagem de anúncios responde erro
    rateLimitFor: new Set(), // contas cuja listagem de anúncios responde 40100 (limite de frequência do TikTok)
    failAdStatusFor: new Set(), // contas em que ativar/pausar responde erro
    campaigns: {}, // conta -> campanhas ({ campaign_id, campaign_name, objective_type, budget_mode, budget, operation_status, secondary_status, create_time, modify_time }); sem isto, saem dos anúncios
    adgroups: {}, // conta -> grupos ({ adgroup_id, adgroup_name, campaign_id, campaign_name, optimization_goal, budget_mode, budget, ... }); sem isto, saem dos anúncios
    failCampaignsFor: new Set(), // contas cuja listagem de campanhas responde erro
    failAdgroupsFor: new Set(), // contas cuja listagem de grupos responde erro
    failCampaignStatusFor: new Set(), // contas em que ativar/pausar campanha responde erro
    failAdgroupStatusFor: new Set(), // contas em que ativar/pausar grupo responde erro
    balances: { bc: {}, advertisers: {} }, // BC -> campos de saldo | BC -> [contas com saldo] (formato inferido: o TikTok não documenta a resposta)
    balanceListKey: 'advertiser_account_list', // nome da lista na resposta de /advertiser/balance/get/ (o TikTok não documenta)
    failBalanceBc: new Set(), // BCs cujo /bc/balance/get/ responde "sem permissão"
    failBalanceAdvertisers: new Set(), // BCs cujo /advertiser/balance/get/ responde "sem permissão"
    transferFinanceRole: true, // false: /bc/transfer/ responde "sem permissão" (só Finance Manager transfere)
    transferNetworkError: false, // true: a chamada /bc/transfer/ falha por rede DEPOIS de enviada (resultado desconhecido)
    transferDelayMs: 0, // latência de /bc/transfer/ (testes de cliques repetidos)
    minRecharge: 0, // valor mínimo aceito em RECHARGE (documentação: há um mínimo que o /advertiser/balance/get/ informa)
    rejectBalanceFields: false, // true: /advertiser/balance/get/ recusa o parâmetro `fields`
    transactions: {}, // BC -> [{ transaction_id, transaction_type, amount_type, amount, subtotal, tax_amount, currency, billing_type, timezone, create_time, account_id, account_name }] (/bc/account/transaction/get/)
    failTransactionsBc: new Set(), // BCs cujo histórico de transações responde "sem permissão" (sem função financeira)
    lifetimeSpend: {}, // conta -> { spend: '123.45', currency: 'USD' }: gasto vitalício devolvido pelo relatório com `query_lifetime`
    failLifetimeFor: new Set(), // contas que, se estiverem no pedido, fazem o relatório inteiro responder erro (o resto do lote precisa ser isolado)
    lifetimeRateLimited: false, // true: o relatório vitalício responde 40100 (limite de frequência)
    // Catálogo (Catalog API v1.3)
    catalogs: {}, // BC -> [{ catalog_id, catalog_name, catalog_type, ad_creation_eligible, create_time, update_time, bc_info, catalog_conf }]
    catalogRegions: ['US', 'BR', 'GB'], // /catalog/available_country/get/
    locationCurrencies: [{ location: 'US', currency: ['USD'] }, { location: 'BR', currency: ['BRL'] }, { location: 'GB', currency: ['GBP'] }], // /catalog/location_currency/get/
    catalogProducts: {}, // catálogo -> [produtos aceitos, no formato do upload + audit]
    catalogFeedLogs: {}, // feed_log_id -> product_feed_log
    catalogSets: {}, // catálogo -> [{ product_set_id, product_set_name, product_count, conditions }]
    catalogFeeds: {}, // catálogo -> [{ feed_id, feed_name, feed_type, status, last_update_param, next_update_time, number_of_products }]
    catalogFeedLogs2: {}, // feed -> entradas de /catalog/feed/log/
    feedCredentials: [], // { feed_id, username, password } recebidos (para provar que nunca voltam)
    failCatalogFor: new Set(), // BCs cujas chamadas de catálogo respondem "sem permissão"
    catalogOnlyRegion: {}, // BC -> país que o TikTok aceita para ELA (qualquer outro volta "currency matches the selected country", mesmo constando nas listas)
    rejectProductSkus: new Set(), // SKUs que o processamento marca como erro
    strictCatalog: true, // true: campanha/grupo/anúncio de catálogo são conferidos contra o contrato oficial e recusados se fugirem dele
    campaignsById: {}, adgroupsById: {}, // o que foi criado (para conferir a coerência entre os níveis)
    manyCampaigns: 0, // >0: devolve essa quantidade de campanhas, paginadas
    // Autorização por link: auth_code -> { token, advertisers } (uso único, como no TikTok).
    authCodes: new Map(),
    authorized: new Map(), // token OAuth -> contas de anúncio autorizadas
    exchangeDelayMs: 0,
  };

  /** Registra um código que o "TikTok" aceitará uma vez; devolve o código. */
  const grantAuthCode = (code, { token = `oauth-token-${randomBytes(6).toString('hex')}-xxxxxxxx`, advertisers = ['9001', '9002'], bcId = null } = {}) => {
    state.authCodes.set(code, { token, advertisers, bcId });
    return code;
  };

  const reply = (data, code = 0, message = 'OK') =>
    new Response(JSON.stringify({ code, message, request_id: 'x', data }), { status: 200, headers: { 'content-type': 'application/json' } });

  // ---------- Gerenciador: campanhas, grupos e anúncios (contrato v1.3 lido na documentação oficial) ----------
  const uniqueBy = (list, key) => [...new Map(list.map((item) => [item[key], item])).values()];
  const hasOp = (list, op) => list.some((a) => a.operation_status === op);
  /** Sem `state.campaigns`, as campanhas saem dos anúncios da conta (mesmo ID e nome). Guarda no estado para ativar/pausar valer depois. */
  const campaignsOf = (adv) => {
    if (!state.campaigns[adv] && state.ads[adv]?.length) {
      state.campaigns[adv] = uniqueBy(state.ads[adv], 'campaign_id').map((a) => {
        const own = state.ads[adv].filter((x) => x.campaign_id === a.campaign_id);
        const on = hasOp(own, 'ENABLE');
        return { campaign_id: a.campaign_id, campaign_name: a.campaign_name, advertiser_id: adv, objective_type: 'TRAFFIC', budget_mode: 'BUDGET_MODE_DAY', budget: 50, operation_status: on ? 'ENABLE' : 'DISABLE', secondary_status: on ? 'CAMPAIGN_STATUS_ENABLE' : 'CAMPAIGN_STATUS_DISABLE', create_time: a.create_time, modify_time: a.modify_time };
      });
    }
    return state.campaigns[adv] ?? null;
  };
  const adgroupsOf = (adv) => {
    if (!state.adgroups[adv] && state.ads[adv]?.length) {
      state.adgroups[adv] = uniqueBy(state.ads[adv], 'adgroup_id').map((a) => {
        const own = state.ads[adv].filter((x) => x.adgroup_id === a.adgroup_id);
        const on = hasOp(own, 'ENABLE');
        return { adgroup_id: a.adgroup_id, adgroup_name: a.adgroup_name, advertiser_id: adv, campaign_id: a.campaign_id, campaign_name: a.campaign_name, optimization_goal: 'CLICK', budget_mode: 'BUDGET_MODE_DAY', budget: 20, operation_status: on ? 'ENABLE' : 'DISABLE', secondary_status: on ? 'ADGROUP_STATUS_DELIVERY_OK' : 'ADGROUP_STATUS_DISABLE', create_time: a.create_time, modify_time: a.modify_time };
      });
    }
    return state.adgroups[adv] ?? null;
  };
  const pagedList = (all, query, fields) => {
    const size = Number(query.page);
    const per = Number(query.page_size);
    const pick = (a) => (fields ? Object.fromEntries(fields.filter((f) => f in a).map((f) => [f, a[f]])) : a);
    return reply({ list: all.slice((size - 1) * per, size * per).map(pick), page_info: { page: size, page_size: per, total_number: all.length, total_page: Math.max(1, Math.ceil(all.length / per)) } });
  };
  const notDeleted = (all, query) => all.filter((a) => !(JSON.parse(query.filtering ?? '{}').primary_status === 'STATUS_NOT_DELETE' && a.operation_status === 'DELETE'));
  /** Ativar/pausar (`/campaign/status/update/`, `/adgroup/status/update/`): de 1 a 20 IDs; só dessas contas; o TikTok aceita também DELETE. */
  const updateStatus = (body, { list, idField, idsField, enabled, disabled, failFor }) => {
    if (failFor.has(body?.advertiser_id)) return reply({}, 40002, 'No permission to update status');
    if (!['ENABLE', 'DISABLE', 'DELETE'].includes(body?.operation_status)) return reply({}, 40002, 'operation_status is invalid');
    if (!Array.isArray(body?.[idsField]) || body[idsField].length < 1 || body[idsField].length > 20) return reply({}, 40002, `${idsField}: allowed quantity 1-20`);
    const done = [];
    for (const item of list ?? []) {
      if (!body[idsField].includes(item[idField])) continue;
      item.operation_status = body.operation_status;
      item.secondary_status = body.operation_status === 'ENABLE' ? enabled : disabled;
      done.push(item[idField]);
    }
    return reply({ status: body.operation_status, [idsField]: done });
  };
  /** Desempenho de campanha/grupo = soma dos anúncios dele (como o relatório do TikTok agrega). */
  const SUM_KEYS = ['spend', 'impressions', 'clicks', 'result', 'conversion'];
  const aggregateMetrics = (adv, groupField, source) => {
    const groups = {};
    for (const ad of state.ads[adv] ?? []) {
      const m = source[ad.ad_id];
      if (!m) continue;
      const g = (groups[ad[groupField]] ??= Object.fromEntries(SUM_KEYS.map((k) => [k, 0])));
      for (const k of SUM_KEYS) g[k] += Number(m[k] ?? 0);
    }
    for (const g of Object.values(groups)) {
      g.ctr = g.impressions ? (g.clicks / g.impressions) * 100 : 0;
      g.cpc = g.clicks ? g.spend / g.clicks : 0;
      g.cost_per_result = g.result ? g.spend / g.result : 0;
      g.cost_per_conversion = g.conversion ? g.spend / g.conversion : 0;
    }
    return groups;
  };

  const jsonReply = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

  /** Contrato OFICIAL de "Catalog Ads" (Product Sales + catálogo): devolve a mensagem do 1º desvio, ou null. */
  const catalogCampaignError = (b) => {
    if (b.objective_type !== 'PRODUCT_SALES') return null;
    if (b.campaign_product_source !== 'CATALOG') return 'campaign_product_source must be CATALOG for catalog sales';
    if (b.budget_optimize_on === true) return 'Campaign Budget Optimization is not supported for catalog sales without allowlist';
    if (b.special_industries?.length) return 'special_industries is allowlist-only for catalog sales';
    return null;
  };
  const catalogAdGroupError = (b) => {
    const campaign = state.campaignsById[b.campaign_id];
    const isCatalog = b.product_source === 'CATALOG' || campaign?.objective_type === 'PRODUCT_SALES';
    if (!isCatalog) return null;
    if (b.shopping_ads_type !== 'VIDEO') return 'shopping_ads_type must be VIDEO';
    if (b.product_source !== 'CATALOG') return 'product_source must be CATALOG';
    if (!/^\d+$/.test(String(b.catalog_id ?? ''))) return 'catalog_id is required';
    if (!/^\d+$/.test(String(b.catalog_authorized_bc_id ?? ''))) return 'catalog_authorized_bc_id is required for catalogs under a Business Center';
    for (const key of ['identity_type', 'identity_id', 'identity_authorized_bc_id', 'store_id', 'store_authorized_bc_id', 'saved_audience_id', 'creative_material_mode', 'auto_targeting_enabled', 'smart_audience_enabled']) if (b[key] !== undefined) return `${key} must not be passed`;
    if (b.promotion_type !== 'WEBSITE') return 'promotion_type must be WEBSITE';
    if (b.placement_type === 'PLACEMENT_TYPE_NORMAL' && JSON.stringify(b.placements) !== '["PLACEMENT_TIKTOK"]') return 'placements must be ["PLACEMENT_TIKTOK"]';
    if (!['PLACEMENT_TYPE_NORMAL', 'PLACEMENT_TYPE_AUTOMATIC'].includes(b.placement_type)) return 'placement_type is required';
    if (b.shopping_ads_retargeting_type !== 'OFF') return 'shopping_ads_retargeting_type must be OFF';
    const goal = b.optimization_goal;
    if (!['CLICK', 'CONVERT', 'VALUE'].includes(goal)) return 'optimization_goal must be CLICK, CONVERT or VALUE';
    if (goal === 'CLICK') {
      if (b.pixel_id !== undefined || b.optimization_event !== undefined) return 'pixel_id and optimization_event must not be passed for CLICK';
      if (b.billing_event !== 'CPC') return 'billing_event must be CPC for CLICK';
    } else {
      if (!/^\d+$/.test(String(b.pixel_id ?? '')) || !b.optimization_event) return 'pixel_id and optimization_event are required for CONVERT and VALUE';
      if (b.billing_event !== 'OCPM') return 'billing_event must be OCPM';
    }
    if (goal === 'VALUE') {
      if (b.optimization_event !== 'SHOPPING') return 'optimization_event must be SHOPPING for VALUE';
      if (b.bid_type !== 'BID_TYPE_NO_BID' || !['VO_HIGHEST_VALUE', 'VO_MIN_ROAS'].includes(b.deep_bid_type)) return 'VALUE requires BID_TYPE_NO_BID and deep_bid_type';
    } else if (b.deep_bid_type !== undefined || b.roas_bid !== undefined) return 'deep_bid_type and roas_bid must not be passed';
    if (b.bid_type === 'BID_TYPE_CUSTOM') {
      if (goal === 'CLICK' && !(b.bid_price > 0)) return 'bid_price is required for CLICK with BID_TYPE_CUSTOM';
      if (goal === 'CONVERT' && !(b.conversion_bid_price > 0)) return 'conversion_bid_price is required for CONVERT with BID_TYPE_CUSTOM';
      if (goal === 'CONVERT' && b.bid_price !== undefined) return 'bid_price must not be passed for CONVERT';
    }
    if (b.bid_type === 'BID_TYPE_NO_BID' && b.pacing === 'PACING_MODE_FAST') return 'BID_TYPE_NO_BID only supports PACING_MODE_SMOOTH';
    return null;
  };
  const catalogAdError = (c, adgroup) => {
    if (!adgroup || adgroup.product_source !== 'CATALOG') return null;
    if (String(c.catalog_id) !== String(adgroup.catalog_id)) return 'catalog_id must match the ad group catalog_id';
    if (!['ALL', 'PRODUCT_SET', 'CUSTOMIZED_PRODUCTS'].includes(c.product_specific_type)) return 'product_specific_type is required';
    if (c.product_specific_type === 'PRODUCT_SET' && !c.product_set_id && !c.item_group_ids?.length) return 'product_set_id or item_group_ids is required for PRODUCT_SET';
    if (c.product_specific_type === 'CUSTOMIZED_PRODUCTS' && !(c.sku_ids?.length >= 1 && c.sku_ids.length <= 20)) return 'sku_ids (1-20) is required for CUSTOMIZED_PRODUCTS';
    if (c.product_specific_type !== 'PRODUCT_SET' && c.product_set_id !== undefined) return 'product_set_id only with PRODUCT_SET';
    if (c.product_specific_type !== 'CUSTOMIZED_PRODUCTS' && c.sku_ids !== undefined) return 'sku_ids only with CUSTOMIZED_PRODUCTS';
    if (c.dynamic_format !== 'UNSET') return 'dynamic_format must be UNSET';
    if (c.ad_format !== 'SINGLE_VIDEO') return 'ad_format must be SINGLE_VIDEO';
    if (c.vertical_video_strategy === 'CATALOG_VIDEOS') {
      if (c.identity_type !== 'CUSTOMIZED_USER' || !c.identity_id) return 'catalog video requires a CUSTOMIZED_USER identity';
      for (const key of ['video_id', 'image_ids', 'tiktok_item_id', 'music_id', 'card_id']) if (c[key] !== undefined) return `${key} must not be passed for catalog video`;
    } else if (c.vertical_video_strategy === 'SINGLE_VIDEO') {
      if (!c.video_id || !c.image_ids?.length) return 'video_id and image_ids are required for single video';
      if (!c.identity_type || !c.identity_id) return 'identity is required';
    } else return 'vertical_video_strategy must be CATALOG_VIDEOS or SINGLE_VIDEO';
    if (!c.ad_text) return 'ad_text is required';
    if (!c.call_to_action) return 'call_to_action is required';
    if (!['UNSET', 'DLP'].includes(c.dynamic_destination)) return 'dynamic_destination is required (UNSET or DLP)';
    if (c.dynamic_destination === 'DLP' && !['CONVERT', 'VALUE'].includes(adgroup.optimization_goal)) return 'dynamic_destination DLP is not supported for CLICK';
    if (c.dynamic_destination === 'UNSET' && ['CONVERT', 'VALUE'].includes(adgroup.optimization_goal) && !c.landing_page_url) return 'landing_page_url is required';
    if (c.shopping_ads_fallback_type !== 'CUSTOM' || !/^https?:\/\//.test(c.landing_page_url ?? '')) return 'shopping_ads_fallback_type CUSTOM with landing_page_url is required';
    return null;
  };

  const ECOM_REQUIRED = (p) => {
    const missing = [];
    if (!p?.sku_id) missing.push('sku_id');
    if (!p?.title) missing.push('title');
    if (!p?.description) missing.push('description');
    if (!['IN_STOCK', 'AVAILABLE_FOR_ORDER', 'PREORDER', 'OUT_OF_STOCK', 'DISCONTINUED'].includes(p?.availability)) missing.push('availability');
    if (!p?.brand) missing.push('brand');
    if (!/^https?:\/\//.test(p?.image_url ?? '')) missing.push('image_url');
    if (!['NEW', 'REFURBISHED', 'USED'].includes(p?.product_detail?.condition)) missing.push('product_detail.condition');
    if (!(typeof p?.price_info?.price === 'number' && p.price_info.price > 0)) missing.push('price_info.price');
    if (!/^https?:\/\//.test(p?.landing_page?.landing_page_url ?? '')) missing.push('landing_page.landing_page_url');
    return missing;
  };
  const catalogOf = (bc, id) => (state.catalogs[bc] ?? []).find((c) => c.catalog_id === String(id));

  /** Consulta por ID das rotas /campaign|adgroup|ad/get/ (filtering com campaign_ids, adgroup_ids ou ad_ids): responde só com o que foi criado e continua visível. */
  const BY_ID = { campaigns: ['campaign_ids', 'campaign_id'], adgroups: ['adgroup_ids', 'adgroup_id'], ads: ['ad_ids', 'ad_id'] };
  const byIdQuery = (kind, query) => {
    let filtering;
    try {
      filtering = JSON.parse(query.filtering ?? '{}');
    } catch {
      return null;
    }
    const [filterKey, idField] = BY_ID[kind];
    if (!Array.isArray(filtering[filterKey])) return null; // não é consulta por ID: segue o comportamento de sempre
    if (state.failByIdGets) return reply({}, 50001, 'Internal error');
    const list = [];
    for (const id of filtering[filterKey]) {
      const entity = state.createdEntities[kind].get(String(id));
      if (!entity || entity.advertiser !== query.advertiser_id) continue;
      if (entity.lag > 0) {
        entity.lag -= 1; // ainda não aparece
        continue;
      }
      list.push({ [idField]: String(id), operation_status: entity.status });
    }
    return reply({ list, page_info: { page: 1, page_size: Number(query.page_size) || 10, total_number: list.length, total_page: 1 } });
  };
  const registerCreated = (kind, drop, id, advertiser, status) => {
    if (state.dropCreated.has(drop)) state.droppedIds.add(String(id));
    else state.createdEntities[kind].set(String(id), { advertiser, status, lag: state.createdLag });
  };
  /** Simula alguém excluir (ou o TikTok perder) uma campanha, um grupo ou um anúncio criado: some das consultas e deixa de servir de pai. */
  const deleteCreated = (kind, id) => {
    state.createdEntities[kind].delete(String(id));
    state.droppedIds.add(String(id));
  };

  const fetchFn = async (url, init) => {
    const u = new URL(url);
    // Falha de rede simulada para TODA chamada que sai por uma proxy (proxy fora do ar).
    if (state.failProxied && init.dispatcher) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    // Serviços públicos que o teste de proxy consulta (IP e país de saída).
    if (u.hostname === 'api.ipify.org' || u.hostname === 'ipwho.is') {
      state.calls.push({ path: `${u.hostname}${u.pathname}`, query: {}, token: undefined, method: init.method ?? 'GET', body: undefined, dispatcher: init.dispatcher ?? null });
      if (state.failIpCheck) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: state.failIpCheck }) });
      if (u.hostname === 'api.ipify.org') return jsonReply(state.ipifyBody ?? { ip: state.exitIp });
      return jsonReply({ success: true, country: state.exitCountry, country_code: state.exitCountryCode });
    }
    const query = Object.fromEntries(u.searchParams);
    const token = init.headers['Access-Token'];
    if (state.createDelayMs && u.pathname.endsWith('/create/')) await new Promise((r) => setTimeout(r, state.createDelayMs));
    // Corpo JSON (criações) ou multipart (envio de mídia): no multipart guardamos os campos e os metadados do arquivo.
    let body;
    if (init.body instanceof FormData) {
      body = {};
      for (const [key, value] of init.body.entries()) body[key] = typeof value === 'string' ? value : { fileName: value.name, size: value.size };
    } else if (init.body) {
      body = JSON.parse(init.body);
    }
    state.calls.push({ path: u.pathname.replace('/open_api/v1.3', ''), query, token, method: init.method, body, dispatcher: init.dispatcher ?? null });

    const path = u.pathname.replace('/open_api/v1.3', '');

    // Transferência de saldo (`/bc/transfer/`): CONTRATO oficial (campos, enums, uma única origem de valor) e o saldo muda de verdade no estado.
    if (path === '/bc/transfer/') {
      if (state.transferDelayMs) await new Promise((r) => setTimeout(r, state.transferDelayMs));
      if (state.transferNetworkError) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      if (init.method !== 'POST') return reply({}, 40002, 'Method not allowed');
      if (!state.validTokens.has(token)) return reply({}, 40105, 'Access token is incorrect or has been revoked');
      if (!state.transferFinanceRole) return reply({}, 40001, 'No permission: only users with the Finance Manager role can process a payment');
      const b = body ?? {};
      const allowed = ['bc_id', 'transfer_level', 'advertiser_id', 'payment_portfolio_id', 'transfer_type', 'amount_info', 'cash_amount', 'grant_amount', 'request_id'];
      const extra = Object.keys(b).filter((k) => !allowed.includes(k));
      if (extra.length) return reply({}, 40002, `Unknown parameter: ${extra[0]}`);
      if (typeof b.bc_id !== 'string' || !/^\d+$/.test(b.bc_id)) return reply({}, 40002, 'bc_id must be a string of digits');
      if ((b.transfer_level ?? 'ADVERTISER') !== 'ADVERTISER') return reply({}, 40002, 'transfer_level BC is not supported by this fake');
      if (typeof b.advertiser_id !== 'string' || !/^\d+$/.test(b.advertiser_id)) return reply({}, 40002, 'advertiser_id is required when transfer_level is ADVERTISER');
      if (!['RECHARGE', 'REFUND'].includes(b.transfer_type)) return reply({}, 40002, 'transfer_type must be RECHARGE or REFUND');
      const sources = ['amount_info', 'cash_amount', 'grant_amount'].filter((k) => b[k] !== undefined);
      if (sources.length !== 1) return reply({}, 40002, 'You need to specify one of amount_info, cash_amount, or grant_amount');
      if (b.cash_amount === undefined) return reply({}, 40002, 'This fake only handles cash_amount');
      if (typeof b.cash_amount !== 'number' || !(b.cash_amount > 0) || Math.abs(b.cash_amount * 100 - Math.round(b.cash_amount * 100)) > 1e-7) return reply({}, 40002, 'cash_amount must be a number greater than 0, rounded to two decimal places');
      if (b.request_id !== undefined && !/^[\w-]{32}$/.test(String(b.request_id))) return reply({}, 40002, 'request_id must be a 32-bit string');
      const list = state.balances.advertisers[b.bc_id] ?? [];
      const acct = list.find((a) => a.advertiser_id === b.advertiser_id);
      const bcRow = state.balances.bc[b.bc_id];
      if (!acct || !bcRow) return reply({}, 40002, 'The ad account does not belong to this Business Center');
      const n = (v) => Number(v ?? 0);
      const bump = (obj, key, delta) => { if (obj && obj[key] !== undefined) obj[key] = String(Math.round((n(obj[key]) + delta) * 100) / 100); };
      const fromBc = b.transfer_type === 'RECHARGE';
      if (fromBc && b.cash_amount < state.minRecharge) return reply({}, 40002, `The minimum amount for a recharge is ${state.minRecharge}`);
      if (fromBc && b.cash_amount > n(bcRow.valid_account_balance)) return reply({}, 40002, 'The Business Center balance is not enough');
      if (!fromBc && b.cash_amount > n(acct.balance_info?.valid_account_balance ?? acct.valid_account_balance)) return reply({}, 40002, 'The ad account balance is not enough');
      const sign = fromBc ? 1 : -1;
      for (const key of ['valid_account_balance', 'account_balance', 'valid_cash_balance', 'cash_balance']) {
        bump(acct, key, sign * b.cash_amount);
        bump(acct.balance_info, key, sign * b.cash_amount);
        bump(bcRow, key, -sign * b.cash_amount);
      }
      state.transfers = [...(state.transfers ?? []), { bc_id: b.bc_id, advertiser_id: b.advertiser_id, type: b.transfer_type, amount: b.cash_amount }];
      const tid = () => `${Date.now()}${++state.nextId}`;
      return reply({ bc_id: b.bc_id, advertiser_id: b.advertiser_id, transaction_infos: [
        { transaction_id: tid(), transaction_type: 'CASH', payee_account: fromBc ? { account_type: 'ADVERTISER', account_id: b.advertiser_id } : { account_type: 'BC', account_id: b.bc_id }, remitter_account: null },
        { transaction_id: tid(), transaction_type: 'CASH', remitter_account: fromBc ? { account_type: 'BC', account_id: b.bc_id } : { account_type: 'ADVERTISER', account_id: b.advertiser_id }, payee_account: null },
      ] });
    }

    // Troca do código de autorização: não usa token; autentica por app_id + secret.
    if (path === '/oauth2/access_token/') {
      if (state.exchangeDelayMs) await new Promise((r) => setTimeout(r, state.exchangeDelayMs));
      if (body?.app_id !== OAUTH_APP_ID || body?.secret !== OAUTH_APP_SECRET) return reply({}, 40002, 'app_id or secret is incorrect');
      const grant = state.authCodes.get(body.auth_code);
      if (!grant) return reply({}, 40002, 'auth_code is invalid or expired');
      state.authCodes.delete(body.auth_code); // uso único
      state.validTokens.add(grant.token);
      state.authorized.set(grant.token, [...grant.advertisers]);
      if (grant.bcId) for (const advertiser of grant.advertisers) state.ownerBc[advertiser] = grant.bcId;
      return reply({ access_token: grant.token, advertiser_ids: grant.advertisers, scope: [4] });
    }

    if (!state.validTokens.has(token)) return reply({}, 40105, 'Access token is incorrect or has been revoked.');

    switch (path) {
      case '/oauth2/advertiser/get/': {
        if (query.app_id !== OAUTH_APP_ID || query.secret !== OAUTH_APP_SECRET) return reply({}, 40002, 'app_id or secret is incorrect');
        const ids = state.authorized.get(token);
        if (!ids) return reply({}, 40105, 'Access token is incorrect or has been revoked.');
        return reply({ list: ids.map((id) => ({ advertiser_id: id, advertiser_name: `Conta ${id}` })) });
      }
      case '/bc/get/': {
        if (state.accessibleBcs === null) return reply({}, 40001, 'No permission to this API');
        if (query.bc_id) {
          const info = state.bcInfo[query.bc_id];
          const { user_role: userRole = 'ADMIN', ...bcInfo } = info ?? {};
          return reply({ list: info ? [{ bc_info: { bc_id: query.bc_id, name: `BC ${query.bc_id}`, status: 'ENABLE', ...bcInfo }, user_role: userRole }] : [], page_info: { page: 1, total_page: 1 } });
        }
        return reply({ list: state.accessibleBcs.map((bc) => ({ bc_info: { bc_id: bc.id, name: bc.name } })), page_info: { page: 1, total_page: 1 } });
      }
      case '/bc/asset/get/': {
        // Limite documentado no SDK oficial: page_size máximo = 50.
        if (Number(query.page_size) > 50) return reply({}, 40002, 'page_size must be less than or equal to 50');
        const ids = state.bcs[query.bc_id];
        if (!ids) return reply({}, 40002, 'No permission to this business center');
        return reply({ list: ids.map((id) => ({ asset_id: id, asset_type: 'ADVERTISER' })), page_info: { page: 1, total_page: 1 } });
      }
      case '/advertiser/info/': {
        const ids = JSON.parse(query.advertiser_ids);
        if (state.rejectFields && query.fields) return reply({}, 40002, 'The value of fields is invalid');
        const ownerOf = (id) => state.ownerBc[id] ?? Object.entries(state.bcs).find(([, accounts]) => accounts.includes(id))?.[0];
        const wantsProfile = String(query.fields ?? '').includes('company');
        return reply({ list: ids.map((id) => ({ advertiser_id: id, status: state.advertiserStatus?.[id] ?? 'STATUS_ENABLE', name: state.createdNames?.[id] ?? `Conta ${id}`, currency: state.currencies[id] ?? 'BRL', timezone: 'America/Sao_Paulo', ...(wantsProfile ? state.advertiserProfile : {}), ...(state.omitOwnerBc || !ownerOf(id) ? {} : { owner_bc_id: ownerOf(id) }) })) });
      }
      case '/bc/advertiser/create/': {
        state.createdAdvertisers.push(body);
        if (state.failAdvertiserCreateOnCall && state.createdAdvertisers.length === state.failAdvertiserCreateOnCall) return reply({}, 40002, state.advertiserCreateError);
        if (!state.bcs[body?.bc_id]) return reply({}, 40002, 'No permission to this business center');
        const info = body.advertiser_info ?? {};
        const customer = body.customer_info ?? {};
        if (!info.name || !info.currency || !info.timezone || !customer.company || !customer.registered_area) return reply({}, 40002, 'Missing required parameter');
        // Comportamento real observado: o TikTok exige UM parâmetro de ramo de atividade.
        if (!Number.isInteger(customer.industry)) return reply({}, 40002, 'You need to set only one industry param.');
        // Regras da documentação oficial (/bc/advertiser/create/):
        if (!isTikTokTimezone(info.timezone)) return reply({}, 40002, 'Information for this time zone does not exist.');
        if (!isTikTokLocation(customer.registered_area)) return reply({}, 40002, 'registered_area is invalid');
        const rules = state.bcInfo[body.bc_id];
        if (rules) {
          if (rules.user_role && rules.user_role !== 'ADMIN') return reply({}, 40002, 'No permission: admin role required');
          if (rules.currency && info.currency !== rules.currency) return reply({}, 40002, 'currency must be consistent with the Business Center');
          if (['AGENCY', 'SELF_SERVICE_AGENCY'].includes(rules.type) && !body.qualification_info?.promotion_link) return reply({}, 40002, 'promotion_link is required');
          if (rules.type === 'DIRECT' && body.qualification_info) return reply({}, 40002, 'qualification_info should not be specified for a DIRECT Business Center');
        }
        const id = String(++state.nextId);
        state.createdNames ??= {};
        state.createdNames[id] = info.name;
        state.currencies[id] = info.currency;
        if (!state.hideCreatedAdvertisers) state.bcs[body.bc_id].push(id);
        return reply(state.omitCreatedAdvertiserId ? {} : { advertiser_id: id });
      }
      case '/bc/balance/get/': {
        if (state.failBalanceBc.has(query.bc_id) || !state.balances.bc[query.bc_id]) return reply({}, 40001, 'No permission to get the balance of this business center');
        return reply(state.balances.bc[query.bc_id]);
      }
      case '/advertiser/balance/get/': {
        if (Number(query.page_size) > 50) return reply({}, 40002, 'page_size must be less than or equal to 50');
        if (query.fields !== undefined) { // `fields`: lista de campos EXTRAS (valores da documentação oficial de /advertiser/balance/get/)
          const asked = JSON.parse(query.fields);
          const allowed = ['budget_remaining', 'budget_frequency_restriction', 'budget_amount_restriction', 'min_transferable_amount', 'max_transferable_amount'];
          if (state.rejectBalanceFields || !Array.isArray(asked) || asked.some((f) => !allowed.includes(f))) return reply({}, 40002, 'Invalid fields');
        }
        if (state.failBalanceAdvertisers.has(query.bc_id) || !state.balances.advertisers[query.bc_id]) return reply({}, 40001, 'No permission to get balances in this business center');
        const all = state.balances.advertisers[query.bc_id];
        const size = Number(query.page);
        const per = Number(query.page_size);
        return reply({ [state.balanceListKey]: all.slice((size - 1) * per, size * per), page_info: { page: size, page_size: per, total_number: all.length, total_page: Math.max(1, Math.ceil(all.length / per)) } });
      }
      case '/ad/get/': {
        { const byId = byIdQuery('ads', query); if (byId) return byId; }
        if (state.rateLimitFor.has(query.advertiser_id)) return reply({}, 40100, 'Too many requests');
        if (state.failAdsFor.has(query.advertiser_id)) return reply({}, 40001, 'No permission to get ads');
        if (Number(query.page_size) > 1000 || Number(query.page_size) < 1) return reply({}, 40002, 'page_size must be between 1 and 1000');
        const all = (state.ads[query.advertiser_id] ?? []).filter((a) => !(JSON.parse(query.filtering ?? '{}').primary_status === 'STATUS_NOT_DELETE' && a.operation_status === 'DELETE'));
        const size = Number(query.page);
        const per = Number(query.page_size);
        const fields = query.fields ? JSON.parse(query.fields) : null;
        const pick = (a) => (fields ? Object.fromEntries(fields.filter((f) => f in a).map((f) => [f, a[f]])) : a);
        return reply({ list: all.slice((size - 1) * per, size * per).map(pick), page_info: { page: size, page_size: per, total_number: all.length, total_page: Math.max(1, Math.ceil(all.length / per)) } });
      }
      case '/ad/status/update/': {
        if (state.failAdStatusFor.has(body?.advertiser_id)) return reply({}, 40002, 'No permission to update ad status');
        if (!['ENABLE', 'DISABLE', 'DELETE'].includes(body?.operation_status)) return reply({}, 40002, 'operation_status is invalid');
        if (!Array.isArray(body?.ad_ids) || body.ad_ids.length < 1 || body.ad_ids.length > 20) return reply({}, 40002, 'ad_ids: allowed quantity 1-20');
        const mine = state.ads[body.advertiser_id] ?? [];
        const done = [];
        for (const ad of mine) {
          if (!body.ad_ids.includes(ad.ad_id)) continue;
          ad.operation_status = body.operation_status;
          ad.secondary_status = body.operation_status === 'ENABLE' ? 'AD_STATUS_DELIVERY_OK' : 'AD_STATUS_DISABLE';
          done.push(ad.ad_id);
        }
        return reply({ status: body.operation_status, ad_ids: done });
      }
      case '/pixel/list/': {
        if (Number(query.page_size) > 20) return reply({}, 40002, 'page_size must be between 1 and 20'); // limite da documentação oficial
        if (state.failPixels) return reply(null, 40002, 'No permission to access pixels');
        const all = state.pixels[query.advertiser_id] ?? [];
        const size = Number(query.page_size);
        const page = Number(query.page);
        return reply({ pixels: all.slice((page - 1) * size, page * size), page_info: { page, page_size: size, total_number: all.length, total_page: Math.max(1, Math.ceil(all.length / size)) } });
      }
      case '/bc/pixel/link/update/': {
        state.pixelLinkCalls.push(body);
        if (state.pixelLinkDelayMs) await new Promise((resolve) => { setTimeout(resolve, state.pixelLinkDelayMs); });
        if (state.failPixelLink) return reply({}, 40002, state.failPixelLink);
        if (!state.bcs[body?.bc_id]) return reply({}, 40002, 'No permission to this business center');
        if (!/^[A-Za-z0-9]{6,40}$/.test(String(body.pixel_code ?? '')) || !Array.isArray(body.advertiser_ids) || !body.advertiser_ids.length) return reply({}, 40002, 'Missing required parameter');
        if (!['LINK', 'UNLINK'].includes(body.relation_status)) return reply({}, 40002, 'relation_status is invalid');
        const key = `${body.bc_id}:${body.pixel_code}`;
        const current = new Set(state.pixelLinks[key] ?? []);
        for (const id of body.advertiser_ids) {
          if (body.relation_status === 'LINK') current.add(id);
          else current.delete(id);
        }
        state.pixelLinks[key] = [...current];
        return reply({});
      }
      case '/bc/pixel/link/get/': {
        if (!state.bcs[query.bc_id]) return reply({}, 40002, 'No permission to this business center');
        if (!query.pixel_code) return reply({}, 40002, 'Missing required parameter');
        const all = state.pixelLinks[`${query.bc_id}:${query.pixel_code}`] ?? [];
        const size = state.pixelLinkPageSize || all.length || 1;
        const page = Number(query.page ?? 1);
        return reply({ list: all.slice((page - 1) * size, page * size).map((advertiser_id) => ({ advertiser_id })), page_info: { page, page_size: size, total_number: all.length, total_page: Math.max(1, Math.ceil(all.length / size)) } });
      }
      case '/identity/get/': {
        if (state.failIdentityList) return reply({}, 40002, 'No permission to access identities');
        if (Number(query.page_size) < 1 || Number(query.page_size) > 100) return reply({}, 40002, 'page_size must be between 1 and 100');
        if (!['CUSTOMIZED_USER', 'AUTH_CODE', 'TT_USER', 'BC_AUTH_TT'].includes(query.identity_type)) return reply({}, 40002, 'identity_type is invalid');
        if (query.identity_type === 'BC_AUTH_TT' && !query.identity_authorized_bc_id) return reply({}, 40002, 'identity_authorized_bc_id is required when identity_type is BC_AUTH_TT');
        const all = (state.identities[query.advertiser_id] ?? []).filter((i) => i.identity_type === query.identity_type);
        const size = Number(query.page_size ?? 20);
        const page = Number(query.page ?? 1);
        return reply({ identity_list: all.slice((page - 1) * size, page * size), page_info: { page, page_size: size, total_number: all.length, total_page: Math.max(1, Math.ceil(all.length / size)) } });
      }
      case '/identity/create/': {
        state.identityCreates.push(body);
        if (state.failIdentityCreate) return reply({}, 40002, state.failIdentityCreate);
        if (typeof body?.advertiser_id !== 'string' || !body.display_name) return reply({}, 40002, 'Missing required parameter');
        if (body.display_name.length > 100) return reply({}, 40002, 'display_name is too long');
        const identity = { identity_id: `7${String(1000000 + ++state.nextId).padStart(18, '0')}`, identity_type: 'CUSTOMIZED_USER', display_name: body.display_name, image_uri: body.image_uri ?? null };
        state.identities[body.advertiser_id] = [...(state.identities[body.advertiser_id] ?? []), identity];
        return reply({ identity_id: identity.identity_id });
      }
      case '/pixel/event/create/': {
        state.pixelEventCreates.push(body);
        if (state.failPixelEventCreate) return reply({}, 40002, state.failPixelEventCreate);
        if (state.pixelEventDenied.has(body?.advertiser_id)) return reply({}, 40002, 'Pixel cannot be modified.');
        const pixel = (state.pixels[body?.advertiser_id] ?? []).find((p) => p.pixel_id === body?.pixel_id);
        if (!pixel) return reply({}, 40002, 'Pixel not found');
        const VALID = ['SHOPPING', 'INITIATE_ORDER', 'ON_WEB_CART', 'ADD_BILLING', 'ON_WEB_DETAIL', 'FORM', 'ON_WEB_REGISTER', 'ON_WEB_SUBSCRIBE', 'ON_WEB_SEARCH', 'ON_WEB_ADD_TO_WISHLIST', 'CONSULT', 'DOWNLOAD_START'];
        for (const event of body.pixel_events ?? []) {
          if (!VALID.includes(event.event_type)) return reply({}, 40002, 'event_type is invalid');
          const created = { event_type: event.event_type, optimization_event: event.event_type, event_name: event.event_name ?? '', event_id: String(++state.nextId) };
          // o evento fica no PIXEL: aparece na lista de todas as contas que enxergam esse pixel
          for (const list of Object.values(state.pixels)) for (const p of list) if (p.pixel_id === body.pixel_id) p.events = [...(p.events ?? []), created];
        }
        return reply({});
      }
      case '/campaign/get/': {
        { const byId = byIdQuery('campaigns', query); if (byId) return byId; }
        if (state.failCampaignsFor.has(query.advertiser_id)) return reply({}, 40001, 'No permission to get campaigns');
        if (state.rateLimitFor.has(query.advertiser_id)) return reply({}, 40100, 'Too many requests');
        if (Number(query.page_size) > 1000 || Number(query.page_size) < 1) return reply({}, 40002, 'page_size must be between 1 and 1000');
        if (!state.manyCampaigns && campaignsOf(query.advertiser_id)) return pagedList(notDeleted(campaignsOf(query.advertiser_id), query), query, query.fields ? JSON.parse(query.fields) : null);
        if (state.manyCampaigns) {
          const size = Number(query.page_size);
          const page = Number(query.page);
          const all = Array.from({ length: state.manyCampaigns }, (_, i) => ({ campaign_id: String(5000 + i), campaign_name: `Campanha ${i + 1}`, objective_type: 'TRAFFIC', operation_status: 'ENABLE', budget: 10 }));
          const list = all.slice((page - 1) * size, page * size);
          return reply({ list, page_info: { page, page_size: size, total_number: all.length, total_page: Math.ceil(all.length / size) } });
        }
        return reply({
          list: [
            { campaign_id: '5001', campaign_name: 'Black <b>Friday</b>', objective_type: 'WEB_CONVERSIONS', operation_status: 'ENABLE', budget: 150, budget_mode: 'BUDGET_MODE_DAY', create_time: '2026-11-01 10:00:00' },
            { campaign_id: '5002', campaign_name: 'Reach', objective_type: 'REACH', operation_status: 'DISABLE', budget: 0 },
          ],
          page_info: { total_number: 2 },
        });
      }
      case '/adgroup/get/': {
        { const byId = byIdQuery('adgroups', query); if (byId) return byId; }
        if (state.failAdgroupsFor.has(query.advertiser_id)) return reply({}, 40001, 'No permission to get ad groups');
        if (state.rateLimitFor.has(query.advertiser_id)) return reply({}, 40100, 'Too many requests');
        if (Number(query.page_size) > 1000 || Number(query.page_size) < 1) return reply({}, 40002, 'page_size must be between 1 and 1000');
        return pagedList(notDeleted(adgroupsOf(query.advertiser_id) ?? [], query), query, query.fields ? JSON.parse(query.fields) : null);
      }
      case '/campaign/status/update/':
        campaignsOf(body?.advertiser_id);
        return updateStatus(body, { list: state.campaigns[body?.advertiser_id], idField: 'campaign_id', idsField: 'campaign_ids', enabled: 'CAMPAIGN_STATUS_ENABLE', disabled: 'CAMPAIGN_STATUS_DISABLE', failFor: state.failCampaignStatusFor });
      case '/adgroup/status/update/':
        adgroupsOf(body?.advertiser_id);
        return updateStatus(body, { list: state.adgroups[body?.advertiser_id], idField: 'adgroup_id', idsField: 'adgroup_ids', enabled: 'ADGROUP_STATUS_DELIVERY_OK', disabled: 'ADGROUP_STATUS_DISABLE', failFor: state.failAdgroupStatusFor });
      case '/report/integrated/get/': {
        if (query.advertiser_ids !== undefined || query.query_lifetime !== undefined) { // gasto vitalício de várias contas (documentação oficial do relatório v1.3)
          const ids = JSON.parse(query.advertiser_ids ?? '[]');
          if (!Array.isArray(ids) || !ids.length || ids.length > 5) return reply({}, 40002, 'advertiser_ids: max size is 5');
          if (!ids.every((id) => /^\d{1,24}$/.test(String(id)))) return reply({}, 40002, 'advertiser_ids is invalid');
          if (query.advertiser_id !== undefined) return reply({}, 40002, 'Use advertiser_id OR advertiser_ids');
          if (query.report_type !== 'BASIC' || query.data_level !== 'AUCTION_ADVERTISER') return reply({}, 40002, 'Lifetime metrics need report_type BASIC and data_level AUCTION_ADVERTISER');
          if (JSON.stringify(JSON.parse(query.dimensions ?? '[]')) !== JSON.stringify(['advertiser_id'])) return reply({}, 40002, 'Use dimensions ["advertiser_id"] with advertiser_ids');
          if (query.query_lifetime !== 'true') return reply({}, 40002, 'query_lifetime must be true');
          if (query.start_date !== undefined || query.end_date !== undefined) return reply({}, 40002, 'start_date and end_date are ignored with query_lifetime');
          if (Number(query.page_size) < 1 || Number(query.page_size) > 1000) return reply({}, 40002, 'page_size must be between 1 and 1000');
          if (state.lifetimeRateLimited) return reply({}, 40100, 'Too many requests');
          if (ids.some((id) => state.failLifetimeFor.has(String(id)))) return reply({}, 40002, 'No permission to access one of the advertisers');
          const rows = ids.filter((id) => state.lifetimeSpend[id]).map((id) => ({ dimensions: { advertiser_id: String(id) }, metrics: { spend: String(state.lifetimeSpend[id].spend), currency: state.lifetimeSpend[id].currency } }));
          return reply({ list: rows, page_info: { page: 1, page_size: Number(query.page_size), total_number: rows.length, total_page: 1 } });
        }
        if (query.dimensions?.includes('stat_time_hour')) {
          if (state.hourlyDelayMs) await new Promise((r) => setTimeout(r, state.hourlyDelayMs));
          if (state.failHourlyFor.has(query.advertiser_id)) return reply({}, 50001, 'Internal error');
          if (query.start_date !== query.end_date) return reply({}, 40002, 'The time range cannot exceed 1 day when stat_time_hour is used');
          const day = state.hourly[query.advertiser_id]?.[query.start_date] ?? {};
          return reply({
            list: Object.entries(day).map(([hour, m]) => ({
              dimensions: { stat_time_hour: `${query.start_date} ${String(hour).padStart(2, '0')}:00:00` },
              metrics: { spend: String(m.spend ?? 0), impressions: String(m.impressions ?? 0), clicks: String(m.clicks ?? 0), conversion: String(m.conversion ?? 0) },
            })),
            page_info: { page: 1, total_page: 1 },
          });
        }
        const LEVEL_DIMENSION = { AUCTION_AD: 'ad_id', AUCTION_ADGROUP: 'adgroup_id', AUCTION_CAMPAIGN: 'campaign_id' };
        if (LEVEL_DIMENSION[query.data_level]) { // relatório por campanha / grupo / anúncio (documentação oficial: UMA dimensão de ID, page_size até 1000)
          const dimension = LEVEL_DIMENSION[query.data_level];
          if (JSON.stringify(JSON.parse(query.dimensions ?? '[]')) !== JSON.stringify([dimension])) return reply({}, 40002, `Invalid dimensions for ${query.data_level}: use ["${dimension}"]`);
          if (state.failReportFor.has(query.advertiser_id)) return reply({}, 50001, 'Internal error');
          if (Number(query.page_size) > 1000) return reply({}, 40002, 'page_size must be between 1 and 1000');
          const metricsAsked = JSON.parse(query.metrics ?? '[]');
          if (state.rejectResultMetric && metricsAsked.includes('result')) return reply({}, 40002, 'Invalid metric: result');
          const byDate = state.adMetricsByDate[query.advertiser_id]?.[query.start_date];
          const source = query.start_date === query.end_date && byDate ? byDate : (state.adMetrics[query.advertiser_id] ?? {});
          const grouped = dimension === 'ad_id' ? source : aggregateMetrics(query.advertiser_id, dimension, source);
          const rows = Object.entries(grouped).map(([id, m]) => ({ dimensions: { [dimension]: id }, metrics: Object.fromEntries(metricsAsked.filter((k) => k in m).map((k) => [k, String(m[k])])) }));
          const size = Number(query.page);
          const per = Number(query.page_size);
          return reply({ list: rows.slice((size - 1) * per, size * per), page_info: { page: size, page_size: per, total_number: rows.length, total_page: Math.max(1, Math.ceil(rows.length / per)) } });
        }
        if (state.failReportFor.has(query.advertiser_id)) return reply({}, 50001, 'Internal error');
        return reply({
          list: [
            { dimensions: { stat_time_day: '2026-11-19 00:00:00' }, metrics: { spend: '10.50', impressions: '1000', clicks: '50', conversion: '2' } },
            { dimensions: { stat_time_day: '2026-11-18 00:00:00' }, metrics: { spend: '4.50', impressions: '500', clicks: '10', conversion: '1' } },
          ],
        });
      }
      case '/bc/account/transaction/get/': {
        if (!/^\d{1,24}$/.test(String(query.bc_id ?? ''))) return reply({}, 40002, 'bc_id is required');
        if (state.failTransactionsBc.has(query.bc_id)) return reply({}, 40001, 'No permission: only a Finance Manager or Finance Analyst can get transaction records');
        const level = query.transaction_level ?? 'ADVERTISER';
        if (!['BC', 'ADVERTISER', 'PAYMENT_PORTFOLIO'].includes(level)) return reply({}, 40002, 'transaction_level is invalid');
        const filtering = query.filtering ? JSON.parse(query.filtering) : {};
        const TYPES = ['BILL_PAYMENT', 'ADD_BALANCE', 'CANCELLATION', 'PROMOTION_ISSUED', 'PROMOTION_EXPIRED', 'INCREASE_BALANCE', 'DECREASE_BALANCE', 'CARD_VERIFICATION', 'CARD_VERIFICATION_REFUND', 'ORDER_CREATION_PAYMENT', 'ORDER_EDIT_PAYMENT', 'RETURN_OF_REMAINING_BUDGET', 'REFUND'];
        if (filtering.transaction_types && !(Array.isArray(filtering.transaction_types) && filtering.transaction_types.every((t) => TYPES.includes(t)))) return reply({}, 40002, 'transaction_types is invalid');
        if (filtering.account_ids !== undefined && (level !== 'ADVERTISER' || !Array.isArray(filtering.account_ids) || filtering.account_ids.length > 100)) return reply({}, 40002, 'account_ids is only valid with transaction_level ADVERTISER (max size 100)');
        const TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
        if ((filtering.start_time && !TIME.test(filtering.start_time)) || (filtering.end_time && !TIME.test(filtering.end_time))) return reply({}, 40002, 'start_time/end_time format is YYYY-MM-DD HH:MM:SS');
        const toMs = (t) => Date.parse(`${t.replace(' ', 'T')}Z`);
        if (filtering.start_time && filtering.end_time && toMs(filtering.end_time) - toMs(filtering.start_time) > 365 * 86_400_000) return reply({}, 40002, 'The maximum query time range is 365 days');
        const size = Number(query.page_size ?? 10);
        if (!Number.isInteger(size) || size < 1 || size > 50) return reply({}, 40002, 'page_size must be between 1 and 50');
        const page = Number(query.page ?? 1);
        if (!Number.isInteger(page) || page < 1) return reply({}, 40002, 'page must be >= 1');
        let all = (state.transactions[query.bc_id] ?? []).filter((t) => (level === 'BC' ? !t.account_id : Boolean(t.account_id)));
        if (filtering.transaction_types) all = all.filter((t) => filtering.transaction_types.includes(t.transaction_type));
        if (filtering.account_ids) all = all.filter((t) => filtering.account_ids.includes(t.account_id));
        if (filtering.start_time) all = all.filter((t) => toMs(t.create_time) >= toMs(filtering.start_time));
        if (filtering.end_time) all = all.filter((t) => toMs(t.create_time) <= toMs(filtering.end_time));
        all = [...all].sort((a, b) => b.create_time.localeCompare(a.create_time));
        const list = all.slice((page - 1) * size, page * size).map((t) => ({ ...t, bc_id: query.bc_id, payment_portfolio_id: null, payment_portfolio_name: null, invoice_id: null }));
        return reply({ transaction_list: list, page_info: { page, page_size: size, total_number: all.length, total_page: Math.max(1, Math.ceil(all.length / size)) } });
      }
      case '/file/image/ad/upload/':
        state.uploadCalls.image = (state.uploadCalls.image ?? 0) + 1;
        if (state.failUpload.has('image') || state.failUploadOnCall.image === state.uploadCalls.image) return reply({}, 40002, 'Image file is invalid');
        return reply({ image_id: `ad-site-i18n/img${++state.nextId}`, width: 100, height: 100 });
      case '/file/video/ad/upload/':
        if (state.failUpload.has('video')) return reply({}, 40002, 'Video file is invalid');
        return reply([{ video_id: `v10033g5000video${++state.nextId}`, duration: 5 }]);
      // ---------- Catálogo (Catalog API v1.3) ----------
      case '/catalog/get/': {
        if (state.failCatalogFor.has(query.bc_id)) return reply({}, 40002, 'No permission to access catalog assets');
        if (!query.bc_id) return reply({}, 40002, 'bc_id is required');
        const size = Number(query.page_size ?? 10);
        if (size < 1 || size > 1000) return reply({}, 40002, 'page_size must be between 1 and 1000');
        const page = Number(query.page ?? 1);
        let all = state.catalogs[query.bc_id] ?? [];
        if (query.catalog_id) all = all.filter((c) => c.catalog_id === query.catalog_id);
        return reply({ list: all.slice((page - 1) * size, page * size), page_info: { page, page_size: size, total_number: all.length, total_page: Math.max(1, Math.ceil(all.length / size)) } });
      }
      case '/catalog/available_country/get/':
        if (state.failCatalogFor.has(query.bc_id)) return reply({}, 40002, 'No permission to access catalog assets');
        if (!query.bc_id) return reply({}, 40002, 'bc_id is required');
        return reply({ region_codes: state.catalogRegions });
      case '/catalog/location_currency/get/':
        return reply({ list: state.locationCurrencies });
      case '/catalog/create/': {
        if (state.failCatalogFor.has(body?.bc_id)) return reply({}, 40002, 'No permission to create catalogs');
        if (typeof body?.bc_id !== 'string' || !body.bc_id) return reply({}, 40002, 'bc_id is required (string)');
        if (!body.name || body.name.length > 128) return reply({}, 40002, 'name is required (up to 128 characters)');
        if (!['ECOM', 'HOTEL', 'FLIGHT', 'DESTINATION', 'ENTERTAINMENT', 'AUTO_VEHICLE', 'AUTO_MODEL', 'MINI_SERIES', 'GENERIC', 'ONLINE_TO_OFFLINE'].includes(body.catalog_type)) return reply({}, 40002, 'catalog_type is invalid');
        const conf = body.catalog_conf;
        if (!conf || typeof conf !== 'object') return reply({}, 40002, 'catalog_conf is required');
        if (!state.catalogRegions.includes(conf.region_code)) return reply({}, 40002, 'region_code is not supported');
        if (!state.locationCurrencies.find((l) => l.location === conf.region_code)?.currency.includes(conf.currency)) return reply({}, 40002, 'currency is not supported for this region');
        if (state.catalogOnlyRegion[body.bc_id] && conf.region_code !== state.catalogOnlyRegion[body.bc_id]) return reply({}, 40002, "Invalid Param: Please ensure the currency matches the selected country (e.g., 'United States' should use 'USD').");
        const id = String(++state.nextId);
        (state.catalogs[body.bc_id] ??= []).push({
          catalog_id: id, catalog_name: body.name, catalog_type: body.catalog_type, ad_creation_eligible: 'NOT_AVAILABLE',
          create_time: '2026-11-24 10:00:00', update_time: '2026-11-24 10:00:00', bc_info: { bc_id: body.bc_id, bc_name: `BC ${body.bc_id}`, picture_url: '' },
          catalog_conf: { country: conf.region_code, currency: conf.currency, channel: 'CLIENT' },
        });
        state.catalogProducts[id] = [];
        return reply({ catalog_id: id });
      }
      case '/catalog/overview/': {
        if (state.failCatalogFor.has(query.bc_id)) return reply({}, 40002, 'No permission to access catalog assets');
        if (!catalogOf(query.bc_id, query.catalog_id)) return reply({}, 40002, 'Catalog not found');
        const list = state.catalogProducts[query.catalog_id] ?? [];
        const count = (status) => list.filter((p) => p.audit.audit_status === status).length;
        return reply({ approved: count('approved'), rejected: count('rejected'), processing: count('processing') });
      }
      case '/catalog/product/upload/': {
        if (state.failCatalogFor.has(body?.bc_id)) return reply({}, 40002, 'No permission to upload products');
        if (typeof body?.bc_id !== 'string' || !catalogOf(body.bc_id, body?.catalog_id)) return reply({}, 40002, 'Catalog not found');
        if (!Array.isArray(body.products) || body.products.length < 1 || body.products.length > 5000) return reply({}, 40002, 'products: allowed size 1-5000');
        const skus = new Set();
        for (const [index, p] of body.products.entries()) {
          const missing = ECOM_REQUIRED(p);
          if (missing.length) return reply({}, 40002, `products[${index}]: invalid or missing ${missing.join(', ')}`);
          if (skus.has(p.sku_id)) return reply({}, 40002, `Duplicate SKU IDs are not supported: ${p.sku_id}`);
          skus.add(p.sku_id);
        }
        const list = (state.catalogProducts[body.catalog_id] ??= []);
        let add = 0; let update = 0; let errors = 0;
        const errorItems = [];
        body.products.forEach((p, index) => {
          if (state.rejectProductSkus.has(p.sku_id)) { errors += 1; errorItems.push({ index: index + 2, sku_id: p.sku_id, title: p.title }); return; }
          const entry = { ...p, audit: { audit_status: 'approved' }, active_status: 'ACTIVATED', image_status: 'SUCCESS' };
          const at = list.findIndex((x) => x.sku_id === p.sku_id);
          if (at >= 0) { list[at] = entry; update += 1; } else { list.push(entry); add += 1; }
        });
        const bc = body.bc_id;
        if (list.some((p) => ['IN_STOCK', 'AVAILABLE_FOR_ORDER', 'PREORDER'].includes(p.availability))) catalogOf(bc, body.catalog_id).ad_creation_eligible = 'AVAILABLE';
        const feedLogId = String(++state.nextId);
        state.catalogFeedLogs[feedLogId] = {
          catalog_id: body.catalog_id, add_count: add, update_count: update, delete_count: 0, error_count: errors, warn_count: 0, process_status: 'SUCCESS', update_mode: 'INCREASE',
          start_time: '2026-11-24 10:00:00', end_time: '2026-11-24 10:00:01',
          feed_log_data: errors ? { error_affected_products: [{ affected_product_count: errors, affected_product_item_list: errorItems, field: 'image_url', issue: 'Image is too small', suggestion: 'Upload an image of at least 500x500 px.' }], warn_affected_products: [] } : { error_affected_products: [], warn_affected_products: [] },
        };
        return reply({ feed_log_id: feedLogId });
      }
      case '/catalog/product/log/': {
        if (!query.bc_id || !query.catalog_id || !query.feed_log_id) return reply({}, 40002, 'bc_id, catalog_id and feed_log_id are required');
        const log = state.catalogFeedLogs[query.feed_log_id];
        if (!log || log.catalog_id !== query.catalog_id) return reply({}, 40002, 'Feed log not found');
        return reply({ product_feed_log: log });
      }
      case '/catalog/product/get/': {
        if (state.failCatalogFor.has(query.bc_id)) return reply({}, 40002, 'No permission to access catalog assets');
        if (!catalogOf(query.bc_id, query.catalog_id)) return reply({}, 40002, 'Catalog not found');
        const size = Number(query.page_size ?? 10);
        if (size < 1 || size > 500) return reply({}, 40002, 'page_size must be within 500');
        const page = Number(query.page ?? 1);
        if (page * size > 10000) return reply({}, 40002, 'page * page_size must be no more than 10,000');
        let all = state.catalogProducts[query.catalog_id] ?? [];
        if (query.sku_ids) { const wanted = JSON.parse(query.sku_ids); all = all.filter((p) => wanted.includes(p.sku_id)); }
        const toListItem = (p) => ({ sku_id: p.sku_id, title: p.title, brand: p.brand, availability: p.availability, image_url: p.image_url, audit: p.audit, active_status: p.active_status, image_status: p.image_status, price: { price: p.price_info.price, sale_price: p.price_info.sale_price, currency: 'USD' }, ad_creation_eligible: p.audit.audit_status === 'approved' && ['IN_STOCK', 'AVAILABLE_FOR_ORDER', 'PREORDER'].includes(p.availability) ? 'AVAILABLE' : 'NOT_AVAILABLE' });
        if (query.product_available_type === 'AVAILABLE') all = all.filter((p) => toListItem(p).ad_creation_eligible === 'AVAILABLE');
        return reply({ list: all.slice((page - 1) * size, page * size).map(toListItem), page_info: { page, page_size: size, total_number: all.length, total_page: Math.max(1, Math.ceil(all.length / size)) } });
      }
      case '/catalog/feed/get/': {
        if (state.failCatalogFor.has(query.bc_id)) return reply({}, 40002, 'No permission to access catalog assets');
        if (!catalogOf(query.bc_id, query.catalog_id)) return reply({}, 40002, 'Catalog not found');
        const manual = { feed_id: `m${query.catalog_id}`.replace(/^m/, '1'), feed_name: 'default', feed_type: 'DATA_FEED', status: 'OFF', last_update_param: { uri: null, update_mode: 'INCREMENTAL', interval_type: null, interval_count: null, timezone: null, hour: null, minute: null, day_of_month: null }, next_update_time: null, number_of_products: (state.catalogProducts[query.catalog_id] ?? []).length };
        return reply({ feed_list: [manual, ...(state.catalogFeeds[query.catalog_id] ?? [])] });
      }
      case '/catalog/feed/create/': {
        if (state.failCatalogFor.has(body?.bc_id)) return reply({}, 40002, 'No permission to create feeds');
        if (!catalogOf(body?.bc_id, body?.catalog_id)) return reply({}, 40002, 'Catalog not found');
        if (!body.feed_name) return reply({}, 40002, 'feed_name is required');
        if (!['INCREMENTAL', 'OVERWRITE'].includes(body.update_mode)) return reply({}, 40002, 'update_mode is invalid');
        const sp = body.schedule_param;
        if (!sp?.source?.uri || !/^(https?|s?ftp):\/\//.test(sp.source.uri)) return reply({}, 40002, 'schedule_param.source.uri must start with http, https, ftp or sftp');
        if (!['HOURLY', 'DAILY', 'MONTHLY'].includes(sp.interval_type)) return reply({}, 40002, 'interval_type is invalid');
        const limits = { HOURLY: [1, 23], DAILY: [1, 30], MONTHLY: [1, 12] }[sp.interval_type];
        if (!(sp.interval_count >= limits[0] && sp.interval_count <= limits[1])) return reply({}, 40002, `interval_count must be ${limits[0]}-${limits[1]} for ${sp.interval_type}`);
        if (!sp.timezone) return reply({}, 40002, 'timezone is required');
        if (!(sp.hour >= 0 && sp.hour <= 23) || !(sp.minute >= 0 && sp.minute <= 59)) return reply({}, 40002, 'hour/minute out of range');
        if (sp.interval_type === 'MONTHLY' && !(sp.day_of_month >= 1)) return reply({}, 40002, 'day_of_month is required for MONTHLY');
        if (!!sp.source.username !== !!sp.source.password) return reply({}, 40002, 'username and password must be passed together');
        const id = String(++state.nextId);
        if (sp.source.username) state.feedCredentials.push({ feed_id: id, username: sp.source.username, password: sp.source.password });
        const feed = { feed_id: id, feed_name: body.feed_name, feed_type: 'DATA_FEED', status: 'ON', last_update_param: { uri: sp.source.uri, update_mode: body.update_mode, interval_type: sp.interval_type, interval_count: sp.interval_count, timezone: sp.timezone, hour: sp.hour, minute: sp.minute, day_of_month: sp.day_of_month ?? null }, next_update_time: '2026-11-25 10:22:00', number_of_products: 0 };
        (state.catalogFeeds[body.catalog_id] ??= []).push(feed);
        state.catalogFeedLogs2[id] = [{ last_update_status: { add_count: 3, update_count: 1, remove_count: 0, error_count: 0, warn_count: 1, process_status: 'SUCCESS' }, last_update_time: { start_time: '2026-11-24 10:22:00', end_time: '2026-11-24 10:22:09' } }];
        return reply({ feed_id: id, feed_name: feed.feed_name, status: 'ON', next_update_time: feed.next_update_time, last_update_param: feed.last_update_param });
      }
      case '/catalog/feed/switch/': {
        const feed = (state.catalogFeeds[body?.catalog_id] ?? []).find((f) => f.feed_id === body?.feed_id);
        if (!feed) return reply({}, 40002, 'Feed not found');
        if (!['ON', 'OFF'].includes(body.status)) return reply({}, 40002, 'status is invalid');
        if (feed.status === body.status) return reply({}, 40002, `The feed schedule status is already ${body.status}`);
        feed.status = body.status;
        return reply({});
      }
      case '/catalog/feed/delete/': {
        const list = state.catalogFeeds[body?.catalog_id] ?? [];
        const at = list.findIndex((f) => f.feed_id === body?.feed_id);
        if (at < 0) return reply({}, 40002, 'Feed not found');
        list.splice(at, 1);
        return reply({ feed_id: body.feed_id });
      }
      case '/catalog/feed/log/': {
        if (!query.feed_id) return reply({}, 40002, 'feed_id is required');
        return reply({ feed_logs: state.catalogFeedLogs2[query.feed_id] ?? [] });
      }
      case '/catalog/set/get/': {
        if (!catalogOf(query.bc_id, query.catalog_id)) return reply({}, 40002, 'Catalog not found');
        return reply({ list: state.catalogSets[query.catalog_id] ?? [] });
      }
      case '/catalog/set/create/': {
        if (!catalogOf(body?.bc_id, body?.catalog_id)) return reply({}, 40002, 'Catalog not found');
        if (!body.product_set_name || body.product_set_name.length > 128) return reply({}, 40002, 'product_set_name is required (up to 128 characters)');
        const rules = body.conditions?.and ?? body.conditions?.or;
        if (!Array.isArray(rules) || !rules.length) return reply({}, 40002, 'conditions is required');
        const FIELDS = { title: ['EQUAL', 'NOT_EQUAL', 'WILDCARD', 'I_WILDCARD', 'NOT_WILDCARD', 'I_NOT_WILDCARD', 'PREFIX', 'I_PREFIX'], brand: ['CONTAIN', 'I_CONTAIN', 'EXCLUDE', 'I_EXCLUDE', 'WILDCARD', 'I_WILDCARD', 'NOT_WILDCARD', 'I_NOT_WILDCARD', 'PREFIX', 'I_PREFIX', 'NOT_EQUAL'], availability: ['EQUAL', 'NOT_EQUAL'], condition: ['EQUAL', 'NOT_EQUAL'], price: ['GT', 'GTE', 'LT', 'LTE', 'EQUAL'] };
        for (const r of rules) if (!FIELDS[r.field]?.includes(r.operation) || r.value === undefined) return reply({}, 40002, `invalid condition ${r.field} ${r.operation}`);
        const id = String(++state.nextId);
        const set = { product_set_id: id, catalog_id: body.catalog_id, product_set_name: body.product_set_name, product_count: (state.catalogProducts[body.catalog_id] ?? []).length, conditions: body.conditions };
        (state.catalogSets[body.catalog_id] ??= []).push(set);
        return reply({ product_set_id: id, product_set_name: set.product_set_name, product_count: set.product_count });
      }

      case '/campaign/create/':
        if (state.failForAdvertiser.get(body?.advertiser_id) === 'campaign') return reply({}, 40002, 'Campaign name already exists');
        if (state.failCreate.has('campaign')) return reply({}, 40002, state.failCampaignMessage || 'Campaign name already exists');
        if (state.strictCatalog && catalogCampaignError(body)) return reply({}, 40002, catalogCampaignError(body));
        if (state.uniqueCampaignNames) {
          const used = (state.campaignNamesByAdvertiser[body?.advertiser_id] ??= new Set());
          if (used.has(body?.campaign_name)) return reply({}, 40002, 'Campaign name already exists. Please try another one.');
          used.add(body?.campaign_name);
        }
        state.campaignsById[String(state.nextId + 1)] = body;
        registerCreated('campaigns', 'campaign', state.nextId + 1, body?.advertiser_id, body?.operation_status);
        return reply({ campaign_id: String(++state.nextId) });
      case '/adgroup/create/':
        if (state.failForAdvertiser.get(body?.advertiser_id) === 'adGroup') return reply({}, 40002, 'Invalid optimization goal for this objective');
        if (state.failCreate.has('adGroup')) return reply({}, 40002, 'Invalid optimization goal for this objective');
        // Comportamento real do TikTok: o evento de conversão precisa existir NO PIXEL (só confere quando o pixel da conta declara `events`).
        if (body?.pixel_id && body?.optimization_event) {
          const pixel = (state.pixels[body.advertiser_id] ?? []).find((p) => p.pixel_id === body.pixel_id);
          if (Array.isArray(pixel?.events) && !pixel.events.some((e) => e.optimization_event === body.optimization_event)) return reply({}, 40002, 'This pixel event type does not exist. Please make sure that you have created the pixel event in Events Manager.');
        }
        if (state.strictCatalog && catalogAdGroupError(body)) return reply({}, 40002, catalogAdGroupError(body));
        if (state.droppedIds.has(String(body?.campaign_id))) return reply({}, 40002, 'The campaign does not exist.');
        state.adgroupsById[String(state.nextId + 1)] = body;
        registerCreated('adgroups', 'adgroup', state.nextId + 1, body?.advertiser_id, body?.operation_status);
        return reply({ adgroup_id: String(++state.nextId) });
      case '/ad/create/':
        if (state.failForAdvertiser.get(body?.advertiser_id) === 'ad') return reply({}, 40002, 'Identity not found');
        if (state.failCreate.has('ad')) return reply({}, 40002, 'Identity not found');
        if (state.strictCatalog) {
          const problem = catalogAdError(body?.creatives?.[0] ?? {}, state.adgroupsById[body?.adgroup_id]);
          if (problem) return reply({}, 40002, problem);
        }
        if (state.droppedIds.has(String(body?.adgroup_id))) return reply({}, 40002, 'The ad group does not exist.');
        registerCreated('ads', 'ad', state.nextId + 1, body?.advertiser_id, body?.creatives?.[0]?.operation_status);
        return reply({ ad_ids: [String(++state.nextId)] });
      default:
        return reply({}, 40000, 'Unknown path');
    }
  };

  return { state, fetchFn, grantAuthCode, deleteCreated, callsTo: (path) => state.calls.filter((c) => c.path === path) };
}
