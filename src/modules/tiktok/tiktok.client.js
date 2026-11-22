import fs from 'node:fs';
import { HttpError } from '../../lib/http-error.js';
import { describeProxyError } from '../proxies/proxy-errors.js';

const API_PREFIX = '/open_api/v1.3';
const TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 300_000; // envio de vídeo pode demorar
const MAX_PAGES = 10;
const INFO_CHUNK = 100;
// Limites de página documentados no SDK oficial: bc/asset/get aceita no máximo 50; campaign/get, até 1000.
const BC_ASSET_PAGE_SIZE = 50;
const CAMPAIGN_PAGE_SIZE = 100;
const CAMPAIGN_MAX_PAGES = 5;
// Códigos que indicam token revogado/inválido: é preciso trocar o token da Business Center.
const TOKEN_ERROR_CODES = new Set([40104, 40105]);
// Limite de requisições do TikTok (código 40100 e mensagens equivalentes).
const RATE_LIMIT_CODES = new Set([40100]);

/** IDs de mídia do TikTok não são numéricos (ex.: "v10033g50000…", "ad-site-i18n/2020…"). */
function requireMediaId(value, what) {
  const id = String(value ?? '');
  if (!/^(?!.*(?:\.\.|\/\/))[A-Za-z0-9][\w\-./:]{2,198}[A-Za-z0-9]$/.test(id)) throw new HttpError(502, `O TikTok não retornou o ID ${what}.`, 'tiktok_bad_response');
  return id;
}

function requireId(value, what) {
  const id = String(value ?? '');
  if (!/^\d{1,24}$/.test(id)) throw new HttpError(502, `O TikTok não retornou o ID ${what}.`, 'tiktok_bad_response');
  return id;
}

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Cliente mínimo da TikTok Marketing/Business API (v1.3). Isolado do restante do sistema:
 * recebe `fetchFn` por injeção (testável sem rede) e NUNCA registra o token em log.
 * Os formatos de resposta são lidos de forma defensiva, pois variam entre endpoints/versões.
 */
