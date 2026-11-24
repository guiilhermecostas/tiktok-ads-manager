import { MAX_PRODUCTS_PER_REQUEST, buildSetConditions, isCatalogId, normalizeCatalogInput, normalizeFeedInput, normalizeProduct, normalizeProductSetName } from '../../../shared/catalog.js';
import { HttpError, badRequest, forbidden, notFound } from '../../lib/http-error.js';
import { TtlCache } from '../../lib/ttl-cache.js';
import { toTikTokProduct } from './catalog.payloads.js';

const LIST_TTL_MS = 60_000;
const META_TTL_MS = 10 * 60_000;
const CONCURRENCY = 3;
const NUMERIC_ID = /^\d{1,24}$/;
const FEED_LOG_ID = /^[\w-]{1,64}$/;

/** Mensagem segura para a tela quando o TikTok recusa a consulta (nunca token nem detalhes internos). */
function friendly(err) {
  if (err instanceof HttpError) {
    if (err.code === 'tiktok_reauth') return 'O acesso desta conexão expirou ou foi revogado. Renove o acesso em Contas TikTok.';
    if (err.code === 'tiktok_rate_limited') return 'O TikTok limitou as consultas. Tente de novo em instantes.';
    if (err.code === 'tiktok_error' && /(permission|authoriz|forbid|scope|role|access)/i.test(err.message)) {
      return 'Sem permissão para gerenciar catálogos: o acesso desta conexão precisa incluir "Catálogo" e o usuário precisa ser administrador da Business Center. Renove o acesso (ou gere um token) com essas permissões.';
    }
    if (['tiktok_error', 'proxy_error', 'tiktok_unreachable', 'tiktok_token_unreadable'].includes(err.code)) return err.message;
  }
  return 'Não foi possível consultar os catálogos agora.';
}

/**
 * Catálogo de produtos (Catalog API do TikTok): listar os catálogos de todas as Business Centers do usuário, criar catálogo, enviar produtos,
 * acompanhar o processamento e criar conjuntos de produtos.
 *  - Ver: conexões que o usuário pode usar (as próprias e as compartilhadas). Criar/enviar: só o DONO da conexão ou o admin.
 *  - Cada pedido informa a conexão e a BC do TikTok; a BC precisa ser uma das da conexão (nunca aceitamos BC solta) e o ID do catálogo só numérico.
 *  - Falha em uma BC aparece naquela BC; as outras seguem. Lista em cache por 60 s (muda ao criar um catálogo).
 */
