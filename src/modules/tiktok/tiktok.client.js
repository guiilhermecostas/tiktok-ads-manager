import fs from 'node:fs';
import { redactUrl } from '../../../shared/catalog.js';
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
const BALANCE_EXTRA_FIELDS = ['budget_remaining']; // `fields` de /advertiser/balance/get/: campos extras opcionais (orçamento restante)
// Campos do topo da resposta que, com Payment Portfolio, são do PORTFÓLIO e não da conta (documentação oficial de /advertiser/balance/get/).
const PORTFOLIO_FIELDS = ['account_balance', 'valid_account_balance', 'frozen_balance', 'tax', 'cash_balance', 'valid_cash_balance', 'transferable_amount'];
const portfolioTypeOf = (value) => (['SHARED', 'NON_SHARED'].includes(value) ? value : null);
const MAX_AMOUNT_FIELDS = 40;
const LIFETIME_MAX_IDS = 5; // `advertiser_ids` do relatório aceita até 5 contas por pedido (documentação oficial)
const TRANSACTION_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const TRANSACTION_TYPE_RE = /^[A-Z_]{3,40}$/;
const NUMERIC_TEXT_RE = /^-?\d{1,15}(?:\.\d{1,6})?$/;
// Campos que são identificação, data, situação ou paginação (não são valores em dinheiro).
const NOT_AMOUNT_RE = /(^|[_.])(id|ids|time|date|days|status|type|code|count|number|page|size|name|currency)($|[_.])/;
const AD_PAGE_SIZE = 1000; // /ad/get/ e relatórios: page_size de 1 a 1000 (documentação oficial)
const AD_MAX_PAGES = 10;
const AD_STATUS_MAX_IDS = 20; // /ad/status/update/: de 1 a 20 anúncios por pedido
const AD_FIELDS = ['ad_id', 'ad_name', 'advertiser_id', 'campaign_id', 'campaign_name', 'adgroup_id', 'adgroup_name', 'operation_status', 'secondary_status', 'create_time', 'modify_time'];
// Métricas do relatório por anúncio (nomes da documentação oficial). "clicks" e "cpc" são os de DESTINO (cliques no link).
const AD_METRICS_FULL = ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'result', 'cost_per_result', 'conversion', 'cost_per_conversion'];
const AD_METRICS_BASIC = ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'conversion', 'cost_per_conversion'];
const isoTime = (value) => (AD_TIME_RE.test(String(value ?? '')) ? `${String(value).replace(' ', 'T')}Z` : null);
const shortText = (value, max = 200) => String(value ?? '').slice(0, max);
const enumOrNull = (value) => (/^[A-Z][A-Z0-9_]{1,79}$/.test(String(value ?? '')) ? String(value) : null);
const budgetOf = (raw) => ({ budgetMode: enumOrNull(raw.budget_mode), budget: numOrNull(raw.budget) });
const commonOf = (raw) => ({
  operationStatus: ['ENABLE', 'DISABLE', 'FROZEN'].includes(raw.operation_status) ? raw.operation_status : null,
  status: /^[A-Z_]{3,80}$/.test(String(raw.secondary_status ?? '')) ? raw.secondary_status : null,
  createdAt: isoTime(raw.create_time),
  modifiedAt: isoTime(raw.modify_time),
});
/**
 * Contrato de cada nível do Gerenciador (documentação oficial v1.3): onde listar, que campos pedir, onde ativar/pausar e como pedir o
 * desempenho. `dimension` é a ÚNICA dimensão de ID do relatório (o TikTok não aceita duas).
 */
const LEVEL_SPECS = Object.freeze({
  campaigns: {
    listPath: '/campaign/get/', idField: 'campaign_id', statusPath: '/campaign/status/update/', idsField: 'campaign_ids', dataLevel: 'AUCTION_CAMPAIGN', dimension: 'campaign_id',
    fields: ['campaign_id', 'campaign_name', 'advertiser_id', 'objective_type', 'budget_mode', 'budget', 'operation_status', 'secondary_status', 'create_time', 'modify_time'],
    parse: (raw, id) => ({ campaignId: id, name: shortText(raw.campaign_name), objectiveType: enumOrNull(raw.objective_type), ...budgetOf(raw), ...commonOf(raw) }),
  },
  adgroups: {
    listPath: '/adgroup/get/', idField: 'adgroup_id', statusPath: '/adgroup/status/update/', idsField: 'adgroup_ids', dataLevel: 'AUCTION_ADGROUP', dimension: 'adgroup_id',
    fields: ['adgroup_id', 'adgroup_name', 'advertiser_id', 'campaign_id', 'campaign_name', 'optimization_goal', 'budget_mode', 'budget', 'operation_status', 'secondary_status', 'create_time', 'modify_time'],
    parse: (raw, id) => ({
      adgroupId: id, name: shortText(raw.adgroup_name), campaignId: digitsOrNull(raw.campaign_id), campaignName: shortText(raw.campaign_name),
      optimizationGoal: enumOrNull(raw.optimization_goal), ...budgetOf(raw), ...commonOf(raw),
    }),
  },
  ads: {
    listPath: '/ad/get/', idField: 'ad_id', statusPath: '/ad/status/update/', idsField: 'ad_ids', dataLevel: 'AUCTION_AD', dimension: 'ad_id',
    fields: AD_FIELDS,
    parse: (raw) => ({
      name: shortText(raw.ad_name), campaignId: digitsOrNull(raw.campaign_id), campaignName: shortText(raw.campaign_name),
      adgroupId: digitsOrNull(raw.adgroup_id), adgroupName: shortText(raw.adgroup_name), ...commonOf(raw),
    }),
  },
});
const CATALOG_PAGE_SIZE = 100; // /catalog/get/: page_size de 1 a 1.000
const CATALOG_MAX_PAGES = 10;
const PRODUCT_PAGE_SIZE_MAX = 500; // /catalog/product/get/: page_size até 500 (e page × page_size ≤ 10.000)
const CATALOG_UPLOAD_MAX = 5000; // /catalog/product/upload/: até 5.000 produtos por chamada
const FEED_LOG_RE = /^[\w-]{1,64}$/;
const AD_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const PIXEL_PAGE_SIZE = 20; // documentação oficial de /pixel/list/: page_size de 1 a 20
const PIXEL_MAX_PAGES = 10;
const PIXEL_LINK_MAX_PAGES = 10;
const IDENTITY_ID_RE = /^[A-Za-z0-9][\w\-.:]{2,98}[A-Za-z0-9]$/;
const IDENTITY_PAGE_SIZE = 100; // documentação oficial de /identity/get/: page_size de 1 a 100
const IDENTITY_MAX_PAGES = 5;
const INFO_FIELDS = ['advertiser_id', 'name', 'currency', 'timezone', 'owner_bc_id', 'status']; // status: situação da conta (STATUS_ENABLE, STATUS_DISABLE, STATUS_LIMIT…)
const ACCOUNT_STATUS_RE = /^STATUS_[A-Z_]{2,60}$/;
const PROFILE_FIELDS = ['advertiser_id', 'company', 'country', 'currency', 'timezone', 'email', 'industry']; // nomes do /advertiser/info/ na documentação oficial
// Códigos que indicam token revogado/inválido: é preciso trocar o token da Business Center.
const TOKEN_ERROR_CODES = new Set([40104, 40105]);
// Limite de requisições do TikTok (código 40100 e mensagens equivalentes).
const RATE_LIMIT_CODES = new Set([40100]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Ritmo das chamadas. O limite do TikTok é por ENDPOINT e por APP (Basic: 10 por segundo e 600 por minuto, somando todos os usuários e a coleta
 * por hora; passou, responde 40100). Por isso o ritmo é um só para o processo inteiro (vale para todos os clientes, com ou sem proxy):
 * o início de cada chamada ao mesmo endpoint respeita um intervalo mínimo (`tiktok.minIntervalMs`; 0 desliga, como nos testes).
 */
const nextSlot = new Map();
async function pace(path, intervalMs) {
  if (!intervalMs) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(path) ?? 0);
  nextSlot.set(path, at + intervalMs);
  if (at > now) await sleep(at - now);
}