export function createTiktokClient({ config, fetchFn = fetch, route = null }) {
  const { apiBase } = config.tiktok;

  async function call(path, { token, query, method = 'GET', body, form, timeoutMs = TIMEOUT_MS }) {
    const url = new URL(`${API_PREFIX}${path}`, apiBase);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }

    let response;
    try {
      response = await fetchFn(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(token ? { 'Access-Token': token } : {}), // a troca do código de autorização ainda não tem token
          // Com FormData o fetch define o Content-Type (com o "boundary") sozinho.
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(timeoutMs),
        // Com proxy ativa, TODA chamada sai por ela. Se ela falhar, a chamada falha (abaixo): nunca há conexão direta de reserva.
        ...(route ? { dispatcher: route.dispatcher } : {}),
      });
    } catch (err) {
      if (route) {
        throw new HttpError(502, `Não foi possível falar com o TikTok pela proxy "${route.name}": ${describeProxyError(err)}. Nada foi enviado fora da proxy. Teste ou troque a proxy em Contas TikTok → Proxy.`, 'proxy_error');
      }
      throw new HttpError(502, 'Não foi possível contatar o TikTok. Tente novamente em instantes.', 'tiktok_unreachable');
    }

    let json;
    try {
      json = await response.json();
    } catch {
      throw new HttpError(502, 'Resposta inválida do TikTok.', 'tiktok_bad_response');
    }
    // Sucesso = code 0. O SDK oficial documenta o `code` como "presente em erros", então um envelope
    // sem `code` mas com `data` também é aceito; qualquer outra coisa é erro.
    const code = json?.code;
    const succeeded = code === 0 || (code === undefined && json !== null && typeof json === 'object' && json.data !== undefined);
    if (!succeeded) {
      const message = String(json?.message ?? 'Erro desconhecido').slice(0, 200);
      if (TOKEN_ERROR_CODES.has(code) || /access.?token/i.test(message)) {
        throw new HttpError(409, 'O token desta Business Center é inválido, expirou ou foi revogado.', 'tiktok_reauth');
      }
      if (RATE_LIMIT_CODES.has(code) || response.status === 429 || /too many|rate.?limit|frequency/i.test(message)) {
        const err = new HttpError(429, 'O TikTok limitou as requisições. Aguarde alguns instantes e tente novamente.', 'tiktok_rate_limited');
        err.retryAfterSec = 30;
        throw err;
      }
      throw new HttpError(502, `TikTok: ${message}`, 'tiktok_error');
    }
    return json.data ?? {};
  }

  return {
    /** Mesmo cliente, mas com todas as chamadas saindo pela rota (proxy) informada. */
    through: (nextRoute) => createTiktokClient({ config, fetchFn, route: nextRoute }),

    /** IDs das contas de anúncio atribuídas à Business Center (paginado). Também valida o token. */
    async listBusinessCenterAdvertiserIds(token, bcId) {
      const ids = new Set();
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const data = await call('/bc/asset/get/', {
          token,
          query: { bc_id: bcId, asset_type: 'ADVERTISER', page, page_size: BC_ASSET_PAGE_SIZE },
        });
        const list = Array.isArray(data.list) ? data.list : [];
        for (const item of list) {
          const id = String(item.asset_id ?? item.advertiser_id ?? '');
          if (/^\d{1,24}$/.test(id)) ids.add(id);
        }
        const totalPages = num(data.page_info?.total_page);
        if (!list.length || page >= (totalPages || 1)) break;
      }
      return [...ids];
    },

    /** Detalhes (nome, moeda, fuso) das contas de anúncio. */
    async getAdvertiserInfo(token, advertiserIds) {
      const result = [];
      for (const ids of chunk(advertiserIds, INFO_CHUNK)) {
        const data = await call('/advertiser/info/', { token, query: { advertiser_ids: ids } });
        for (const a of data.list ?? []) {
          result.push({
            id: String(a.advertiser_id),
            name: String(a.name ?? a.advertiser_name ?? a.advertiser_id),
            currency: a.currency ?? null,
            timezone: a.timezone ?? null,
          });
        }
      }
      return result;
    },

    /** Campanhas da conta (paginado: até CAMPAIGN_MAX_PAGES páginas; `total` é o total real no TikTok). */
    async getCampaigns(token, advertiserId) {
      const campaigns = [];
      let total = 0;
      for (let page = 1; page <= CAMPAIGN_MAX_PAGES; page += 1) {
        const data = await call('/campaign/get/', {
          token,
          query: { advertiser_id: advertiserId, page, page_size: CAMPAIGN_PAGE_SIZE },
        });
        const list = Array.isArray(data.list) ? data.list : [];
        for (const c of list) {
          campaigns.push({
            id: String(c.campaign_id),
            name: String(c.campaign_name ?? ''),
            objective: c.objective_type ?? null,
            status: c.operation_status ?? c.secondary_status ?? null,
            budget: num(c.budget),
            budgetMode: c.budget_mode ?? null,
            createdAt: c.create_time ?? null,
          });
        }
        total = num(data.page_info?.total_number) || campaigns.length;
        const totalPages = num(data.page_info?.total_page);
        if (!list.length || list.length < CAMPAIGN_PAGE_SIZE || page >= (totalPages || page)) break;
      }
      return { campaigns, total: Math.max(total, campaigns.length) };
    },

    /**
     * Troca o `auth_code` (vem no retorno da autorização; uso único) pelo token de acesso.
     * Resposta: { accessToken, advertiserIds }. As credenciais do app seguem só no corpo JSON (nunca em URL).
     */
    async exchangeAuthCode({ appId, appSecret, authCode }) {
      const data = await call('/oauth2/access_token/', { method: 'POST', body: { app_id: appId, secret: appSecret, auth_code: authCode } });
      const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
      if (!/^[\x21-\x7e]{16,512}$/.test(accessToken)) throw new HttpError(502, 'O TikTok não retornou um token de acesso válido.', 'tiktok_bad_response');
      const advertiserIds = (Array.isArray(data.advertiser_ids) ? data.advertiser_ids : []).map(String).filter((id) => /^\d{1,24}$/.test(id));
      return { accessToken, advertiserIds };
    },

    /** Contas de anúncio que o usuário autorizou para o app (inclui as liberadas depois, ao reautorizar). */
    async listAuthorizedAdvertiserIds(token, { appId, appSecret }) {
      const data = await call('/oauth2/advertiser/get/', { token, query: { app_id: appId, secret: appSecret } });
      return [...new Set((Array.isArray(data.list) ? data.list : []).map((a) => String(a.advertiser_id)).filter((id) => /^\d{1,24}$/.test(id)))];
    },

    /**
     * Envia uma imagem da biblioteca para a biblioteca de criativos do TikTok (conta de anúncio) e devolve o image_id.
     * O arquivo é transmitido do disco (sem carregar tudo na memória). `md5` é a assinatura que o TikTok exige.
     */
    async uploadImage(token, { advertiserId, filePath, fileName, md5 }) {
      const form = new FormData();
      form.set('advertiser_id', advertiserId);
      form.set('upload_type', 'UPLOAD_BY_FILE');
      form.set('image_signature', md5);
      form.set('file_name', fileName);
      form.set('image_file', await fs.openAsBlob(filePath), fileName);
      const data = await call('/file/image/ad/upload/', { token, method: 'POST', form, timeoutMs: UPLOAD_TIMEOUT_MS });
      return requireMediaId(data.image_id ?? data.id ?? data.list?.[0]?.image_id ?? data[0]?.image_id, 'da imagem');
    },
    async uploadVideo(token, { advertiserId, filePath, fileName, md5 }) {
      const form = new FormData();
      form.set('advertiser_id', advertiserId);
      form.set('upload_type', 'UPLOAD_BY_FILE');
      form.set('video_signature', md5);
      form.set('file_name', fileName);
      form.set('video_file', await fs.openAsBlob(filePath), fileName);
      const data = await call('/file/video/ad/upload/', { token, method: 'POST', form, timeoutMs: UPLOAD_TIMEOUT_MS });
      return requireMediaId(data.video_id ?? data.list?.[0]?.video_id ?? data[0]?.video_id, 'do vídeo');
    },

    /** Criação (sempre pausada: o payload já leva operation_status DISABLE). Retornam o ID criado. */
    async createCampaign(token, payload) {
      const data = await call('/campaign/create/', { token, method: 'POST', body: payload });
      return requireId(data.campaign_id, 'da campanha');
    },
    async createAdGroup(token, payload) {
      const data = await call('/adgroup/create/', { token, method: 'POST', body: payload });
      return requireId(data.adgroup_id, 'do grupo de anúncios');
    },
    async createAd(token, payload) {
      const data = await call('/ad/create/', { token, method: 'POST', body: payload });
      // O formato do retorno varia: lista `ad_ids`, `ad_id` único ou o ID dentro de `creatives`.
      const adId = Array.isArray(data.ad_ids) ? data.ad_ids[0] : (data.ad_id ?? data.creatives?.[0]?.ad_id);
      return requireId(adId, 'do anúncio');
    },

    /** Desempenho diário da conta no período (datas YYYY-MM-DD). */
    async getDailyReport(token, advertiserId, { startDate, endDate }) {
      const data = await call('/report/integrated/get/', {
        token,
        query: {
          advertiser_id: advertiserId,
          report_type: 'BASIC',
          data_level: 'AUCTION_ADVERTISER',
          dimensions: ['stat_time_day'],
          metrics: ['spend', 'impressions', 'clicks', 'conversion'],
          start_date: startDate,
          end_date: endDate,
          page: 1,
          page_size: 100,
        },
      });
      const days = (Array.isArray(data.list) ? data.list : [])
        .map((row) => ({
          date: String(row.dimensions?.stat_time_day ?? '').slice(0, 10),
          spend: num(row.metrics?.spend),
          impressions: num(row.metrics?.impressions),
          clicks: num(row.metrics?.clicks),
          conversions: num(row.metrics?.conversion),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      return { days, totals: sumTotals(days) };
    },
  };
}

export function sumTotals(rows) {
  const totals = rows.reduce(
    (acc, d) => ({
      spend: acc.spend + d.spend,
      impressions: acc.impressions + d.impressions,
      clicks: acc.clicks + d.clicks,
      conversions: acc.conversions + d.conversions,
    }),
    { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
  );
  totals.ctr = totals.impressions ? (totals.clicks / totals.impressions) * 100 : 0;
  totals.cpc = totals.clicks ? totals.spend / totals.clicks : 0;
  return totals;
}
