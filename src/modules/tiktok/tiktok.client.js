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
const BC_LIST_MAX_PAGES = 3;
const HOURLY_PAGE_SIZE = 100; // um dia tem no máximo 24 horas
const HOURLY_MAX_PAGES = 2;
const HOUR_LABEL_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const BALANCE_PAGE_SIZE = 50;
const BALANCE_MAX_PAGES = 20;
const MAX_AMOUNT_FIELDS = 40;
const NUMERIC_TEXT_RE = /^-?\d{1,15}(?:\.\d{1,6})?$/;
// Campos que são identificação, data, situação ou paginação (não são valores em dinheiro).
const NOT_AMOUNT_RE = /(^|[_.])(id|ids|time|date|days|status|type|code|count|number|page|size|name|currency)($|[_.])/;
const PIXEL_PAGE_SIZE = 20; // documentação oficial de /pixel/list/: page_size de 1 a 20
const PIXEL_MAX_PAGES = 10;
const INFO_FIELDS = ['advertiser_id', 'name', 'currency', 'timezone', 'owner_bc_id'];
const PROFILE_FIELDS = ['advertiser_id', 'company', 'country', 'currency', 'timezone', 'email', 'industry']; // nomes do /advertiser/info/ na documentação oficial
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

/**
 * Valores numéricos de um objeto do TikTok (campos de saldo), como [{ key, value }]. Aceita número ou texto numérico, olha também um
 * nível de objetos aninhados e ignora ids, datas, situação e paginação. O TikTok não documenta cada campo, então lê TUDO que for número.
 */
export function numericFields(object) {
  const found = [];
  const seen = new Set();
  const add = (key, raw) => {
    const text = typeof raw === 'string' ? raw.trim() : raw;
    const value = typeof text === 'number' ? text : typeof text === 'string' && NUMERIC_TEXT_RE.test(text) ? Number(text) : null;
    if (value === null || !Number.isFinite(value) || NOT_AMOUNT_RE.test(key) || !/^[a-z][a-z0-9_.]{0,60}$/i.test(key) || seen.has(key) || found.length >= MAX_AMOUNT_FIELDS) return;
    seen.add(key);
    found.push({ key: key.toLowerCase(), value: Math.round(value * 10_000) / 10_000 });
  };
  for (const [key, raw] of Object.entries(object ?? {})) {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      // `balance_info` repete os campos de saldo (mesmos nomes); os demais objetos (ex.: máximo transferível) levam o nome do grupo.
      for (const [inner, innerRaw] of Object.entries(raw)) add(key === 'balance_info' ? inner : `${key}.${inner}`, innerRaw);
    } else if (!Array.isArray(raw)) add(key, raw);
  }
  return found;
}