/**
 * E-mail de contato lido do TikTok. Na documentação oficial de `/advertiser/info/` ele vem MASCARADO (ex.: "l***@***"): isso não é um e-mail
 * de verdade e nunca deve ser pré-preenchido nem enviado de volta. Só devolve um endereço completo e sem máscara; senão, null.
 */
export function usableEmail(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  return email.length <= 254 && /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(email) ? email : null;
}

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
 * nível de objetos aninhados e ignora ids, datas, situação e paginação. Lê TUDO que for número (nomes desconhecidos aparecem humanizados).
 * `balance_info` (documentação oficial: "detalhes dos saldos DA CONTA de anúncio") vem PRIMEIRO e tem prioridade: com Payment Portfolio
 * ativo, os mesmos campos no topo da resposta são os do PORTFÓLIO (compartilhado), não os da conta.
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
  const entries = Object.entries(object ?? {}).sort(([a], [b]) => Number(b === 'balance_info') - Number(a === 'balance_info'));
  for (const [key, raw] of entries) {
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
/** Número ou null (campo ausente não vira zero). */
const numOrNull = (value) => (value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

/**
 * Cliente mínimo da TikTok Marketing/Business API (v1.3). Isolado do restante do sistema:
 * recebe `fetchFn` por injeção (testável sem rede) e NUNCA registra o token em log.
 * Os formatos de resposta são lidos de forma defensiva, pois variam entre endpoints/versões.
 */
export function createTiktokClient({ config, fetchFn = fetch, route = null }) {
  const { apiBase } = config.tiktok;
  const minIntervalMs = config.tiktok.minIntervalMs ?? 0;
  const rateLimitRetries = config.tiktok.rateLimitRetries ?? 0; // repetições (com espera crescente) quando o TikTok responde 40100
  const retryDelayMs = config.tiktok.retryDelayMs ?? 1500;

  /** Uma chamada com ritmo controlado. Consultas (GET) e chamadas marcadas com `retry` (idempotentes) repetem se o TikTok limitar a frequência. */
  async function call(path, options) {
    const retryable = (options.method ?? 'GET') === 'GET' || options.retry === true;
    for (let attempt = 0; ; attempt += 1) {
      await pace(path, minIntervalMs);
      try {
        return await callOnce(path, options);
      } catch (err) {
        if (!(retryable && err?.code === 'tiktok_rate_limited' && attempt < rateLimitRetries)) throw err;
        await sleep(retryDelayMs * 2 ** attempt + Math.random() * retryDelayMs * 0.3);
      }
    }
  }

  async function callOnce(path, { token, query, method = 'GET', body, form, timeoutMs = TIMEOUT_MS }) {
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

  // ---------- Gerenciador: campanhas, grupos de anúncios e anúncios (mesmas regras de leitura e de ativar/pausar) ----------
  /** Lista os itens do nível (`/campaign/get/`, `/adgroup/get/` ou `/ad/get/`, sem os excluídos): { items, truncated }. */
  async function listItems(token, advertiserId, level) {
    const spec = LEVEL_SPECS[level];
    if (!spec) throw new HttpError(400, 'Nível inválido.', 'validation_error');
    const items = new Map();
    let truncated = false;
    for (let page = 1; page <= AD_MAX_PAGES; page += 1) {
      const data = await call(spec.listPath, { token, query: { advertiser_id: advertiserId, fields: spec.fields, filtering: { primary_status: 'STATUS_NOT_DELETE' }, page, page_size: AD_PAGE_SIZE } });
      const list = Array.isArray(data.list) ? data.list : [];
      for (const raw of list) {
        const id = digitsOrNull(raw?.[spec.idField]);
        if (!id || items.has(id)) continue;
        items.set(id, { id, advertiserId, ...spec.parse(raw, id) });
      }
      const totalPages = num(data.page_info?.total_page);
      if (!list.length || list.length < AD_PAGE_SIZE || page >= (totalPages || page)) break;
      if (page === AD_MAX_PAGES) truncated = true;
    }
    return { items: [...items.values()], truncated };
  }

  async function levelMetrics(token, advertiserId, level, { startDate, endDate }) {
    const spec = LEVEL_SPECS[level];
    if (!spec) throw new HttpError(400, 'Nível inválido.', 'validation_error');
    const run = async (metrics) => {
      const rows = [];
      for (let page = 1; page <= AD_MAX_PAGES; page += 1) {
        const data = await call('/report/integrated/get/', {
          token,
          query: { advertiser_id: advertiserId, report_type: 'BASIC', data_level: spec.dataLevel, dimensions: [spec.dimension], metrics, start_date: startDate, end_date: endDate, page, page_size: AD_PAGE_SIZE },
        });
        const list = Array.isArray(data.list) ? data.list : [];
        rows.push(...list);
        if (!list.length || list.length < AD_PAGE_SIZE || page >= (num(data.page_info?.total_page) || page)) break;
      }
      return rows;
    };
    let rows;
    let hasResult = true;
    try {
      rows = await run(AD_METRICS_FULL);
    } catch (err) {
      if (!(err instanceof HttpError && err.code === 'tiktok_error')) throw err;
      hasResult = false;
      rows = await run(AD_METRICS_BASIC);
    }
    const byId = new Map();
    for (const row of rows) {
      const id = digitsOrNull(row.dimensions?.[spec.dimension]);
      if (!id) continue;
      const m = row.metrics ?? {};
      byId.set(id, {
        spend: num(m.spend), impressions: num(m.impressions), clicks: num(m.clicks), ctr: num(m.ctr), cpc: num(m.cpc),
        result: num(m.result), costPerResult: num(m.cost_per_result), conversions: num(m.conversion), costPerConversion: num(m.cost_per_conversion),
      });
    }
    return { metrics: byId, hasResult };
  }

  async function changeStatus(token, advertiserId, level, ids, status) {
    const spec = LEVEL_SPECS[level];
    if (!spec) throw new HttpError(400, 'Nível inválido.', 'validation_error');
    if (!['ENABLE', 'DISABLE'].includes(status)) throw new HttpError(400, 'Status inválido.', 'validation_error');
    if (!ids.length || ids.length > AD_STATUS_MAX_IDS || !ids.every((id) => /^\d{1,24}$/.test(id))) throw new HttpError(400, `Escolha de 1 a ${AD_STATUS_MAX_IDS} itens.`, 'validation_error');
    const data = await call(spec.statusPath, { token, method: 'POST', retry: true, body: { advertiser_id: advertiserId, [spec.idsField]: ids, operation_status: status } });
    return (Array.isArray(data[spec.idsField]) ? data[spec.idsField] : []).map((id) => digitsOrNull(id)).filter(Boolean);
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
            status: ACCOUNT_STATUS_RE.test(String(a.status ?? '')) ? a.status : null, // situação da conta no TikTok (nula se o TikTok não informou)
          });
        }
      }
      return result;
    },

    /**
     * Situação de cada conta de anúncio (`status` de /advertiser/info/, tabela "Advertiser Status" da documentação oficial: STATUS_ENABLE,
     * STATUS_LIMIT = conta punida, STATUS_DISABLE = encerrada…). Só leitura; até 100 contas por chamada. Devolve [{ id, name, status }].
     */
    async getAdvertiserStatuses(token, advertiserIds) {
      const result = [];
      for (const ids of chunk(advertiserIds, INFO_CHUNK)) {
        const data = await call('/advertiser/info/', { token, query: { advertiser_ids: ids, fields: ['advertiser_id', 'name', 'status'] } });
        for (const a of data.list ?? []) {
          const id = digitsOrNull(a.advertiser_id);
          if (id && ACCOUNT_STATUS_RE.test(String(a.status ?? ''))) result.push({ id, name: String(a.name ?? id).slice(0, 120), status: a.status });
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
        contactEmail: usableEmail(a.email ?? a.contact_email),
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
          if (id && !found.has(id)) found.set(id, { id, code: String(item?.pixel_code ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64), name: String(item?.pixel_name ?? '').slice(0, 120), ownerBcId: digitsOrNull(item?.owner_bc_id) }); // owner_bc_id: BC dona do pixel (precisa dela para vincular)
        }
        if (!list.length || page >= (num(data.page_info?.total_page) || 1)) break;
      }
      return [...found.values()];
    },

    /**
     * Identidades que a conta de anúncio pode usar (`/identity/get/`), de UM tipo: [{ id, type, name, username, available }].
     * `bcId` (BC dona da conta) é obrigatório no tipo `BC_AUTH_TT`. Contas do TikTok (`TT_USER`/`BC_AUTH_TT`) só estão disponíveis
     * quando o TikTok diz `AVAILABLE`; a identidade personalizada está sempre disponível. Lê o formato de forma defensiva.
     */
    async listIdentities(token, advertiserId, { identityType, bcId = null }) {
      const found = new Map();
      for (let page = 1; page <= IDENTITY_MAX_PAGES; page += 1) {
        const query = { advertiser_id: advertiserId, identity_type: identityType, page, page_size: IDENTITY_PAGE_SIZE };
        if (identityType === 'BC_AUTH_TT') query.identity_authorized_bc_id = bcId;
        const data = await call('/identity/get/', { token, query });
        const list = Array.isArray(data.identity_list) ? data.identity_list : Array.isArray(data.list) ? data.list : [];
        for (const item of list) {
          const id = String(item?.identity_id ?? '');
          if (!IDENTITY_ID_RE.test(id) || found.has(id)) continue;
          const accountType = identityType !== 'CUSTOMIZED_USER';
          found.set(id, {
            id,
            type: identityType,
            name: String(item?.display_name ?? '').slice(0, 100),
            username: String(item?.username ?? '').replace(/[^\w.]/g, '').slice(0, 64),
            available: accountType ? (item?.available_status === undefined || item?.available_status === null || item.available_status === 'AVAILABLE') : true,
          });
        }
        if (!list.length || page >= (num(data.page_info?.total_page) || 1)) break;
      }
      return [...found.values()];
    },

    /** Cria uma identidade personalizada (`/identity/create/`): nome (até 100) e, opcional, o `image_id` da foto (1:1) já enviada. Devolve o ID. */
    async createIdentity(token, { advertiserId, displayName, imageId = null }) {
      const body = { advertiser_id: advertiserId, display_name: displayName };
      if (imageId) body.image_uri = imageId;
      const data = await call('/identity/create/', { token, method: 'POST', body });
      return requireMediaId(data.identity_id, 'da identidade');
    },

    /**
     * Contas de anúncio vinculadas a um pixel (`/bc/pixel/link/get/`): lista de IDs. O pedido não documenta paginação; se a resposta disser
     * que há mais páginas, pede as seguintes e para quando uma página não trouxer ninguém novo (nunca fica em laço).
     */
    async getPixelLinks(token, { bcId, pixelCode }) {
      const found = new Set();
      for (let page = 1; page <= PIXEL_LINK_MAX_PAGES; page += 1) {
        const data = await call('/bc/pixel/link/get/', { token, query: page === 1 ? { bc_id: bcId, pixel_code: pixelCode } : { bc_id: bcId, pixel_code: pixelCode, page } });
        const before = found.size;
        for (const item of Array.isArray(data.list) ? data.list : []) {
          const id = digitsOrNull(item?.advertiser_id);
          if (id) found.add(id);
        }
        if (found.size === before || page >= (num(data.page_info?.total_page) || 1)) break;
      }
      return [...found];
    },

    /** Vincula (`LINK`) ou desvincula (`UNLINK`) um pixel de contas de anúncio (`/bc/pixel/link/update/`). O pixel é indicado pelo CÓDIGO. */
    async updatePixelLink(token, { bcId, pixelCode, advertiserIds, action }) {
      await call('/bc/pixel/link/update/', { token, method: 'POST', body: { bc_id: bcId, pixel_code: pixelCode, advertiser_ids: advertiserIds, relation_status: action } });
    },

    /**
     * Saldo de uma Business Center (`/bc/balance/get/`): { currency, amounts: [{ key, value }] }. Lê todos os campos numéricos da
     * resposta (o TikTok não documenta o formato): cada um vira uma linha de saldo na tela.
     */
    async getBcBalance(token, bcId) {
      const data = await call('/bc/balance/get/', { token, query: { bc_id: bcId } });
      return { currency: /^[A-Z]{3}$/.test(String(data?.currency ?? '')) ? data.currency : null, portfolioType: portfolioTypeOf(data?.payment_portfolio_type), amounts: numericFields(data) };
    },

    /**
     * Saldo e orçamento das contas de anúncio de uma Business Center (`/advertiser/balance/get/`, paginado, até 50 por página; só devolve as contas em
     * que a BC é administradora): [{ id, name, status, currency, budgetMode, portfolio, amounts: [{ key, value }] }]. Pede também `budget_remaining`
     * (o TikTok só devolve o orçamento restante quando pedido em `fields`); se o TikTok recusar `fields`, repete sem ele.
     *  - `amounts`: saldos DA CONTA (`balance_info` tem prioridade sobre os campos do topo, que com Payment Portfolio são do portfólio).
     *  - `portfolio`: { id, name, type: 'SHARED' | 'NON_SHARED' | null, amounts } quando a conta usa Payment Portfolio (`amounts` = os campos do topo).
     *  - `budgetMode`: UNLIMITED | MONTHLY_BUDGET | DAILY_BUDGET | CUSTOM_BUDGET (as três últimas gastam do saldo da BC, dentro do orçamento).
     */
    async listAdvertiserBalances(token, bcId) {
      const run = async (withFields) => {
        const found = new Map();
        for (let page = 1; page <= BALANCE_MAX_PAGES; page += 1) {
          const data = await call('/advertiser/balance/get/', { token, query: { bc_id: bcId, ...(withFields ? { fields: BALANCE_EXTRA_FIELDS } : {}), page, page_size: BALANCE_PAGE_SIZE } });
          const list = [data?.advertiser_account_list, data?.list, data?.advertisers, ...Object.values(data ?? {})].find((v) => Array.isArray(v) && v.some((x) => x && typeof x === 'object' && ('advertiser_id' in x || 'advertiser' in x))) ?? [];
          for (const item of list) {
            const id = digitsOrNull(item?.advertiser_id ?? item?.advertiser?.advertiser_id);
            if (!id || found.has(id)) continue;
            const portfolioId = digitsOrNull(item?.payment_portfolio_id);
            found.set(id, {
              id,
              name: String(item?.advertiser_name ?? item?.name ?? item?.advertiser?.advertiser_name ?? '').slice(0, 120),
              status: typeof (item?.advertiser_status ?? item?.status) === 'string' ? String(item.advertiser_status ?? item.status).slice(0, 40) : null,
              currency: /^[A-Z]{3}$/.test(String(item?.currency ?? '')) ? item.currency : null,
              budgetMode: /^[A-Z_]{3,30}$/.test(String(item?.budget_mode ?? '')) ? item.budget_mode : null,
              portfolio: portfolioId || item?.payment_portfolio_type
                ? { id: portfolioId, name: typeof item.payment_portfolio_name === 'string' ? item.payment_portfolio_name.slice(0, 120) : null, type: portfolioTypeOf(item.payment_portfolio_type), amounts: numericFields(Object.fromEntries(PORTFOLIO_FIELDS.map((key) => [key, item[key]]))) }
                : null,
              amounts: numericFields(item),
            });
          }
          const totalPages = num(data?.page_info?.total_page);
          if (!list.length || page >= (totalPages || 1)) break;
        }
        return [...found.values()];
      };
      try {
        return await run(true);
      } catch (err) {
        if (!(err instanceof HttpError && err.code === 'tiktok_error')) throw err;
        return run(false); // o TikTok recusou `fields` (versão/permissão): lê o básico, sem o orçamento restante
      }
    },

    /**
     * Gasto VITALÍCIO (desde sempre) de até 5 contas de anúncio, em UMA chamada: `/report/integrated/get/` com `report_type` BASIC,
     * `data_level` AUCTION_ADVERTISER, `query_lifetime` e `advertiser_ids` (documentação oficial: as contas precisam ser do mesmo usuário do
     * TikTok e a moeda de cada uma volta em `metrics`). Devolve Map(id → { spend, currency }); conta sem linha na resposta não aparece no Map.
     */
    async getLifetimeSpend(token, advertiserIds) {
      const ids = [...new Set(advertiserIds.map(digitsOrNull).filter(Boolean))];
      if (!ids.length || ids.length > LIFETIME_MAX_IDS || ids.length !== advertiserIds.length) throw new HttpError(400, `Informe de 1 a ${LIFETIME_MAX_IDS} contas de anúncio válidas.`, 'validation_error');
      const out = new Map();
      for (let page = 1; page <= 2; page += 1) {
        const data = await call('/report/integrated/get/', {
          token,
          query: { advertiser_ids: ids, report_type: 'BASIC', data_level: 'AUCTION_ADVERTISER', dimensions: ['advertiser_id'], metrics: ['spend'], query_lifetime: true, page, page_size: 10 },
        });
        const list = Array.isArray(data.list) ? data.list : [];
        for (const row of list) {
          const id = digitsOrNull(row?.dimensions?.advertiser_id);
          const spend = numOrNull(row?.metrics?.spend);
          if (!id || !ids.includes(id) || spend === null || spend < 0) continue; // só as contas pedidas, e só valor numérico válido
          const currency = /^[A-Z]{3}$/.test(String(row?.metrics?.currency ?? '')) ? row.metrics.currency : null;
          out.set(id, { spend, currency });
        }
        if (!list.length || page >= (num(data.page_info?.total_page) || 1)) break;
      }
      return out;
    },

    /**
     * Transações (depósitos e demais movimentações) da Business Center (`level` 'BC') ou de contas de anúncio dela (`level` 'ADVERTISER'),
     * em `/bc/account/transaction/get/`. Só quem tem função financeira (Finance Manager/Analyst) na BC lê isto. Janela de até 365 dias,
     * página de 1 a 50. Lê a resposta de forma defensiva: cada campo é validado antes de sair daqui.
     * Devolve { transactions: [{ id, type, amountType, amount, subtotal, taxAmount, currency, billingType, timezone, createdAt, accountId, invoiceSerial }], pageInfo }.
     */
    async listTransactions(token, { bcId, level, accountIds = null, types = null, startTime, endTime, page = 1, pageSize = 20 }) {
      if (!/^\d{1,24}$/.test(bcId ?? '')) throw new HttpError(400, 'Business Center inválida.', 'validation_error');
      if (!['BC', 'ADVERTISER'].includes(level)) throw new HttpError(400, 'Nível de consulta inválido.', 'validation_error');
      if (!TRANSACTION_TIME_RE.test(startTime ?? '') || !TRANSACTION_TIME_RE.test(endTime ?? '')) throw new HttpError(400, 'Período inválido.', 'validation_error');
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new HttpError(400, 'Página inválida.', 'validation_error');
      if (accountIds && (level !== 'ADVERTISER' || !accountIds.length || accountIds.length > 100 || !accountIds.every((id) => /^\d{1,24}$/.test(id)))) throw new HttpError(400, 'Contas inválidas.', 'validation_error');
      if (types && (!types.length || !types.every((t) => TRANSACTION_TYPE_RE.test(t)))) throw new HttpError(400, 'Tipos de transação inválidos.', 'validation_error');
      const filtering = { start_time: startTime, end_time: endTime, ...(types ? { transaction_types: types } : {}), ...(accountIds ? { account_ids: accountIds } : {}) };
      const data = await call('/bc/account/transaction/get/', { token, query: { bc_id: bcId, transaction_level: level, filtering, page, page_size: pageSize } });
      const text = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : null);
      const transactions = (Array.isArray(data.transaction_list) ? data.transaction_list : []).map((item) => ({
        id: text(String(item?.transaction_id ?? ''), 64),
        type: TRANSACTION_TYPE_RE.test(String(item?.transaction_type ?? '')) ? item.transaction_type : null,
        amountType: ['POSITIVE', 'NEGATIVE', 'OTHER'].includes(item?.amount_type) ? item.amount_type : 'OTHER',
        amount: numOrNull(item?.amount),
        subtotal: numOrNull(item?.subtotal),
        taxAmount: numOrNull(item?.tax_amount),
        currency: /^[A-Z]{3}$/.test(String(item?.currency ?? '')) ? item.currency : null,
        billingType: ['CASH', 'CREDIT'].includes(item?.billing_type) ? item.billing_type : null,
        timezone: text(item?.timezone, 16),
        createdAt: TRANSACTION_TIME_RE.test(String(item?.create_time ?? '')) ? item.create_time : null,
        accountId: digitsOrNull(item?.account_id),
        invoiceSerial: text(item?.serial_number, 64),
      })).filter((t) => t.id && t.amount !== null);
      const info = data.page_info ?? {};
      return { transactions, pageInfo: { page: num(info.page) || page, totalNumber: num(info.total_number), totalPage: num(info.total_page) || 1 } };
    },

    /**
     * Move dinheiro entre a Business Center e UMA conta de anúncio (`POST /bc/transfer/`, `transfer_level: ADVERTISER`, só em espécie):
     * RECHARGE = da BC para a conta; REFUND = da conta para a BC. Exige função Finance Manager na BC. NUNCA repete sozinho (não é uma consulta):
     * quem chama decide o que fazer se a resposta não chegar. Devolve { transactionIds } (os dois lados da transferência).
     */
    async transferBalance(token, { bcId, advertiserId, type, amount }) {
      if (!/^\d{1,24}$/.test(bcId) || !/^\d{1,24}$/.test(advertiserId)) throw new HttpError(400, 'Conta ou Business Center inválida.', 'validation_error');
      if (!['RECHARGE', 'REFUND'].includes(type)) throw new HttpError(400, 'Tipo de transferência inválido.', 'validation_error');
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) throw new HttpError(400, 'Valor inválido.', 'validation_error');
      const data = await call('/bc/transfer/', {
        token, method: 'POST',
        body: { bc_id: bcId, transfer_level: 'ADVERTISER', advertiser_id: advertiserId, transfer_type: type, cash_amount: Math.round(amount * 100) / 100 },
      });
      const ids = (Array.isArray(data.transaction_infos) ? data.transaction_infos : []).map((t) => String(t?.transaction_id ?? '')).filter((id) => /^[\w-]{1,64}$/.test(id));
      return { transactionIds: [...new Set(ids)].slice(0, 4) };
    },

    /**
     * Campanhas, grupos de anúncios e anúncios da conta (sem os excluídos): `/campaign/get/`, `/adgroup/get/` e `/ad/get/`, páginas de 1000.
     * Todos devolvem { items, truncated }; cada item tem `id`, `name`, `advertiserId`, `operationStatus` ('ENABLE'|'DISABLE'|'FROZEN'|null),
     * `status` (status secundário: AD_STATUS_*, ADGROUP_STATUS_* ou CAMPAIGN_STATUS_*), `createdAt`/`modifiedAt` (ISO, UTC) e os campos do nível
     * (campanha: objetivo e orçamento; grupo: campanha, meta e orçamento; anúncio: campanha e grupo).
     */
    listManagerItems: listItems,

    /** Compatibilidade: anúncios no formato antigo (`ads` com `adId`). */
    async listAds(token, advertiserId) {
      const { items, truncated } = await listItems(token, advertiserId, 'ads');
      return { ads: items.map((item) => ({ ...item, adId: item.id })), truncated };
    },

    /**
     * Desempenho do período por campanha, grupo ou anúncio (`/report/integrated/get/`, `data_level` AUCTION_CAMPAIGN / AUCTION_ADGROUP / AUCTION_AD,
     * uma dimensão de ID; datas no fuso da conta): Map id -> métricas em número. Quem não teve entrega no período não vem no relatório (quem chama
     * trata como zero). Se o TikTok recusar alguma métrica ("result"), repete com o conjunto básico e informa `hasResult: false`.
     */
    getLevelMetrics: levelMetrics,

    /** Compatibilidade: desempenho por anúncio. */
    getAdMetrics(token, advertiserId, range) {
      return levelMetrics(token, advertiserId, 'ads', range);
    },

    /**
     * Ativa ou pausa campanhas, grupos ou anúncios (`/campaign/status/update/`, `/adgroup/status/update/`, `/ad/status/update/`: de 1 a 20 por
     * pedido; só ENABLE e DISABLE: este sistema NUNCA exclui nada). Devolve os IDs que o TikTok confirmou.
     */
    updateStatus: changeStatus,

    /** Compatibilidade: ativar/pausar anúncios. */
    updateAdStatus(token, advertiserId, adIds, status) {
      return changeStatus(token, advertiserId, 'ads', adIds, status);
    },

    // ---------- Catálogo de produtos (Catalog API v1.3; o catálogo é um ativo da Business Center) ----------
    /** Catálogos da Business Center (`/catalog/get/`, paginado). Só o necessário, com texto limitado. */
    async listCatalogs(token, bcId) {
      const catalogs = new Map();
      for (let page = 1; page <= CATALOG_MAX_PAGES; page += 1) {
        const data = await call('/catalog/get/', { token, query: { bc_id: bcId, page, page_size: CATALOG_PAGE_SIZE } });
        const list = Array.isArray(data.list) ? data.list : [];
        for (const item of list) {
          const id = digitsOrNull(item?.catalog_id);
          if (!id || catalogs.has(id)) continue;
          catalogs.set(id, {
            id,
            name: String(item.catalog_name ?? '').slice(0, 200),
            type: /^[A-Z_]{2,30}$/.test(String(item.catalog_type ?? '')) ? item.catalog_type : null,
            adCreationEligible: item.ad_creation_eligible === 'AVAILABLE', // pode ser usado em anúncios quando tiver produtos disponíveis
            createdAt: typeof item.create_time === 'string' ? item.create_time.slice(0, 19) : null,
            updatedAt: typeof item.update_time === 'string' ? item.update_time.slice(0, 19) : null,
            bcId: digitsOrNull(item.bc_info?.bc_id) ?? bcId,
            bcName: typeof item.bc_info?.bc_name === 'string' ? item.bc_info.bc_name.slice(0, 200) : null,
            regionCode: typeof item.catalog_conf?.country === 'string' ? item.catalog_conf.country.slice(0, 2).toUpperCase() : null,
            currency: typeof item.catalog_conf?.currency === 'string' ? item.catalog_conf.currency.slice(0, 3).toUpperCase() : null,
            multiCountry: item.catalog_conf?.is_multi_country === true,
          });
        }
        const totalPages = numOrNull(data.page_info?.total_page);
        if (!list.length || list.length < CATALOG_PAGE_SIZE || page >= (totalPages || page)) break;
      }
      return [...catalogs.values()];
    },

    /** Países/regiões para onde os anúncios de um catálogo podem ser entregues (`/catalog/available_country/get/`). */
    async getCatalogRegions(token, bcId) {
      const data = await call('/catalog/available_country/get/', { token, query: { bc_id: bcId } });
      return (Array.isArray(data.region_codes) ? data.region_codes : []).filter((code) => /^[A-Z]{2}$/.test(String(code)));
    },

    /** Moedas aceitas em cada país/região (`/catalog/location_currency/get/`): { US: ['USD'], ... }. */
    async getCatalogLocationCurrencies(token) {
      const data = await call('/catalog/location_currency/get/', { token });
      const result = {};
      for (const item of Array.isArray(data.list) ? data.list : []) {
        if (!/^[A-Z]{2}$/.test(String(item?.location ?? ''))) continue;
        const currencies = (Array.isArray(item.currency) ? item.currency : [item.currency]).filter((c) => /^[A-Z]{3}$/.test(String(c)));
        if (currencies.length) result[item.location] = currencies;
      }
      return result;
    },

    /** Cria um catálogo (`/catalog/create/`). País e moeda não podem ser alterados depois. Devolve o ID do catálogo. */
    async createCatalog(token, { bcId, name, regionCode, currency, catalogType = 'ECOM' }) {
      const data = await call('/catalog/create/', {
        token, method: 'POST',
        body: { bc_id: bcId, name, catalog_type: catalogType, catalog_conf: { region_code: regionCode, currency } },
      });
      return requireId(data.catalog_id, 'do catálogo');
    },

    /** Quantos produtos estão aprovados, reprovados e em análise (`/catalog/overview/`). */
    async getCatalogOverview(token, { bcId, catalogId }) {
      const data = await call('/catalog/overview/', { token, query: { bc_id: bcId, catalog_id: catalogId } });
      return { approved: numOrNull(data.approved) ?? 0, rejected: numOrNull(data.rejected) ?? 0, processing: numOrNull(data.processing) ?? 0 };
    },

    /**
     * Envia produtos em lote (`/catalog/product/upload/`, até 5.000; atualização INCREMENTAL: produto novo entra, o mesmo SKU atualiza).
     * O TikTok processa em segundo plano e devolve o `feed_log_id` para acompanhar em `getCatalogProductLog`.
     */
    async uploadCatalogProducts(token, { bcId, catalogId, products }) {
      if (!Array.isArray(products) || !products.length || products.length > CATALOG_UPLOAD_MAX) throw new HttpError(400, `Envie de 1 a ${CATALOG_UPLOAD_MAX} produtos por chamada.`, 'validation_error');
      const data = await call('/catalog/product/upload/', { token, method: 'POST', body: { bc_id: bcId, catalog_id: catalogId, products } });
      const id = String(data.feed_log_id ?? '');
      if (!FEED_LOG_RE.test(id)) throw new HttpError(502, 'O TikTok não retornou o ID do processamento dos produtos.', 'tiktok_bad_response');
      return id;
    },

    /** Resultado do processamento de um envio (`/catalog/product/log/`): status, contagens e os primeiros problemas. */
    async getCatalogProductLog(token, { bcId, catalogId, feedLogId, language = 'en' }) {
      const data = await call('/catalog/product/log/', { token, query: { bc_id: bcId, catalog_id: catalogId, feed_log_id: feedLogId, language } });
      const log = data.product_feed_log ?? {};
      const issues = (list) => (Array.isArray(list) ? list : []).slice(0, 20).map((entry) => ({
        field: typeof entry?.field === 'string' ? entry.field.slice(0, 100) : null,
        issue: typeof entry?.issue === 'string' ? entry.issue.slice(0, 500) : null,
        suggestion: typeof entry?.suggestion === 'string' ? entry.suggestion.slice(0, 500) : null,
        count: numOrNull(entry?.affected_product_count) ?? 0,
        items: (Array.isArray(entry?.affected_product_item_list) ? entry.affected_product_item_list : []).slice(0, 5).map((p) => ({
          index: numOrNull(p?.index), skuId: typeof p?.sku_id === 'string' ? p.sku_id.slice(0, 100) : null, title: typeof p?.title === 'string' ? p.title.slice(0, 200) : null,
        })),
      }));
      const status = ['WAITING', 'PROCESSING', 'SUCCESS', 'FAILED'].includes(log.process_status) ? log.process_status : 'PROCESSING';
      return {
        status, addCount: numOrNull(log.add_count) ?? 0, updateCount: numOrNull(log.update_count) ?? 0, deleteCount: numOrNull(log.delete_count) ?? 0,
        errorCount: numOrNull(log.error_count) ?? 0, warnCount: numOrNull(log.warn_count) ?? 0,
        errors: issues(log.feed_log_data?.error_affected_products), warnings: issues(log.feed_log_data?.warn_affected_products),
      };
    },

    /** Produtos do catálogo (`/catalog/product/get/`): situação de aprovação e se já servem para anúncios. */
    async listCatalogProducts(token, { bcId, catalogId, page = 1, pageSize = 50, skuIds = null, productSetId = null, availableOnly = false }) {
      const size = Math.min(Math.max(1, pageSize), PRODUCT_PAGE_SIZE_MAX);
      const query = { bc_id: bcId, catalog_id: catalogId, page, page_size: size };
      if (skuIds?.length) query.sku_ids = skuIds;
      if (productSetId) query.product_set_ids = [productSetId];
      if (availableOnly) query.product_available_type = 'AVAILABLE';
      const data = await call('/catalog/product/get/', { token, query });
      const products = (Array.isArray(data.list) ? data.list : []).map((p) => ({
        skuId: String(p?.sku_id ?? '').slice(0, 100),
        title: String(p?.title ?? '').slice(0, 500),
        brand: typeof p?.brand === 'string' ? p.brand.slice(0, 150) : null,
        availability: /^[A-Z_]{2,30}$/.test(String(p?.availability ?? '')) ? p.availability : null,
        imageUrl: typeof p?.image_url === 'string' && /^https?:\/\//i.test(p.image_url) ? p.image_url.slice(0, 2000) : null,
        price: numOrNull(p?.price?.price), salePrice: numOrNull(p?.price?.sale_price), currency: typeof p?.price?.currency === 'string' ? p.price.currency.slice(0, 3) : null,
        auditStatus: ['approved', 'rejected', 'processing'].includes(p?.audit?.audit_status) ? p.audit.audit_status : null,
        rejectedReasons: (Array.isArray(p?.audit?.rejected_info) ? p.audit.rejected_info : []).slice(0, 3).map((r) => String(r?.reason ?? '').slice(0, 300)).filter(Boolean),
        suggestion: typeof p?.audit?.suggestion === 'string' ? p.audit.suggestion.slice(0, 300) : null,
        imageStatus: typeof p?.image_status === 'string' ? p.image_status.slice(0, 30) : null,
        adCreationEligible: p?.ad_creation_eligible === 'AVAILABLE',
        active: p?.active_status === 'ACTIVATED',
      })).filter((p) => p.skuId);
      return { products, total: numOrNull(data.page_info?.total_number) ?? products.length, totalPages: numOrNull(data.page_info?.total_page) ?? 1 };
    },

    /** Conjuntos de produtos do catálogo (`/catalog/set/get/`). */
    async listProductSets(token, { bcId, catalogId }) {
      const data = await call('/catalog/set/get/', { token, query: { bc_id: bcId, catalog_id: catalogId, return_product_count: true } });
      return (Array.isArray(data.list) ? data.list : []).map((s) => ({
        id: digitsOrNull(s?.product_set_id), name: String(s?.product_set_name ?? '').slice(0, 200), productCount: numOrNull(s?.product_count),
      })).filter((s) => s.id);
    },

    /** Cria um conjunto de produtos por condições (`/catalog/set/create/`). */
    async createProductSet(token, { bcId, catalogId, name, conditions }) {
      const data = await call('/catalog/set/create/', { token, method: 'POST', body: { bc_id: bcId, catalog_id: catalogId, product_set_name: name, conditions } });
      return { id: requireId(data.product_set_id, 'do conjunto de produtos'), name: String(data.product_set_name ?? name).slice(0, 200), productCount: numOrNull(data.product_count) };
    },

    // ---------- Sincronização automática do catálogo: feeds de dados ----------
    /**
     * Feeds do catálogo (`/catalog/feed/get/`): o feed padrão (envios manuais, sem URL) e os agendados. Nunca devolve credenciais: o TikTok não as
     * devolve e, se a URL de um feed criado fora daqui trouxer usuário/senha, eles são removidos (`redactUrl`).
     */
    async listCatalogFeeds(token, { bcId, catalogId }) {
      const data = await call('/catalog/feed/get/', { token, query: { bc_id: bcId, catalog_id: catalogId } });
      return (Array.isArray(data.feed_list) ? data.feed_list : []).map((f) => {
        const p = f?.last_update_param ?? {};
        return {
          id: digitsOrNull(f?.feed_id),
          name: String(f?.feed_name ?? '').slice(0, 200),
          type: f?.feed_type === 'COUNTRY_FEED' ? 'COUNTRY_FEED' : 'DATA_FEED',
          status: f?.status === 'ON' ? 'ON' : 'OFF',
          url: redactUrl(p.uri),
          updateMode: ['INCREMENTAL', 'OVERWRITE', 'SUPPLEMENT'].includes(p.update_mode) ? p.update_mode : null,
          intervalType: ['HOURLY', 'DAILY', 'MONTHLY'].includes(p.interval_type) ? p.interval_type : null,
          intervalCount: numOrNull(p.interval_count), hour: numOrNull(p.hour), minute: numOrNull(p.minute), dayOfMonth: numOrNull(p.day_of_month),
          timezone: typeof p.timezone === 'string' ? p.timezone.slice(0, 64) : null,
          nextUpdateTime: typeof (f?.next_update_time ?? f?.last_update_param?.next_update_time) === 'string' ? String(f.next_update_time ?? p.next_update_time).slice(0, 19) : null,
          productCount: numOrNull(f?.number_of_products),
        };
      }).filter((f) => f.id);
    },

    /** Cria um feed agendado (`/catalog/feed/create/`): o TikTok busca a URL sozinho e atualiza preço e disponibilidade. Devolve o feed criado. */
    async createCatalogFeed(token, { bcId, catalogId, name, updateMode, url, username, password, intervalType, intervalCount, timezone, hour = 0, minute = 0, dayOfMonth }) {
      const data = await call('/catalog/feed/create/', {
        token, method: 'POST',
        body: {
          bc_id: bcId, catalog_id: catalogId, feed_name: name, update_mode: updateMode, feed_type: 'DATA_FEED',
          schedule_param: {
            source: { uri: url, ...(username ? { username, password } : {}) },
            interval_type: intervalType, interval_count: intervalCount, timezone, hour, minute,
            ...(intervalType === 'MONTHLY' ? { day_of_month: dayOfMonth } : {}),
          },
        },
      });
      return { id: requireId(data.feed_id, 'do feed'), name: String(data.feed_name ?? name).slice(0, 200), status: data.status === 'ON' ? 'ON' : 'OFF', nextUpdateTime: typeof data.next_update_time === 'string' ? data.next_update_time.slice(0, 19) : null };
    },

    /** Liga (ON) ou desliga (OFF) a agenda de um feed (`/catalog/feed/switch/`). O TikTok só aceita um status diferente do atual. */
    async switchCatalogFeed(token, { bcId, catalogId, feedId, status }) {
      if (!['ON', 'OFF'].includes(status)) throw new HttpError(400, 'Status inválido.', 'validation_error');
      await call('/catalog/feed/switch/', { token, method: 'POST', retry: true, body: { bc_id: bcId, catalog_id: catalogId, feed_id: feedId, status } });
    },

    /** Exclui um feed (`/catalog/feed/delete/`). */
    async deleteCatalogFeed(token, { bcId, catalogId, feedId }) {
      await call('/catalog/feed/delete/', { token, method: 'POST', body: { bc_id: bcId, catalog_id: catalogId, feed_id: feedId } });
    },

    /** As últimas execuções do feed (`/catalog/feed/log/`, até 10): quando rodou e quantos produtos entraram, mudaram, saíram ou deram erro. */
    async getCatalogFeedLog(token, { bcId, catalogId, feedId }) {
      const data = await call('/catalog/feed/log/', { token, query: { bc_id: bcId, catalog_id: catalogId, feed_id: feedId } });
      return (Array.isArray(data.feed_logs) ? data.feed_logs : []).slice(0, 10).map((entry) => {
        const status = entry?.last_update_status ?? entry?.update_status ?? {};
        const time = entry?.last_update_time ?? entry?.update_time ?? {};
        return {
          status: ['WAITING', 'PROCESSING', 'SUCCESS', 'FAILED'].includes(status.process_status) ? status.process_status : 'PROCESSING',
          addCount: numOrNull(status.add_count) ?? 0, updateCount: numOrNull(status.update_count) ?? 0, removeCount: numOrNull(status.remove_count) ?? 0,
          errorCount: numOrNull(status.error_count) ?? 0, warnCount: numOrNull(status.warn_count) ?? 0,
          startTime: typeof time.start_time === 'string' ? time.start_time.slice(0, 19) : null, endTime: typeof time.end_time === 'string' ? time.end_time.slice(0, 19) : null,
        };
      });
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
     * O arquivo é transmitido do disco (sem carregar tudo na memória) ou, para imagens pequenas, vem em `data`. `md5` é a assinatura que o TikTok exige.
     */
    async uploadImage(token, { advertiserId, filePath, data: bytes = null, fileName, md5 }) {
      const form = new FormData();
      form.set('advertiser_id', advertiserId);
      form.set('upload_type', 'UPLOAD_BY_FILE');
      form.set('image_signature', md5);
      form.set('file_name', fileName);
      form.set('image_file', bytes ? new Blob([bytes]) : await fs.openAsBlob(filePath), fileName); // `data`: imagem pequena já em memória (ex.: foto da identidade)
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
