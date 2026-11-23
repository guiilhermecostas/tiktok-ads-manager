import { randomBytes } from 'node:crypto';

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

  const jsonReply = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

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
        return reply({ list: ids.map((id) => ({ advertiser_id: id, name: `Conta ${id}`, currency: state.currencies[id] ?? 'BRL', timezone: 'America/Sao_Paulo', ...(state.omitOwnerBc || !ownerOf(id) ? {} : { owner_bc_id: ownerOf(id) }) })) });
      }
      case '/pixel/list/': {
        if (state.failPixels) return reply(null, 40002, 'No permission to access pixels');
        const all = state.pixels[query.advertiser_id] ?? [];
        const size = Number(query.page_size);
        const page = Number(query.page);
        return reply({ pixels: all.slice((page - 1) * size, page * size), page_info: { page, page_size: size, total_number: all.length, total_page: Math.max(1, Math.ceil(all.length / size)) } });
      }
      case '/campaign/get/': {
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
      case '/report/integrated/get/': {
        if (state.failReportFor.has(query.advertiser_id)) return reply({}, 50001, 'Internal error');
        return reply({
          list: [
            { dimensions: { stat_time_day: '2026-11-19 00:00:00' }, metrics: { spend: '10.50', impressions: '1000', clicks: '50', conversion: '2' } },
            { dimensions: { stat_time_day: '2026-11-18 00:00:00' }, metrics: { spend: '4.50', impressions: '500', clicks: '10', conversion: '1' } },
          ],
        });
      }
      case '/file/image/ad/upload/':
        state.uploadCalls.image = (state.uploadCalls.image ?? 0) + 1;
        if (state.failUpload.has('image') || state.failUploadOnCall.image === state.uploadCalls.image) return reply({}, 40002, 'Image file is invalid');
        return reply({ image_id: `ad-site-i18n/img${++state.nextId}`, width: 100, height: 100 });
      case '/file/video/ad/upload/':
        if (state.failUpload.has('video')) return reply({}, 40002, 'Video file is invalid');
        return reply([{ video_id: `v10033g5000video${++state.nextId}`, duration: 5 }]);
      case '/campaign/create/':
        if (state.failForAdvertiser.get(body?.advertiser_id) === 'campaign') return reply({}, 40002, 'Campaign name already exists');
        if (state.failCreate.has('campaign')) return reply({}, 40002, 'Campaign name already exists');
        return reply({ campaign_id: String(++state.nextId) });
      case '/adgroup/create/':
        if (state.failForAdvertiser.get(body?.advertiser_id) === 'adGroup') return reply({}, 40002, 'Invalid optimization goal for this objective');
        if (state.failCreate.has('adGroup')) return reply({}, 40002, 'Invalid optimization goal for this objective');
        return reply({ adgroup_id: String(++state.nextId) });
      case '/ad/create/':
        if (state.failForAdvertiser.get(body?.advertiser_id) === 'ad') return reply({}, 40002, 'Identity not found');
        if (state.failCreate.has('ad')) return reply({}, 40002, 'Identity not found');
        return reply({ ad_ids: [String(++state.nextId)] });
      default:
        return reply({}, 40000, 'Unknown path');
    }
  };

  return { state, fetchFn, grantAuthCode, callsTo: (path) => state.calls.filter((c) => c.path === path) };
}
