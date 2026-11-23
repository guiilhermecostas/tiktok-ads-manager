import { accountNames } from '../../../shared/advertiser-create.js';
import { isAccountLabel } from '../../../shared/account-labels.js';
import { isUniqueViolation } from '../../db/helpers.js';
import { HttpError, badRequest, forbidden, notFound } from '../../lib/http-error.js';
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

const isoDate = (date) => date.toISOString().slice(0, 10);

/**
 * Regras de negócio da integração com o TikTok.
 *
 * Cada usuário conecta as PRÓPRIAS Business Centers. Uma BC é visível para o dono e, quando o admin a marca
 * como "compartilhada", para toda a equipe aprovada. Gerenciar (editar, sincronizar, remover) cabe ao dono
 * ou ao admin. Os dados (contas, campanhas, desempenho) usam apenas as BCs visíveis para quem pede.
 * `actor` é sempre o usuário autenticado: { id, role }.
 */
export function createTiktokService({ client, repo, attempts, users, proxies = null, config, log = console }) {
  const creating = new Set(); // conexões com criação de contas em andamento (evita clique duplo / pedidos simultâneos)
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
    const list = ids.map((id) => byId.get(id) ?? { id, name: id, currency: null, timezone: null, ownerBcId: null });
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
      let id;
      try {
        id = await repo.create({ ownerId: actor.id, bcId, name, accessToken, shared, advertisers });
      } catch (err) {
        // Dois cadastros simultâneos da mesma BC: o UNIQUE do banco decide quem vence.
        if (isUniqueViolation(err)) throw new HttpError(409, 'Você já cadastrou esta Business Center.', 'conflict');
        throw err;
      }
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
      invalidate();
      return present(actor, await repo.get(id));
    },

    // ---------- criar contas de anúncio dentro de uma Business Center ("+ CA") ----------
    /**
     * Dados para PRÉ-PREENCHER o formulário: moeda, fuso, empresa, país e contato de uma conta que a BC já tem. Só sugestões
     * (melhor esforço): qualquer falha devolve o que o sistema já sabe, nunca impede de criar.
     */
    async advertiserDefaults(actor, bcRowId, tiktokBcId) {
      const bc = await requireManageable(actor, bcRowId);
      const allowed = bc.bcId ? [bc.bcId] : bc.ownerBcIds;
      if (!allowed.includes(tiktokBcId)) throw badRequest('Esta Business Center do TikTok não pertence a esta conexão.');
      const sample = await repo.sampleAdvertiser(bcRowId, bc.bcId ? null : tiktokBcId);
      const defaults = { currency: sample?.currency ?? null, timezone: sample?.timezone ?? null, company: null, country: null, contactEmail: null, industry: null };
      if (!sample) return defaults;
      try {
        const profile = await withBusinessCenterToken(bcRowId, (token, api) => api.getAdvertiserProfile(token, sample.id));
        for (const [key, value] of Object.entries(profile)) if (value) defaults[key] = value;
      } catch {
        /* sem os dados cadastrais: o usuário preenche à mão */
      }
      return defaults;
    },

    /**
     * Cria `count` contas de anúncio na Business Center do TikTok informada, UMA de cada vez (com pausa). Só o dono da conexão ou o
     * admin; a BC do TikTok precisa ser uma das desta conexão. Uma criação por vez por conexão (409 se já houver outra em
     * andamento). Se uma falhar, as seguintes NÃO são tentadas (o motivo costuma ser o mesmo) e o resultado diz o que já foi criado.
     * Ao final relê as contas da conexão (melhor esforço) para elas aparecerem na lista.
     */
    async createAdvertisers(actor, bcRowId, { bcId: tiktokBcId, count, name, currency, timezone, company, registeredArea, industry, contactEmail = null, contactName = null }) {
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
          for (const [index, accountName] of accountNames(name, count).entries()) {
            if (index > 0) await sleep(CREATE_PAUSE_MS);
            try {
              const id = await api.createAdvertiser(token, { bcId: tiktokBcId, name: accountName, currency, timezone, company, registeredArea, industry, contactEmail, contactName });
              created.push({ id, name: accountName });
            } catch (err) {
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
        const known = new Set(advertisers.map((a) => a.id));
        visible = created.filter((c) => c.id && known.has(c.id)).length;
        invalidate();
      } catch {
        /* a criação deu certo; a lista é atualizada ao clicar em "Atualizar contas" */
      }
      return { requested: count, created, visible, failure, businessCenter: present(actor, await repo.get(bcRowId)) };
    },

    async removeBusinessCenter(actor, id) {
      await requireManageable(actor, id);
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
        let connectionId = existingId;
        if (existingId) await repo.replaceToken(existingId, accessToken, advertisers);
        else connectionId = await repo.create({ ownerId: owner.id, name: attempt.name, accessToken, advertisers, authType: 'oauth' });
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