export function createCatalogService({ tiktok, connections, log = console }) {
  const listCache = new TtlCache({ ttlMs: LIST_TTL_MS, maxEntries: 100 });
  const metaCache = new TtlCache({ ttlMs: META_TTL_MS, maxEntries: 100 });
  const inflight = new Map();
  const creating = new Set();
  const versions = new Map(); // pessoa -> contador que invalida a lista dela

  const isAdmin = (actor) => actor.role === 'admin';
  const bcIdsOf = (connection) => (connection.bcId ? [connection.bcId] : connection.ownerBcIds);

  /** A conexão tem que ser visível ao usuário e a BC do TikTok tem que ser uma das dela. `write` exige dono/admin e conexão ativa. */
  async function resolve(actor, { connectionId, bcId }, { write = false } = {}) {
    if (!Number.isInteger(connectionId) || !NUMERIC_ID.test(String(bcId ?? ''))) throw badRequest('Escolha a Business Center.');
    const connection = await connections.get(connectionId);
    if (!connection || !(isAdmin(actor) || connection.ownerId === actor.id || connection.shared)) throw notFound('Business Center não encontrada.');
    if (!bcIdsOf(connection).includes(bcId)) throw badRequest('Esta Business Center do TikTok não pertence a esta conexão.');
    if (connection.status !== 'active') throw new HttpError(409, 'Esta conexão está com erro de acesso. Renove o acesso em Contas TikTok.', 'tiktok_connection_error');
    if (write && !(isAdmin(actor) || connection.ownerId === actor.id)) throw forbidden('Somente o dono da conexão ou um administrador pode alterar catálogos.');
    return connection;
  }
  const catalogRef = async (actor, ref, options) => {
    if (!isCatalogId(ref.catalogId)) throw badRequest('Catálogo inválido.');
    return resolve(actor, ref, options);
  };

  async function fetchBc(connection, bcId) {
    try {
      const catalogs = await tiktok.withToken(connection.id, (token, api) => api.listCatalogs(token, bcId));
      return { ok: true, catalogs };
    } catch (err) {
      log.warn?.(`[catalogo] conexão ${connection.id}, BC ${bcId}: ${err?.code ?? 'erro'}`); // sem token nem dados
      return { ok: false, error: friendly(err) };
    }
  }

  async function build(actor, visible) {
    const businessCenters = [];
    const tasks = [];
    for (const connection of visible) {
      const canManage = isAdmin(actor) || connection.ownerId === actor.id;
      const base = { connectionId: connection.id, connectionName: connection.name, canManage };
      const bcIds = bcIdsOf(connection);
      if (connection.status !== 'active' || !bcIds.length) {
        businessCenters.push({ ...base, bcId: null, status: 'error', error: connection.status !== 'active' ? 'Esta conexão está com erro de acesso. Renove o acesso em Contas TikTok.' : 'O sistema ainda não sabe o ID da Business Center desta conexão. Use "Atualizar contas" em Contas TikTok.' });
        continue;
      }
      for (const bcId of bcIds) tasks.push({ connection, bcId, base });
    }
    const results = new Array(tasks.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
      while (next < tasks.length) {
        const index = next;
        next += 1;
        results[index] = await fetchBc(tasks[index].connection, tasks[index].bcId);
      }
    }));
    const catalogs = [];
    tasks.forEach(({ connection, bcId, base }, index) => {
      const result = results[index];
      businessCenters.push({ ...base, bcId, status: result.ok ? 'ok' : 'error', error: result.ok ? null : result.error, catalogCount: result.ok ? result.catalogs.length : 0 });
      if (result.ok) for (const c of result.catalogs) catalogs.push({ ...c, bcId: bcId, connectionId: connection.id, connectionName: connection.name, canManage: base.canManage });
    });
    return { fetchedAt: new Date().toISOString(), totalConnections: visible.length, businessCenters, catalogs };
  }

  return {
    /** Catálogos de todas as BCs do usuário. `fresh` ignora o cache de 60 s. */
    async list(actor, { fresh = false } = {}) {
      // As conexões entram na chave do cache: conectar (ou remover, ou renovar) uma Business Center muda a lista na hora.
      const visible = await connections.listVisible(actor.id);
      const signature = visible.map((c) => `${c.id}.${c.status}.${bcIdsOf(c).join(',')}`).join('|');
      const key = `catalogs:${actor.id}:${versions.get(actor.id) ?? 0}:${signature}`;
      if (fresh) listCache.delete(key);
      const cached = listCache.get(key);
      if (cached) return cached;
      if (inflight.has(key)) return inflight.get(key);
      const promise = build(actor, visible).then((data) => { listCache.set(key, data); return data; }).finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    },

    /** Países e moedas aceitos para criar um catálogo nesta BC (documentação: /catalog/available_country/get/ e /catalog/location_currency/get/). */
    async meta(actor, ref) {
      const connection = await resolve(actor, ref, { write: true });
      const key = `meta:${connection.id}:${ref.bcId}`;
      const cached = metaCache.get(key);
      if (cached) return cached;
      const meta = await tiktok.withToken(connection.id, async (token, api) => {
        const [regions, currencies] = await Promise.all([api.getCatalogRegions(token, ref.bcId), api.getCatalogLocationCurrencies(token)]);
        return { regions: regions.map((code) => ({ code, currencies: currencies[code] ?? [] })).filter((r) => r.currencies.length) };
      });
      metaCache.set(key, meta);
      return meta;
    },

    /** Cria um catálogo E-commerce. Só dono/admin; uma criação por vez por conexão. País e moeda não mudam depois (o TikTok não permite). */
    async create(actor, { connectionId, bcId, ...input }) {
      const connection = await resolve(actor, { connectionId, bcId }, { write: true });
      const { value, errors } = normalizeCatalogInput(input);
      if (errors.length) throw badRequest(errors[0].message, 'validation_error');
      if (creating.has(connection.id)) throw new HttpError(409, 'Já existe uma criação de catálogo em andamento nesta conexão. Aguarde terminar.', 'create_in_progress');
      creating.add(connection.id);
      try {
        const catalogId = await tiktok.withToken(connection.id, async (token, api) => {
          // Confere ANTES de criar (o catálogo não se desfaz): o país tem que ser aceito e a moeda tem que ser a do país (documentação oficial).
          const [regions, currencies] = await Promise.all([api.getCatalogRegions(token, bcId).catch(() => null), api.getCatalogLocationCurrencies(token).catch(() => null)]);
          if (regions && !regions.includes(value.regionCode)) throw badRequest('Este país não é aceito para catálogos nesta Business Center.', 'invalid_region');
          if (currencies?.[value.regionCode] && !currencies[value.regionCode].includes(value.currency)) throw badRequest(`Para este país, a moeda do catálogo precisa ser: ${currencies[value.regionCode].join(', ')}.`, 'invalid_currency');
          return api.createCatalog(token, { bcId, name: value.name, regionCode: value.regionCode, currency: value.currency, catalogType: value.catalogType });
        });
        log.info?.(`[catalogo] catálogo criado: usuário ${actor.id}, conexão ${connection.id}`); // sem token nem dados
        versions.set(actor.id, (versions.get(actor.id) ?? 0) + 1);
        return { id: catalogId, name: value.name, type: value.catalogType, regionCode: value.regionCode, currency: value.currency, bcId, connectionId: connection.id, connectionName: connection.name, canManage: true };
      } finally {
        creating.delete(connection.id);
      }
    },

    async overview(actor, ref) {
      const connection = await catalogRef(actor, ref);
      return tiktok.withToken(connection.id, (token, api) => api.getCatalogOverview(token, { bcId: ref.bcId, catalogId: ref.catalogId }));
    },

    async products(actor, ref, { page = 1, pageSize = 50, sku = null, productSetId = null, availableOnly = false } = {}) {
      const connection = await catalogRef(actor, ref);
      const skuIds = sku ? [sku] : null;
      if (productSetId && !NUMERIC_ID.test(productSetId)) throw badRequest('Conjunto de produtos inválido.');
      const size = Math.min(Math.max(1, pageSize), 100);
      const current = Math.max(1, page);
      if (current * size > 10_000) throw badRequest('O TikTok só permite navegar pelos primeiros 10.000 produtos. Use a busca por SKU ou um conjunto de produtos.');
      return tiktok.withToken(connection.id, (token, api) => api.listCatalogProducts(token, { bcId: ref.bcId, catalogId: ref.catalogId, page: current, pageSize: size, skuIds, productSetId, availableOnly }));
    },

    /** Envia um lote (até 500) de produtos. Valida de novo TUDO no servidor; um produto inválido recusa o lote inteiro (nada vai pela metade). */
    async uploadProducts(actor, ref, rawProducts) {
      const connection = await catalogRef(actor, ref, { write: true });
      if (!Array.isArray(rawProducts) || !rawProducts.length) throw badRequest('Envie ao menos um produto.');
      if (rawProducts.length > MAX_PRODUCTS_PER_REQUEST) throw badRequest(`Envie no máximo ${MAX_PRODUCTS_PER_REQUEST} produtos por vez.`);
      const products = [];
      const seen = new Set();
      for (const [index, raw] of rawProducts.entries()) {
        const { value, errors } = normalizeProduct(raw);
        if (errors.length) throw badRequest(`Produto ${index + 1}${value.skuId ? ` (${value.skuId})` : ''}: ${errors[0].message} (${errors[0].path})`, 'validation_error');
        if (seen.has(value.skuId)) throw badRequest(`SKU repetido no envio: ${value.skuId}.`, 'validation_error');
        seen.add(value.skuId);
        products.push(toTikTokProduct(value));
      }
      const feedLogId = await tiktok.withToken(connection.id, (token, api) => api.uploadCatalogProducts(token, { bcId: ref.bcId, catalogId: ref.catalogId, products }));
      log.info?.(`[catalogo] ${products.length} produto(s) enviado(s): usuário ${actor.id}, conexão ${connection.id}`);
      return { feedLogId, count: products.length };
    },

    async productLog(actor, ref, feedLogId) {
      const connection = await catalogRef(actor, ref);
      if (typeof feedLogId !== 'string' || !FEED_LOG_ID.test(feedLogId)) throw badRequest('Processamento inválido.');
      return tiktok.withToken(connection.id, (token, api) => api.getCatalogProductLog(token, { bcId: ref.bcId, catalogId: ref.catalogId, feedLogId }));
    },

    async productSets(actor, ref) {
      const connection = await catalogRef(actor, ref);
      return tiktok.withToken(connection.id, (token, api) => api.listProductSets(token, { bcId: ref.bcId, catalogId: ref.catalogId }));
    },

    // ---------- sincronização automática (feeds de dados) ----------
    async feeds(actor, ref) {
      const connection = await catalogRef(actor, ref);
      return tiktok.withToken(connection.id, (token, api) => api.listCatalogFeeds(token, { bcId: ref.bcId, catalogId: ref.catalogId }));
    },

    /**
     * Cria um feed agendado: o TikTok busca a URL sozinho e atualiza preço e disponibilidade. Só dono/admin. O login do feed (se houver) vai direto
     * ao TikTok: não é guardado, devolvido nem registrado em log.
     */
    async createFeed(actor, ref, input) {
      const connection = await catalogRef(actor, ref, { write: true });
      const { value, errors } = normalizeFeedInput(input);
      if (errors.length) throw badRequest(errors[0].message, 'validation_error');
      const feed = await tiktok.withToken(connection.id, (token, api) => api.createCatalogFeed(token, { bcId: ref.bcId, catalogId: ref.catalogId, ...value }));
      log.info?.(`[catalogo] feed agendado criado: usuário ${actor.id}, conexão ${connection.id}`); // sem URL, login nem dados
      return feed;
    },

    async setFeedStatus(actor, ref, feedId, status) {
      const connection = await catalogRef(actor, ref, { write: true });
      if (typeof feedId !== 'string' || !NUMERIC_ID.test(feedId)) throw badRequest('Feed inválido.');
      if (!['ON', 'OFF'].includes(status)) throw badRequest('Status inválido (use ON ou OFF).');
      await tiktok.withToken(connection.id, (token, api) => api.switchCatalogFeed(token, { bcId: ref.bcId, catalogId: ref.catalogId, feedId, status }));
      return { feedId, status };
    },

    async deleteFeed(actor, ref, feedId) {
      const connection = await catalogRef(actor, ref, { write: true });
      if (typeof feedId !== 'string' || !NUMERIC_ID.test(feedId)) throw badRequest('Feed inválido.');
      await tiktok.withToken(connection.id, (token, api) => api.deleteCatalogFeed(token, { bcId: ref.bcId, catalogId: ref.catalogId, feedId }));
    },

    async feedLog(actor, ref, feedId) {
      const connection = await catalogRef(actor, ref);
      if (typeof feedId !== 'string' || !NUMERIC_ID.test(feedId)) throw badRequest('Feed inválido.');
      return tiktok.withToken(connection.id, (token, api) => api.getCatalogFeedLog(token, { bcId: ref.bcId, catalogId: ref.catalogId, feedId }));
    },

    async createProductSet(actor, ref, { name, filters }) {
      const connection = await catalogRef(actor, ref, { write: true });
      const named = normalizeProductSetName(name);
      if (named.error) throw badRequest(named.error, 'validation_error');
      const { conditions, errors } = buildSetConditions(filters);
      if (errors.length) throw badRequest(errors[0].message, 'validation_error');
      return tiktok.withToken(connection.id, (token, api) => api.createProductSet(token, { bcId: ref.bcId, catalogId: ref.catalogId, name: named.name, conditions }));
    },
  };
}