/** ID numérico do TikTok (só dígitos) ou null: nunca guardamos texto livre vindo da resposta. */
const digitsOrNull = (value) => (/^\d{1,24}$/.test(String(value ?? '')) ? String(value) : null);
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

    /**
     * Detalhes das contas de anúncio: nome, moeda, fuso e a Business Center DONA da conta (`owner_bc_id`), que é de onde a tela tira o
     * ID da BC das conexões por link. Pede os campos explicitamente; se o TikTok recusar o pedido por campos, repete como antes
     * (sem `fields`) para nunca quebrar a sincronização por causa do ID da BC.
     */
    async getAdvertiserInfo(token, advertiserIds) {
      const result = [];
      let withFields = true;
      for (const ids of chunk(advertiserIds, INFO_CHUNK)) {
        let data;
        if (withFields) {
          try {
            data = await call('/advertiser/info/', { token, query: { advertiser_ids: ids, fields: INFO_FIELDS } });
          } catch (err) {
            if (!(err instanceof HttpError && err.code === 'tiktok_error')) throw err; // token inválido, limite, rede: erro de verdade
            withFields = false;
          }
        }
        data ??= await call('/advertiser/info/', { token, query: { advertiser_ids: ids } });
        for (const a of data.list ?? []) {
          result.push({
            id: String(a.advertiser_id),
            name: String(a.name ?? a.advertiser_name ?? a.advertiser_id),
            currency: a.currency ?? null,
            timezone: a.timezone ?? null,
            ownerBcId: digitsOrNull(a.owner_bc_id),
          });
        }
      }
      return result;
    },

    /**
     * Dados de UMA Business Center (`/bc/get/?bc_id=`), conforme a documentação oficial: tipo (NORMAL, DIRECT, AGENCY, SELF_SERVICE,
     * SELF_SERVICE_AGENCY), moeda, fuso, país de registro, empresa e o papel do usuário (ADMIN/STANDARD). Devolve null se o TikTok não
     * listar essa BC para o token. O tipo decide o que a criação de contas exige (ex.: BC de agência exige o site da empresa).
     */
    async getBcInfo(token, bcId) {
      const data = await call('/bc/get/', { token, query: { bc_id: bcId, page: 1, page_size: 10 } });
      const item = (Array.isArray(data.list) ? data.list : []).find((x) => String(x?.bc_info?.bc_id ?? '') === String(bcId));
      if (!item) return null;
      const info = item.bc_info;
      const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
      return {
        type: /^[A-Z_]{3,30}$/.test(String(info.type ?? '')) ? info.type : null,
        currency: /^[A-Z]{3}$/.test(String(info.currency ?? '')) ? info.currency : null,
        timezone: text(info.timezone, 64),
        registeredArea: /^[A-Z]{2}$/.test(String(info.registered_area ?? '')) ? info.registered_area : null,
        company: text(info.company, 255),
        name: text(info.name, 120),
        status: text(info.status, 30),
        userRole: /^[A-Z_]{3,20}$/.test(String(item.user_role ?? '')) ? item.user_role : null,
      };
    },

    /**
     * Dados cadastrais de UMA conta de anúncio existente, usados só para PRÉ-PREENCHER o formulário de novas contas
     * (empresa, país de registro, moeda, fuso, contato). Melhor esforço: se o TikTok recusar algum campo, devolve o que houver.
     */
    async getAdvertiserProfile(token, advertiserId) {
      let data;
      // Se o TikTok recusar algum campo pedido (ex.: um nome de campo que mudou), tenta de novo sem o ramo para ao menos trazer o resto.
      for (const fields of [PROFILE_FIELDS, PROFILE_FIELDS.filter((f) => f !== 'industry')]) {
        try {
          data = await call('/advertiser/info/', { token, query: { advertiser_ids: [advertiserId], fields } });
          break;
        } catch (err) {
          if (!(err instanceof HttpError && err.code === 'tiktok_error')) throw err;
        }
      }
      if (!data) return {};
      const a = data.list?.[0] ?? {};
      return {
        company: typeof a.company === 'string' ? a.company.slice(0, 255) : null,
        country: typeof a.country === 'string' ? a.country.slice(0, 2).toUpperCase() : null,
        currency: typeof a.currency === 'string' ? a.currency.slice(0, 3).toUpperCase() : null,
        timezone: typeof a.timezone === 'string' ? a.timezone.slice(0, 64) : null,
        contactEmail: typeof (a.email ?? a.contact_email) === 'string' ? String(a.email ?? a.contact_email).slice(0, 254) : null,
        industry: /^\d{1,9}$/.test(String(a.industry ?? '')) ? String(a.industry) : null, // ID do ramo de atividade (obrigatório ao criar contas)
      };
    },

    /**
     * Cria UMA conta de anúncio de leilão dentro da Business Center (`/bc/advertiser/create/`). Devolve o ID criado ou null se o
     * TikTok aceitou mas não informou o ID (a conta existe; ela aparece depois de "Atualizar contas"). Irreversível por aqui.
     */
    async createAdvertiser(token, { bcId, name, currency, timezone, company, registeredArea, industry, contactEmail, contactName, promotionLink = null }) {
      const contact = contactEmail ? { email: contactEmail, ...(contactName ? { name: contactName } : {}) } : null;
      const data = await call('/bc/advertiser/create/', {
        token,
        method: 'POST',
        body: {
          bc_id: bcId,
          advertiser_info: { name, currency, timezone, type: 'AUCTION' },
          customer_info: { company, registered_area: registeredArea, industry }, // o TikTok exige o ramo (um único parâmetro de ramo)
          // BC de agência: o site da empresa é obrigatório. BC DIRECT não pode receber `qualification_info` (o serviço só passa o link quando cabe).
          ...(promotionLink ? { qualification_info: { promotion_link: promotionLink } } : {}),
          ...(contact ? { contact_info: contact } : {}),
        },
      });
      return digitsOrNull(data.advertiser_id ?? data.advertiser_info?.advertiser_id ?? data.list?.[0]?.advertiser_id);
    },

    /**
     * Business Centers a que o token tem acesso (`/bc/get/`): [{ id, name }]. Usado só como reserva para descobrir o ID da BC de uma
     * conexão por link quando as contas não informam `owner_bc_id`. Lê o formato de forma defensiva.
     */
    async listBusinessCenters(token) {
      const found = new Map();
      for (let page = 1; page <= BC_LIST_MAX_PAGES; page += 1) {
        const data = await call('/bc/get/', { token, query: { page, page_size: BC_ASSET_PAGE_SIZE } });
        const list = Array.isArray(data.list) ? data.list : [];
        for (const item of list) {
          const id = digitsOrNull(item?.bc_info?.bc_id ?? item?.bc_id);
          if (id) found.set(id, String(item?.bc_info?.name ?? item?.name ?? '').slice(0, 120));
        }
        if (!list.length || page >= (num(data.page_info?.total_page) || 1)) break;
      }
      return [...found].map(([id, name]) => ({ id, name }));
    },

    /**
     * Pixels que já existem na conta de anúncio (`/pixel/list/`): [{ id, code, name }]. `id` é o que o grupo de anúncios usa
     * (`pixel_id`); `code` é o código do pixel e `name` o nome dado no Gerenciador de Eventos. Lê o formato de forma defensiva.
     */
    async listPixels(token, advertiserId) {
      const found = new Map();
      for (let page = 1; page <= PIXEL_MAX_PAGES; page += 1) {
        const data = await call('/pixel/list/', { token, query: { advertiser_id: advertiserId, page, page_size: PIXEL_PAGE_SIZE } });
        const list = Array.isArray(data.pixels) ? data.pixels : Array.isArray(data.list) ? data.list : [];
        for (const item of list) {
          const id = digitsOrNull(item?.pixel_id);
          if (id && !found.has(id)) found.set(id, { id, code: String(item?.pixel_code ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64), name: String(item?.pixel_name ?? '').slice(0, 120) });
        }
        if (!list.length || page >= (num(data.page_info?.total_page) || 1)) break;
      }
      return [...found.values()];
    },

    /**
     * Saldo de uma Business Center (`/bc/balance/get/`): { currency, amounts: [{ key, value }] }. Lê todos os campos numéricos da
     * resposta (o TikTok não documenta o formato): cada um vira uma linha de saldo na tela.
     */
    async getBcBalance(token, bcId) {
      const data = await call('/bc/balance/get/', { token, query: { bc_id: bcId } });
      return { currency: /^[A-Z]{3}$/.test(String(data?.currency ?? '')) ? data.currency : null, amounts: numericFields(data) };
    },

    /**
     * Saldo e orçamento das contas de anúncio de uma Business Center (`/advertiser/balance/get/`, paginado):
     * [{ id, name, status, currency, amounts: [{ key, value }] }]. A lista é procurada em `advertiser_account_list`/`list`/`advertisers`
     * (ou na primeira lista de objetos com `advertiser_id`), e cada conta tem todos os campos numéricos lidos.
     */
    async listAdvertiserBalances(token, bcId) {
      const accounts = new Map();
      for (let page = 1; page <= BALANCE_MAX_PAGES; page += 1) {
        const data = await call('/advertiser/balance/get/', { token, query: { bc_id: bcId, page, page_size: BALANCE_PAGE_SIZE } });
        const list = [data?.advertiser_account_list, data?.list, data?.advertisers, ...Object.values(data ?? {})].find((v) => Array.isArray(v) && v.some((x) => x && typeof x === 'object' && ('advertiser_id' in x || 'advertiser' in x))) ?? [];
        for (const item of list) {
          const id = digitsOrNull(item?.advertiser_id ?? item?.advertiser?.advertiser_id);
          if (!id || accounts.has(id)) continue;
          accounts.set(id, {
            id,
            name: String(item?.advertiser_name ?? item?.name ?? item?.advertiser?.advertiser_name ?? '').slice(0, 120),
            status: typeof (item?.advertiser_status ?? item?.status) === 'string' ? String(item.advertiser_status ?? item.status).slice(0, 40) : null,
            currency: /^[A-Z]{3}$/.test(String(item?.currency ?? '')) ? item.currency : null,
            amounts: numericFields(item),
          });
        }
        const totalPages = num(data?.page_info?.total_page);
        if (!list.length || page >= (totalPages || 1)) break;
      }
      return [...accounts.values()];
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

    /**
     * Desempenho POR HORA da conta em UM dia (`date` = YYYY-MM-DD no fuso da conta; o TikTok só aceita 1 dia por consulta quando a
     * dimensão é a hora). Devolve [{ hourLocal: '2026-11-23 14:00:00', spend, impressions, clicks, conversions }] só com horas bem formadas.
     */
    async getHourlyReport(token, advertiserId, date) {
      const rows = [];
      for (let page = 1; page <= HOURLY_MAX_PAGES; page += 1) {
        const data = await call('/report/integrated/get/', {
          token,
          query: {
            advertiser_id: advertiserId,
            report_type: 'BASIC',
            data_level: 'AUCTION_ADVERTISER',
            dimensions: ['stat_time_hour'],
            metrics: ['spend', 'impressions', 'clicks', 'conversion'],
            start_date: date,
            end_date: date,
            page,
            page_size: HOURLY_PAGE_SIZE,
          },
        });
        const list = Array.isArray(data.list) ? data.list : [];
        for (const row of list) {
          const hourLocal = String(row.dimensions?.stat_time_hour ?? '');
          if (!HOUR_LABEL_RE.test(hourLocal)) continue; // nada fora do formato entra no banco
          rows.push({ hourLocal, spend: num(row.metrics?.spend), impressions: num(row.metrics?.impressions), clicks: num(row.metrics?.clicks), conversions: num(row.metrics?.conversion) });
        }
        if (!list.length || page >= (num(data.page_info?.total_page) || 1)) break;
      }
      return rows;
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
