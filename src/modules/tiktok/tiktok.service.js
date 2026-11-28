import { AREAS_NEEDING_DOCUMENTS, accountNames, forbidsQualification, normalizeTimezone, requiresPromotionLink } from '../../../shared/advertiser-create.js';
import { isIndustryFor } from '../../../shared/tiktok-industries.js';
import { isAccountLabel } from '../../../shared/account-labels.js';
import { createHash, randomBytes } from 'node:crypto';
import { IDENTITY_NAME_MAX, IDENTITY_PHOTO_MAX_BYTES, IDENTITY_PHOTO_MIN_SIDE, LISTABLE_IDENTITY_TYPES } from '../../../shared/identity.js';
import { MAX_LINK_ADVERTISERS, PIXEL_LINK_ACTIONS, normalizePixelCode } from '../../../shared/pixel-link.js';
import { isUniqueViolation } from '../../db/helpers.js';
import { HttpError, badRequest, forbidden, notFound } from '../../lib/http-error.js';
import { imageInfo } from '../../lib/image-size.js';
import { TtlCache } from '../../lib/ttl-cache.js';
import { sumTotals } from './tiktok.client.js';
import { buildAdGroupPayload, buildAdPayload, buildCampaignPayload } from './tiktok.payloads.js';

const OAUTH_LINK_TTL_MS = 15 * 60 * 1000; // validade do link de autorização
const OAUTH_MAX_PENDING = 5; // links em aberto por usuário
const MAX_OVERVIEW_ADVERTISERS = 20;
const OVERVIEW_CONCURRENCY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const CREATE_PAUSE_MS = 400; // intervalo entre uma criação e outra (o TikTok limita a frequência)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Erros comuns do TikTok ao criar contas, em português e com o que fazer (a mensagem original segue entre parênteses). */
const CREATE_HINTS = [
  [/time ?zone/i, 'O TikTok não aceitou o fuso horário: escolha um da lista.'],
  [/industry/i, 'O TikTok não aceitou o ramo de atividade: escolha um da lista do tipo da sua Business Center.'],
  [/promotion.?link/i, 'Informe o site da empresa (o TikTok exige em Business Center de agência).'],
  [/currency/i, 'A moeda precisa ser a mesma da Business Center.'],
  [/(quota|exceed|limit|maximum)/i, 'Limite de contas da Business Center atingido (diário ou total). Desative contas antigas no TikTok para liberar vagas.'],
  [/(permission|not authorized|admin)/i, 'Sem permissão para criar contas: é preciso ser administrador da Business Center.'],
  [/(qualification|license|billing|tax|email)/i, 'O TikTok pediu documentos ou dados de cobrança para este país/BC, que este sistema ainda não envia.'],
];
function explainCreateError(err) {
  if (!(err instanceof HttpError) || err.code !== 'tiktok_error') return err;
  const hint = CREATE_HINTS.find(([pattern]) => pattern.test(err.message))?.[1];
  return hint ? new HttpError(err.status, `${hint} (${err.message})`, err.code) : err;
}

/** Erros comuns do TikTok ao vincular pixel, em português e com o que fazer (a mensagem original segue entre parênteses). */
const PIXEL_LINK_HINTS = [
  [/(permission|not authorized|admin|role)/i, 'Sem permissão: o seu usuário precisa ser administrador do pixel e das contas de anúncio na Business Center.'],
  [/pixel.*(not exist|not found|invalid|does not)|invalid.*pixel/i, 'O TikTok não encontrou este pixel. Confira o código (o mesmo do Gerenciador de Eventos).'],
  [/(belong|owner|asset)/i, 'O pixel e as contas precisam estar na mesma Business Center.'],
];
function explainPixelLinkError(err) {
  if (!(err instanceof HttpError) || err.code !== 'tiktok_error') return err;
  const hint = PIXEL_LINK_HINTS.find(([pattern]) => pattern.test(err.message))?.[1];
  return hint ? new HttpError(err.status, `${hint} (${err.message})`, err.code) : err;
}

const isoDate = (date) => date.toISOString().slice(0, 10);

/**
 * Regras de negócio da integração com o TikTok.
 *
 * Cada usuário conecta as PRÓPRIAS Business Centers. Uma BC é visível para o dono e, quando o admin a marca
 * como "compartilhada", para toda a equipe aprovada. Gerenciar (editar, sincronizar, remover) cabe ao dono
 * ou ao admin. Os dados (contas, campanhas, desempenho) usam apenas as BCs visíveis para quem pede.
 * `actor` é sempre o usuário autenticado: { id, role }.
 */
export function createTiktokService({ client, repo, attempts, users, proxies = null, guards = {}, statusLog = null, now = () => new Date(), config, log = console }) {
  // `statusLog` (opcional): guarda a situação das contas (ativa, encerrada, punida…) lida do TikTok a cada leitura das contas; sem ele a tela só mostra o que a coleta por hora já anotou.
  // `guards`: ganchos ligados depois da montagem (assinaturas): `beforeConnect(ownerId, { bcIds, advertiserIds })` pode recusar a conexão;
  // `beforeRemove(connection)` roda antes de apagar uma conexão. Sem ganchos, nada acontece (a integração com o TikTok não depende deles).
  const creating = new Set(); // conexões com criação de contas em andamento (evita clique duplo / pedidos simultâneos)
  const linking = new Set(); // conexões com vínculo de pixel em andamento (mesma proteção contra clique duplo)
  const dataCache = new TtlCache({ ttlMs: 60_000 });
  const overviewCache = new TtlCache({ ttlMs: 5 * 60_000, maxEntries: 200 });
  const invalidate = () => {
    dataCache.clear();
    overviewCache.clear();
  };

  /**
   * Cliente do TikTok para as chamadas feitas em nome de um DONO de Business Center: se ele tem uma proxy ativa, todas as
   * chamadas saem por ela (e falham, sem conexão direta, se ela não funcionar). O IP de saída fica sempre o mesmo para a BC.
   */
  async function apiFor(ownerId) {
    const route = proxies ? await proxies.routeFor(ownerId) : null;
    return route ? client.through(route) : client;
  }

  const isAdmin = (actor) => actor.role === 'admin';
  const canManage = (actor, bc) => isAdmin(actor) || bc.ownerId === actor.id;

  /** Visão pública (sem token). O admin também enxerga o dono; usuários comuns não. */
  const present = (actor, bc) => ({
    id: bc.id,
    bcId: bc.bcId,
    // IDs da Business Center: o informado no cadastro por token, ou (conexão por link) o das BCs donas das contas autorizadas.
    bcIds: bc.bcId ? [bc.bcId] : bc.ownerBcIds,
    // Quantas contas de anúncio há em cada Business Center do TikTok dentro desta conexão (uma conexão por link pode cobrir várias).
    bcGroups: bc.bcId ? [{ id: bc.bcId, accounts: bc.advertiserCount }] : bc.ownerBcGroups,
    currencies: bc.currencies, // moedas das contas desta conexão e quantas contas há em cada uma
    authType: bc.authType,
    viaProxy: bc.viaProxy,
    name: bc.name,
    shared: bc.shared,
    status: bc.status,
    lastError: bc.lastError,
    lastSyncedAt: bc.lastSyncedAt,
    advertiserCount: bc.advertiserCount,
    inactiveCount: bc.inactiveCount, // contas cuja situação no TikTok é diferente de "ativa" (encerrada, punida, em análise…)
    createdAt: bc.createdAt,
    owned: bc.ownerId === actor.id,
    canManage: canManage(actor, bc),
    ...(isAdmin(actor) ? { ownerName: bc.ownerName } : {}),
  });

  /**
   * Busca uma BC para gerenciar. Não visível ao usuário -> 404 (não revela que existe);
   * visível (compartilhada) mas sem permissão -> 403.
   */
  async function requireManageable(actor, id) {
    const bc = await repo.get(id);
    if (!bc || !(isAdmin(actor) || bc.ownerId === actor.id || bc.shared)) throw notFound('Business Center não encontrada.');
    if (!canManage(actor, bc)) throw forbidden('Somente o dono da Business Center ou um administrador pode alterá-la.');
    return bc;
  }

  /** A conexão precisa estar ativa e a Business Center informada precisa ser uma das dela (nunca confiamos no ID que veio da tela). */
  function requirePixelLinkScope(bc, tiktokBcId) {
    if (bc.status !== 'active') throw new HttpError(409, 'Esta conexão está com erro. Renove o acesso ou atualize o token antes de vincular pixels.', 'tiktok_connection_error');
    const allowed = bc.bcId ? [bc.bcId] : bc.ownerBcIds;
    if (!allowed.includes(tiktokBcId)) throw badRequest('Esta Business Center do TikTok não pertence a esta conexão.');
  }

  /** No cadastro, "token recusado" vira erro de validação (400), não de reconexão. */
  const asValidationError = (err) =>
    err instanceof HttpError && err.code === 'tiktok_reauth'
      ? badRequest('Token inválido ou sem permissão nesta Business Center.', 'tiktok_token_invalid')
      : err;

  /**
   * Contas de anúncio com nome, moeda, fuso e a BC dona (`ownerBcId`). `discoverBc` (conexões por link, que não têm o ID da BC):
   * se nenhuma conta informou a BC dona, tenta a lista de BCs do token, e só usa o resultado se houver UMA (sem adivinhar). É
   * melhor esforço: falhar aqui nunca impede a conexão nem a sincronização.
   */
  async function loadAdvertisersByIds(token, ids, api, { discoverBc = false } = {}) {
    const info = ids.length ? await api.getAdvertiserInfo(token, ids) : [];
    const byId = new Map(info.map((a) => [a.id, a]));
    const list = ids.map((id) => byId.get(id) ?? { id, name: id, currency: null, timezone: null, ownerBcId: null, status: null });
    if (discoverBc && list.length && !list.some((a) => a.ownerBcId)) {
      try {
        const centers = await api.listBusinessCenters(token);
        if (centers.length === 1) for (const a of list) a.ownerBcId = centers[0].id;
      } catch {
        /* sem permissão para listar BCs (ou falha momentânea): segue sem o ID */
      }
    }
    return list;
  }

  /** Token manual: contas atribuídas à Business Center informada. */
  async function loadAdvertisers(token, bcId, api) {
    return loadAdvertisersByIds(token, await api.listBusinessCenterAdvertiserIds(token, bcId), api);
  }

  /**
   * Guarda a situação das contas lida agora (a mesma tabela da coleta por hora: mudanças viram eventos para o assistente).
   * Melhor esforço: falhar aqui nunca impede de conectar, sincronizar ou criar contas.
   */
  async function recordStatuses(ownerId, advertisers) {
    if (!statusLog) return;
    const known = advertisers.filter((a) => a.status).map((a) => ({ id: a.id, name: a.name, status: a.status }));
    if (!known.length) return;
    try {
      await statusLog.record(ownerId, known, now());
    } catch (err) {
      log.error('[tiktok] não foi possível guardar a situação das contas:', err.code ?? err.message);
    }
  }

  /** Conexão por link: contas que o usuário autorizou para o app (a lista cresce se ele reautorizar com mais contas). */
  async function loadOauthAdvertisers(token, api) {
    const { appId, appSecret } = config.tiktok.oauth;
    return loadAdvertisersByIds(token, await api.listAuthorizedAdvertiserIds(token, { appId, appSecret }), api, { discoverBc: true });
  }

  /** Texto seguro para o usuário quando a autorização falha (nunca ecoa token, código ou detalhes internos). */
  function oauthFailureMessage(err) {
    if (err instanceof HttpError) {
      if (err.code === 'tiktok_unreachable') return 'Não foi possível falar com o TikTok agora. Gere um novo link e tente de novo em instantes.';
      if (err.code === 'tiktok_rate_limited') return 'O TikTok limitou as requisições. Aguarde um pouco e gere um novo link.';
      if (err.code === 'proxy_error') return 'A proxy configurada falhou e nada foi enviado fora dela. Verifique em Contas TikTok → Proxy e gere um novo link.';
      if (/app_id|secret/i.test(err.message)) return 'O app do TikTok não está configurado corretamente no servidor (App ID/Secret). Avise o administrador.';
      if (err.code === 'billing_locked') return err.message;
      if (err.code === 'tiktok_error' || err.code === 'tiktok_reauth') return 'O TikTok recusou a autorização (o link pode ter expirado ou já ter sido usado). Gere um novo link.';
    }
    return 'Não foi possível concluir a autorização. Gere um novo link e tente de novo.';
  }

  /**
   * Executa uma chamada com o token da BC dona da conta (`fn(token, api)`: `api` já leva a proxy do dono da BC, se houver);
   * marca a BC com erro se o token caiu.
   */
  async function withBusinessCenterToken(bcRowId, fn) {
    let access;
    try {
      access = await repo.getAccess(bcRowId);
    } catch {
      // Dado ilegível (ex.: TOKEN_ENCRYPTION_KEY foi trocada): pede um novo token em vez de falhar com 500.
      await repo.markError(bcRowId, 'Não foi possível ler o token salvo (a chave de criptografia mudou?). Informe o token novamente.');
      invalidate();
      throw new HttpError(409, 'Não foi possível ler o token salvo desta Business Center. Atualize o token.', 'tiktok_token_unreadable');
    }
    if (!access) throw notFound('Business Center não encontrada.');
    const api = await apiFor(access.ownerId); // proxy_error aqui: nenhuma chamada sai sem a proxy
    try {
      return await fn(access.token, api);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'tiktok_reauth') {
        await repo.markError(bcRowId, 'Token inválido, expirado ou revogado. Atualize o token.');
        invalidate();
      }
      throw err;
    }
  }

  /** A conta de anúncio precisa pertencer a uma BC ativa e visível para quem pede. */
  async function requireAdvertiser(actor, advertiserId) {
    const advertiser = await repo.findAdvertiser(advertiserId, actor.id);
    if (!advertiser) throw notFound('Conta de anúncio não encontrada ou Business Center com erro.');
    return advertiser;
  }

  /** Período de `days` dias terminando hoje; com `offsetDays`, o mesmo tamanho terminando antes (período anterior). */
  function periodRange(days, offsetDays = 0) {
    const end = new Date(Date.now() - offsetDays * DAY_MS);
    return { startDate: isoDate(new Date(end.getTime() - (days - 1) * DAY_MS)), endDate: isoDate(end) };
  }

  /** Relatório diário da conta no período atual ou (`previous`) no período imediatamente anterior, em cache. */
  function cachedReport(advertiser, days, { previous = false } = {}) {
    return dataCache.remember(`report:${advertiser.businessCenterId}:${advertiser.id}:${days}${previous ? ':prev' : ''}`, () =>
      withBusinessCenterToken(advertiser.businessCenterId, (token, api) => api.getDailyReport(token, advertiser.id, periodRange(days, previous ? days : 0))),
    );
  }

  /** Série diária contínua (um ponto por dia do período, mesmo sem gasto) somando as contas, com CTR e CPC do dia. */
  function buildDaily(rows, range) {
    const byDate = new Map();
    for (let t = Date.parse(`${range.startDate}T00:00:00Z`); t <= Date.parse(`${range.endDate}T00:00:00Z`); t += DAY_MS) {
      byDate.set(isoDate(new Date(t)), { date: isoDate(new Date(t)), spend: 0, impressions: 0, clicks: 0, conversions: 0 });
    }
    for (const row of rows) {
      const day = byDate.get(row.date) ?? { date: row.date, spend: 0, impressions: 0, clicks: 0, conversions: 0 };
      day.spend += row.spend;
      day.impressions += row.impressions;
      day.clicks += row.clicks;
      day.conversions += row.conversions;
      byDate.set(row.date, day);
    }
    return [...byDate.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ ...d, ctr: d.impressions ? (d.clicks / d.impressions) * 100 : 0, cpc: d.clicks ? d.spend / d.clicks : 0 }));
  }

  function ensureOauthEnabled() {
    if (!config.tiktok.oauth.enabled) {
      throw new HttpError(503, 'A conexão por link ainda não foi habilitada neste servidor (falta cadastrar o app do TikTok). Use o token de acesso.', 'tiktok_oauth_not_configured');
    }
  }

  return {
    /** Uso INTERNO (coleta por hora): executa `fn(token, api)` com o token da conexão, pela proxy do dono e marcando erro de acesso. */
    withToken: withBusinessCenterToken,

    isConfigured: () => config.tiktok.configured,

    ensureConfigured() {
      if (!config.tiktok.configured) {
        throw new HttpError(503, 'Defina TOKEN_ENCRYPTION_KEY no servidor para cadastrar Business Centers.', 'tiktok_not_configured');
      }
    },

    /** Usuário comum: as próprias + compartilhadas. Admin: todas (supervisão). */
    async listBusinessCenters(actor) {
      const list = await (isAdmin(actor) ? repo.listAll() : repo.listVisible(actor.id));
      return list.map((bc) => present(actor, bc));
    },
    /** Contas de anúncio visíveis; `canLabel` diz se quem pede pode etiquetá-las (dono da BC ou admin). */
    async listAdvertisers(actor) {
      const list = await repo.advertisers(actor.id);
      return list.map((a) => ({ ...a, canLabel: isAdmin(actor) || a.businessCenterOwned }));
    },

    /**
     * Etiqueta (ex.: conta de agência) ou, com `label` nulo, remove a etiqueta de contas de UMA Business Center.
     * Só o dono da BC ou o admin; ID que não pertence à BC faz o pedido inteiro falhar (nada é alterado pela metade).
     */
    async setAdvertiserLabels(actor, bcRowId, advertiserIds, label) {
      if (label !== null && !isAccountLabel(label)) throw badRequest('Etiqueta inválida.');
      await requireManageable(actor, bcRowId);
      const unique = [...new Set(advertiserIds)];
      const changed = await repo.setAdvertiserLabels(bcRowId, unique, label);
      if (changed !== unique.length) throw notFound('Alguma conta de anúncio não pertence a esta Business Center.');
      invalidate();
      return { updated: changed };
    },

    async addBusinessCenter(actor, { bcId, name, accessToken, shared = false }) {
      if (shared && !isAdmin(actor)) throw forbidden('Somente administradores podem compartilhar uma Business Center com a equipe.');
      if (await repo.existsForOwner(actor.id, bcId)) throw new HttpError(409, 'Você já cadastrou esta Business Center.', 'conflict');
      let advertisers;
      try {
        advertisers = await loadAdvertisers(accessToken, bcId, await apiFor(actor.id)); // valida o token antes de gravar (pela proxy do usuário, se houver)
      } catch (err) {
        throw asValidationError(err);
      }
      // Débito de outra conta nesta BC (ou nas contas dela): recusa antes de gravar qualquer coisa.
      await guards.beforeConnect?.(actor.id, { bcIds: [bcId, ...advertisers.map((a) => a.ownerBcId)], advertiserIds: advertisers.map((a) => a.id) });
      let id;
      try {
        id = await repo.create({ ownerId: actor.id, bcId, name, accessToken, shared, advertisers });
      } catch (err) {
        // Dois cadastros simultâneos da mesma BC: o UNIQUE do banco decide quem vence.
        if (isUniqueViolation(err)) throw new HttpError(409, 'Você já cadastrou esta Business Center.', 'conflict');
        throw err;
      }
      await recordStatuses(actor.id, advertisers);
      invalidate();
      return present(actor, await repo.get(id));
    },

    async updateBusinessCenter(actor, id, { name, accessToken, shared }) {
      const current = await requireManageable(actor, id);
      if (shared !== undefined && !isAdmin(actor)) throw forbidden('Somente administradores podem alterar o compartilhamento.');
      if (accessToken && current.authType === 'oauth') throw badRequest('Esta conexão foi feita por link: para trocar o acesso, gere um novo link de autorização.', 'oauth_token_not_editable');
      if (accessToken) {
        let advertisers;
        try {
          advertisers = await loadAdvertisers(accessToken, current.bcId, await apiFor(current.ownerId));
        } catch (err) {
          throw asValidationError(err);
        }
        await repo.replaceToken(id, accessToken, advertisers);
        await recordStatuses(current.ownerId, advertisers);
      }
      if (name) await repo.rename(id, name);
      if (shared !== undefined) await repo.setShared(id, shared);
      invalidate();
      return present(actor, await repo.get(id));
    },

    /** Relê as contas de anúncio da BC usando o token já salvo. */
    async syncBusinessCenter(actor, id) {
      const current = await requireManageable(actor, id);
      if (current.authType === 'oauth') ensureOauthEnabled();
      const advertisers = await withBusinessCenterToken(id, (token, api) => (current.authType === 'oauth' ? loadOauthAdvertisers(token, api) : loadAdvertisers(token, current.bcId, api)));
      await repo.replaceAdvertisers(id, advertisers);
      await recordStatuses(current.ownerId, advertisers); // a situação (ativa, encerrada, punida…) vem junto na mesma leitura
      invalidate();
      return present(actor, await repo.get(id));
    },

    // ---------- criar contas de anúncio dentro de uma Business Center ("+ CA") ----------
    /**
     * Dados para o formulário "+ CA": o que a documentação oficial do TikTok diz sobre a BC (tipo, moeda, fuso, país, papel do usuário,
     * `/bc/get/`) e sugestões de empresa/ramo/contato copiadas de uma conta que a BC já tem. Tudo é melhor esforço: qualquer falha
     * devolve o que se sabe, nunca impede de criar. `bc` é null se o TikTok não listou a BC para este acesso.
     */
    async advertiserDefaults(actor, bcRowId, tiktokBcId) {
      const bc = await requireManageable(actor, bcRowId);
      const allowed = bc.bcId ? [bc.bcId] : bc.ownerBcIds;
      if (!allowed.includes(tiktokBcId)) throw badRequest('Esta Business Center do TikTok não pertence a esta conexão.');
      const sample = await repo.sampleAdvertiser(bcRowId, bc.bcId ? null : tiktokBcId);
      let info = null;
      let profile = {};
      try {
        ({ info, profile } = await withBusinessCenterToken(bcRowId, async (token, api) => ({
          info: await api.getBcInfo(token, tiktokBcId).catch(() => null),
          profile: sample ? await api.getAdvertiserProfile(token, sample.id).catch(() => ({})) : {},
        })));
      } catch {
        /* sem os dados da BC: o usuário preenche à mão */
      }
      const validTimezone = (zone) => (normalizeTimezone(zone) ? zone : null); // só códigos da tabela oficial (ex.: "Etc/GMT+5" não vale)
      const industry = profile.industry && isIndustryFor(Number(profile.industry), info?.type ?? null) ? String(profile.industry) : null;
      return {
        bc: info
          ? { ...info, requiresPromotionLink: requiresPromotionLink(info.type), isAdmin: info.userRole ? info.userRole === 'ADMIN' : null, needsDocuments: Boolean(AREAS_NEEDING_DOCUMENTS[info.registeredArea]) }
          : null,
        defaults: {
          currency: info?.currency ?? profile.currency ?? sample?.currency ?? null, // o TikTok exige a moeda da Business Center
          timezone: validTimezone(info?.timezone) ?? validTimezone(profile.timezone) ?? validTimezone(sample?.timezone),
          company: profile.company ?? info?.company ?? null,
          country: info?.registeredArea ?? profile.country ?? null,
          contactEmail: profile.contactEmail ?? null,
          industry,
        },
      };
    },

    /**
     * Cria `count` contas de anúncio na Business Center do TikTok informada, UMA de cada vez (com pausa). Só o dono da conexão ou o
     * admin; a BC do TikTok precisa ser uma das desta conexão. Uma criação por vez por conexão (409 se já houver outra em
     * andamento). Se uma falhar, as seguintes NÃO são tentadas (o motivo costuma ser o mesmo) e o resultado diz o que já foi criado.
     * Ao final relê as contas da conexão (melhor esforço) para elas aparecerem na lista.
     */
    async createAdvertisers(actor, bcRowId, { bcId: tiktokBcId, count, name, currency, timezone, company, registeredArea, industry, contactEmail = null, contactName = null, promotionLink = null }) {
      const bc = await requireManageable(actor, bcRowId);
      if (bc.status !== 'active') throw new HttpError(409, 'Esta conexão está com erro. Renove o acesso ou atualize o token antes de criar contas.', 'tiktok_connection_error');
      const allowed = bc.bcId ? [bc.bcId] : bc.ownerBcIds;
      if (!allowed.includes(tiktokBcId)) throw badRequest('Esta Business Center do TikTok não pertence a esta conexão.');
      if (creating.has(bcRowId)) throw new HttpError(409, 'Já existe uma criação de contas em andamento nesta conexão. Aguarde terminar.', 'create_in_progress');
      creating.add(bcRowId);
      const created = [];
      let failure = null;
      try {
        await withBusinessCenterToken(bcRowId, async (token, api) => {
          // Confere, ANTES de criar qualquer coisa, o que a documentação oficial exige para o tipo desta BC.
          const info = await api.getBcInfo(token, tiktokBcId).catch(() => null);
          if (info?.userRole && info.userRole !== 'ADMIN') throw new HttpError(403, 'Seu usuário não é administrador desta Business Center no TikTok. Só administradores criam contas de anúncio.', 'bc_not_admin');
          if (info?.currency && currency !== info.currency) throw badRequest(`A moeda das contas precisa ser a mesma da Business Center (${info.currency}).`, 'currency_mismatch');
          for (const area of [registeredArea, info?.registeredArea]) {
            if (AREAS_NEEDING_DOCUMENTS[area]) throw badRequest(`Contas registradas em ${AREAS_NEEDING_DOCUMENTS[area]} exigem documentos (licença/CNPJ, imagens de qualificação, e-mail e dados de cobrança) que este sistema ainda não envia. Crie-as pelo próprio TikTok.`, 'documents_required');
          }
          if (!isIndustryFor(industry, info?.type ?? null)) throw badRequest('Ramo de atividade não permitido para este tipo de Business Center. Escolha um da lista.', 'invalid_industry');
          if (requiresPromotionLink(info?.type) && !promotionLink) throw badRequest('Esta Business Center é de agência: informe o site da empresa (obrigatório pelo TikTok).', 'promotion_link_required');
          const sendLink = forbidsQualification(info?.type) ? null : promotionLink; // BC DIRECT não pode receber qualification_info

          for (const [index, accountName] of accountNames(name, count).entries()) {
            if (index > 0) await sleep(CREATE_PAUSE_MS);
            try {
              const id = await api.createAdvertiser(token, { bcId: tiktokBcId, name: accountName, currency, timezone, company, registeredArea, industry, contactEmail, contactName, promotionLink: sendLink });
              created.push({ id, name: accountName });
            } catch (raw) {
              const err = explainCreateError(raw);
              if (!created.length) throw err; // nada foi criado: erro normal (o motivo vai para a tela)
              failure = err instanceof HttpError ? { message: err.message, code: err.code } : { message: 'Erro inesperado ao criar a próxima conta.', code: 'unexpected' };
              break;
            }
          }
        });
      } finally {
        creating.delete(bcRowId);
      }
      log.info(`[tiktok] contas de anúncio criadas: usuário ${actor.id}, conexão ${bcRowId}, ${created.length} de ${count}`); // sem token nem dados da conta
      invalidate();

      // As contas novas só aparecem nesta conexão depois de relidas no TikTok (pode haver atraso do lado do TikTok).
      let visible = 0;
      try {
        const current = await repo.get(bcRowId);
        const advertisers = await withBusinessCenterToken(bcRowId, (token, api) => (current.authType === 'oauth' ? loadOauthAdvertisers(token, api) : loadAdvertisers(token, current.bcId, api)));
        await repo.replaceAdvertisers(bcRowId, advertisers);
        await recordStatuses(current.ownerId, advertisers);
        const known = new Set(advertisers.map((a) => a.id));
        visible = created.filter((c) => c.id && known.has(c.id)).length;
        invalidate();
      } catch {
        /* a criação deu certo; a lista é atualizada ao clicar em "Atualizar contas" */
      }
      return { requested: count, created, visible, failure, businessCenter: present(actor, await repo.get(bcRowId)) };
    },

    /**
     * Contas de anúncio já vinculadas a um pixel (`pixelCode`) da Business Center `tiktokBcId` desta conexão. Devolve só os IDs que a pessoa
     * enxerga nesta conexão (o TikTok pode listar contas de outras conexões; elas não são reveladas).
     */
    async pixelLinks(actor, bcRowId, { bcId: tiktokBcId, pixelCode }) {
      const bc = await requireManageable(actor, bcRowId);
      requirePixelLinkScope(bc, tiktokBcId);
      const mine = new Set(await repo.advertiserIds(bcRowId));
      const linked = await withBusinessCenterToken(bcRowId, (token, api) => api.getPixelLinks(token, { bcId: tiktokBcId, pixelCode })).catch((err) => { throw explainPixelLinkError(err); });
      return { advertiserIds: linked.filter((id) => mine.has(id)) };
    },

    /**
     * Vincula (`LINK`) ou desvincula (`UNLINK`) um pixel a contas de anúncio, pela Business Center dona do pixel. Só contas DESTA conexão
     * (nada é enviado ao TikTok com ID de conta alheia). Um pedido por vez em cada conexão. Depois, relê o vínculo para confirmar.
     */
    async updatePixelLinks(actor, bcRowId, { bcId: tiktokBcId, pixelCode, advertiserIds, action }) {
      if (!PIXEL_LINK_ACTIONS.includes(action)) throw badRequest('Ação inválida: use vincular ou desvincular.');
      const unique = [...new Set(advertiserIds)];
      if (!unique.length || unique.length > MAX_LINK_ADVERTISERS) throw badRequest(`Escolha de 1 a ${MAX_LINK_ADVERTISERS} contas de anúncio.`);
      if (!normalizePixelCode(pixelCode)) throw badRequest('Código do pixel inválido (letras e números, como no Gerenciador de Eventos).');
      const bc = await requireManageable(actor, bcRowId);
      requirePixelLinkScope(bc, tiktokBcId);
      const mine = new Set(await repo.advertiserIds(bcRowId));
      if (unique.some((id) => !mine.has(id))) throw notFound('Alguma conta de anúncio não pertence a esta conexão.');
      if (linking.has(bcRowId)) throw new HttpError(409, 'Já existe um vínculo de pixel em andamento nesta conexão. Aguarde terminar.', 'link_in_progress');
      linking.add(bcRowId);
      try {
        await withBusinessCenterToken(bcRowId, (token, api) => api.updatePixelLink(token, { bcId: tiktokBcId, pixelCode, advertiserIds: unique, action })).catch((err) => { throw explainPixelLinkError(err); });
      } finally {
        linking.delete(bcRowId);
      }
      invalidate(); // as listas de pixels por conta (cache de 60 s) passam a mostrar o pixel recém-vinculado
      log.info(`[tiktok] pixel ${action === 'LINK' ? 'vinculado' : 'desvinculado'}: usuário ${actor.id}, conexão ${bcRowId}, ${unique.length} conta(s)`); // sem token
      let linked = null;
      try {
        linked = (await withBusinessCenterToken(bcRowId, (token, api) => api.getPixelLinks(token, { bcId: tiktokBcId, pixelCode }))).filter((id) => mine.has(id));
      } catch {
        /* o vínculo foi feito; a conferência é só um extra: a tela consulta de novo ao reabrir */
      }
      return { action, requested: unique.length, advertiserIds: linked };
    },

    async removeBusinessCenter(actor, id) {
      const connection = await requireManageable(actor, id);
      await guards.beforeRemove?.(connection); // guarda o gasto e, havendo débito, bloqueia a BC (se falhar, a remoção NÃO acontece)
      await repo.remove(id);
      invalidate();
    },

    // ---------- conexão por link de autorização ----------
    /** O que a tela precisa saber: o link está habilitado? (a URI de retorno só interessa a quem configura o app) */
    oauthInfo: (actor) => ({ available: config.tiktok.oauth.enabled, ...(isAdmin(actor) ? { redirectUri: config.tiktok.oauth.redirectUri } : {}) }),

    /** Gera o link de autorização (15 min, uso único). O usuário o abre onde está logado na Business Center do TikTok. */
    async startConnection(actor, { name }) {
      ensureOauthEnabled();
      await attempts.purgeOld();
      if ((await attempts.countPending(actor.id)) >= OAUTH_MAX_PENDING) {
        throw new HttpError(429, 'Você já tem vários links de conexão em aberto. Use um deles, cancele ou aguarde expirarem.', 'too_many_pending');
      }
      const { attemptId, state, expiresAt } = await attempts.create(actor.id, { name, ttlMs: OAUTH_LINK_TTL_MS });
      const url = new URL('/portal/auth', config.tiktok.apiBase);
      url.searchParams.set('app_id', config.tiktok.oauth.appId);
      url.searchParams.set('state', state);
      url.searchParams.set('redirect_uri', config.tiktok.oauth.redirectUri);
      return { attemptId, url: url.toString(), expiresAt };
    },

    /** Resultado da tentativa (só o dono enxerga). */
    async connectionStatus(actor, attemptId) {
      const attempt = await attempts.findForUser(actor.id, attemptId);
      if (!attempt) throw notFound('Tentativa de conexão não encontrada.');
      const stale = (attempt.status === 'pending' || attempt.status === 'processing') && attempt.expired;
      const connection = attempt.status === 'connected' && attempt.connectionId ? await repo.get(attempt.connectionId) : null;
      return { status: stale ? 'expired' : attempt.status, message: attempt.message, expiresAt: attempt.expiresAt, connection: connection ? present(actor, connection) : null };
    },

    async cancelConnection(actor, attemptId) {
      await attempts.cancel(actor.id, attemptId);
    },

    /**
     * Retorno da autorização (público: vem do TikTok, sem a sessão do usuário). Quem autentica o fluxo é o `state`:
     * aleatório, de uso único, 15 min, emitido para um usuário logado e aprovado.
     * Retorna { status: 'connected' | 'denied' | 'error' | 'expired' } para a tela de resultado.
     */
    async completeConnection({ state, authCode, error }) {
      const attempt = await attempts.claim(state);
      if (!attempt) return { status: 'expired' }; // desconhecido, já usado ou vencido
      const fail = async (status, message) => {
        await attempts.finish(attempt.attemptId, { status, message });
        return { status };
      };
      if (error || typeof authCode !== 'string' || !authCode) return fail('denied', 'A autorização foi cancelada ou negada no TikTok.');
      if (authCode.length > 512) return fail('error', 'Código de autorização inválido. Gere um novo link.');

      const owner = await users.findById(attempt.userId);
      if (!owner || owner.status !== 'approved') return fail('error', 'Sua conta não está habilitada para conectar contas do TikTok.');

      try {
        const { appId, appSecret } = config.tiktok.oauth;
        const api = await apiFor(owner.id); // a troca do código e a leitura das contas saem pela proxy do dono, se houver
        const { accessToken, advertiserIds } = await api.exchangeAuthCode({ appId, appSecret, authCode });
        const ids = advertiserIds.length ? advertiserIds : await api.listAuthorizedAdvertiserIds(accessToken, { appId, appSecret });
        if (!ids.length) return fail('error', 'Nenhuma conta de anúncio foi autorizada. Gere um novo link e selecione ao menos uma conta.');
        const advertisers = await loadAdvertisersByIds(accessToken, ids, api, { discoverBc: true });

        // Reautorizar as mesmas contas atualiza a conexão existente (novo token) em vez de duplicá-la.
        const existingId = await repo.findOauthByAdvertisers(owner.id, ids);
        if (!existingId) await guards.beforeConnect?.(owner.id, { bcIds: advertisers.map((a) => a.ownerBcId), advertiserIds: advertisers.map((a) => a.id) });
        let connectionId = existingId;
        if (existingId) await repo.replaceToken(existingId, accessToken, advertisers);
        else connectionId = await repo.create({ ownerId: owner.id, name: attempt.name, accessToken, advertisers, authType: 'oauth' });
        await recordStatuses(owner.id, advertisers);
        invalidate();
        await attempts.finish(attempt.attemptId, { status: 'connected', connectionId });
        return { status: 'connected' };
      } catch (err) {
        log.error('[tiktok] falha ao concluir a autorização:', err.code ?? err.message); // nunca registra token nem código
        return fail('error', oauthFailureMessage(err));
      }
    },

    /**
     * Publica a campanha no TikTok em 3 níveis (campanha → grupo → anúncio), SEMPRE pausada.
     * `existing` permite retomar uma publicação parcial sem recriar o que já existe.
     * `onCreated(level, id)` é chamado a cada nível criado para persistir o andamento.
     */
    async publishCampaign({ actor, advertiserId, config: campaignConfig, assets = {}, existing = {}, onCreated }) {
      const advertiser = await requireAdvertiser(actor, advertiserId);
      const ids = { campaignId: existing.campaignId ?? null, adGroupId: existing.adGroupId ?? null, adId: existing.adId ?? null };
      return withBusinessCenterToken(advertiser.businessCenterId, async (token, api) => {
        try {
          if (!ids.campaignId) {
            ids.campaignId = await api.createCampaign(token, buildCampaignPayload(advertiserId, campaignConfig));
            await onCreated?.('campaign', ids.campaignId);
          }
          if (!ids.adGroupId) {
            ids.adGroupId = await api.createAdGroup(token, buildAdGroupPayload(advertiserId, ids.campaignId, campaignConfig, { timezone: advertiser.timezone }));
            await onCreated?.('adGroup', ids.adGroupId);
          }
          if (!ids.adId) {
            ids.adId = await api.createAd(token, buildAdPayload(advertiserId, ids.adGroupId, campaignConfig, assets));
            await onCreated?.('ad', ids.adId);
          }
        } catch (err) {
          err.createdIds = { ...ids }; // o chamador registra o que já foi criado
          throw err;
        }
        invalidate();
        return ids;
      });
    },

    /** Confirma que a conta de anúncio é de uma BC ativa e visível ao usuário (senão 404). */
    assertAdvertiserAccess: (actor, advertiserId) => requireAdvertiser(actor, advertiserId),

    /**
     * Envia um criativo da biblioteca para a conta de anúncio, com o token da BC dona da conta.
     * Retorna o ID (image_id / video_id) que o TikTok deu ao arquivo.
     */
    async uploadCreative({ actor, advertiserId, kind, filePath, fileName, md5 }) {
      const advertiser = await requireAdvertiser(actor, advertiserId);
      return withBusinessCenterToken(advertiser.businessCenterId, (token, api) =>
        kind === 'video'
          ? api.uploadVideo(token, { advertiserId, filePath, fileName, md5 })
          : api.uploadImage(token, { advertiserId, filePath, fileName, md5 }),
      );
    },

    async campaigns(actor, advertiserId) {
      const advertiser = await requireAdvertiser(actor, advertiserId);
      return dataCache.remember(`campaigns:${advertiser.businessCenterId}:${advertiserId}`, () =>
        withBusinessCenterToken(advertiser.businessCenterId, (token, api) => api.getCampaigns(token, advertiserId)),
      );
    },

    /** Pixels que já existem na conta de anúncio (para escolher na campanha em vez de digitar o ID). Em cache por 60 s. */
    async pixels(actor, advertiserId, { fresh = false } = {}) {
      const advertiser = await requireAdvertiser(actor, advertiserId);
      const key = `pixels:${advertiser.businessCenterId}:${advertiserId}`;
      if (fresh) dataCache.delete(key); // "Atualizar": quem acabou de criar um pixel no TikTok quer vê-lo agora
      return dataCache.remember(key, () =>
        withBusinessCenterToken(advertiser.businessCenterId, (token, api) => api.listPixels(token, advertiserId)),
      );
    },

    /**
     * Identidades de UM tipo que a conta de anúncio pode usar (para escolher no anúncio em vez de digitar o ID). Em cache por 60 s.
     * Só os tipos que o TikTok lista (identidade personalizada, conta do TikTok vinculada, conta da Business Center).
     */
    async identities(actor, advertiserId, { type, fresh = false } = {}) {
      if (!LISTABLE_IDENTITY_TYPES.includes(type)) throw badRequest('Tipo de identidade inválido.');
      const advertiser = await requireAdvertiser(actor, advertiserId);
      const bcId = advertiser.ownerBcId ?? advertiser.bcId; // a BC dona da conta (o tipo BC_AUTH_TT pergunta por ela)
      if (type === 'BC_AUTH_TT' && !bcId) return [];
      const key = `identities:${advertiser.businessCenterId}:${advertiserId}:${type}`;
      if (fresh) dataCache.delete(key); // "Atualizar" / recém-criada: mostra na hora
      return dataCache.remember(key, () =>
        withBusinessCenterToken(advertiser.businessCenterId, (token, api) => api.listIdentities(token, advertiserId, { identityType: type, bcId })),
      );
    },

    /**
     * Cria uma identidade personalizada (nome + foto opcional) na conta de anúncio, no TikTok. A foto (JPG/PNG, quadrada 1:1, até 2 MB) é
     * conferida AQUI pelo conteúdo (não pelo tipo declarado), enviada à biblioteca de imagens da conta e só então usada na identidade.
     * @param {{ name: string, image?: Buffer|null }} identity
     */
    async createIdentity(actor, advertiserId, { name, image = null }) {
      const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
      if (!clean || clean.length > IDENTITY_NAME_MAX) throw badRequest(`O nome da identidade deve ter de 1 a ${IDENTITY_NAME_MAX} caracteres.`);
      let photo = null;
      if (image) {
        if (image.length > IDENTITY_PHOTO_MAX_BYTES) throw new HttpError(413, 'A foto é grande demais (máximo 2 MB).', 'photo_too_large');
        const info = imageInfo(image);
        if (!info) throw badRequest('A foto precisa ser JPG ou PNG.', 'photo_invalid');
        if (info.width !== info.height) throw badRequest('A foto precisa ser quadrada (largura igual à altura, formato 1:1).', 'photo_not_square');
        if (info.width < IDENTITY_PHOTO_MIN_SIDE) throw badRequest(`A foto é pequena demais (use pelo menos ${IDENTITY_PHOTO_MIN_SIDE} × ${IDENTITY_PHOTO_MIN_SIDE} pixels).`, 'photo_too_small');
        photo = { buffer: image, ext: info.type === 'png' ? 'png' : 'jpg' };
      }
      const advertiser = await requireAdvertiser(actor, advertiserId);
      const id = await withBusinessCenterToken(advertiser.businessCenterId, async (token, api) => {
        let imageId = null;
        if (photo) {
          imageId = await api.uploadImage(token, {
            advertiserId,
            data: photo.buffer,
            fileName: `identidade-${randomBytes(6).toString('hex')}.${photo.ext}`, // o TikTok não aceita dois nomes iguais na mesma conta
            md5: createHash('md5').update(photo.buffer).digest('hex'), // assinatura pedida pelo TikTok (não é senha)
          });
        }
        return api.createIdentity(token, { advertiserId, displayName: clean, imageId });
      });
      invalidate(); // a lista de identidades da conta (cache de 60 s) passa a incluir a nova
      log.info(`[tiktok] identidade personalizada criada: usuário ${actor.id}, conta ${advertiserId}, ${photo ? 'com' : 'sem'} foto`); // sem nome nem token
      return { id, type: 'CUSTOMIZED_USER', name: clean, username: '', available: true };
    },

    report: async (actor, advertiserId, days) => cachedReport(await requireAdvertiser(actor, advertiserId), days),

    /** Visão geral das contas do usuário, agrupada por moeda (valores em moedas diferentes não se somam). */
    /**
     * Visão geral dos relatórios, agrupada por MOEDA (valores de moedas diferentes nunca se somam). Por moeda: totais, série
     * diária contínua e, com `compare`, os totais do período anterior. Também devolve o ranking por conta e a lista de contas
     * (para o filtro). `advertiserId` restringe a uma conta (que precisa ser de uma BC ativa do usuário).
     */
    async overview(actor, days, { advertiserId = null, compare = false } = {}) {
      return overviewCache.remember(`overview:${actor.id}:${days}:${advertiserId ?? 'all'}:${compare ? 1 : 0}`, async () => {
        const all = (await repo.advertisers(actor.id)).filter((a) => a.businessCenterStatus === 'active');
        if (advertiserId && !all.some((a) => a.id === advertiserId)) throw notFound('Conta de anúncio não encontrada ou Business Center com erro.');
        const pool = advertiserId ? all.filter((a) => a.id === advertiserId) : all;
        const selected = pool.slice(0, MAX_OVERVIEW_ADVERTISERS).map((a) => ({ id: a.id, name: a.name, currency: a.currency, businessCenterId: a.businessCenterId }));
        const fetchAll = async (options) => {
          const out = [];
          for (let i = 0; i < selected.length; i += OVERVIEW_CONCURRENCY) {
            out.push(...(await Promise.allSettled(selected.slice(i, i + OVERVIEW_CONCURRENCY).map((a) => cachedReport(a, days, options)))));
          }
          return out;
        };
        const results = await fetchAll({});
        const previousResults = compare ? await fetchAll({ previous: true }) : [];

        const groups = new Map();
        const accounts = [];
        let failed = 0;
        results.forEach((result, index) => {
          if (result.status !== 'fulfilled') {
            failed += 1;
            return;
          }
          const account = selected[index];
          const currency = account.currency ?? 'UNKNOWN';
          const group = groups.get(currency) ?? { currency, advertisers: 0, days: [], previousDays: [] };
          group.advertisers += 1;
          group.days.push(...result.value.days);
          if (previousResults[index]?.status === 'fulfilled') group.previousDays.push(...previousResults[index].value.days);
          groups.set(currency, group);
          accounts.push({ id: account.id, name: account.name, currency: account.currency, totals: sumTotals(result.value.days) });
        });

        const range = periodRange(days);
        return {
          days,
          range,
          compare,
          totalAdvertisers: all.length,
          analyzed: selected.length,
          failed,
          // Todas as contas ativas, para o filtro de conta (mesmo as que passaram do limite de análise).
          accountOptions: all.map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
          groups: [...groups.values()]
            .map((g) => ({
              currency: g.currency,
              advertisers: g.advertisers,
              totals: sumTotals(g.days),
              previous: compare ? sumTotals(g.previousDays) : null,
              daily: buildDaily(g.days, range),
            }))
            .sort((x, y) => y.totals.spend - x.totals.spend),
          accounts: accounts.sort((x, y) => y.totals.spend - x.totals.spend),
        };
      });
    },
  };
}
