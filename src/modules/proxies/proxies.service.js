import net from 'node:net';
import { isUniqueViolation } from '../../db/helpers.js';
import { HttpError, badRequest, notFound } from '../../lib/http-error.js';
import { describeProxyError } from './proxy-errors.js';
import { createProxyDispatcher } from './proxy-dispatcher.js';
import { resolveProxyHost } from './proxy-net.js';

const MAX_PROXIES_PER_USER = 20;
const ROUTE_TTL_MS = 5 * 60 * 1000; // renova a resolução de DNS e o pool de conexões a cada 5 min
const TEST_TIMEOUT_MS = 15_000;
// Serviços públicos que só mostram o IP/país visto por eles (a chamada sai PELA proxy; nada nosso é enviado).
const IP_URL = 'https://api.ipify.org?format=json';
const geoUrl = (ip) => `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,country_code`;

/**
 * Proxies do usuário e a ESCOLHA da rota de cada chamada ao TikTok.
 *
 * Regra central: se o dono de uma Business Center tem uma proxy ATIVA, TODA chamada à API do TikTok feita com o token
 * dessa BC sai por ela. Se a proxy não puder ser usada, a chamada FALHA (`proxy_error`): nunca há retorno silencioso
 * para a conexão direta, que exporia o IP real do servidor.
 */
export function createProxiesService({ repo, config, fetchFn = fetch, lookup, log = console }) {
  const allowPrivate = config.proxy?.allowPrivateHosts === true;
  const routes = new Map(); // userId -> { key, expiresAt, route }

  const ensureConfigured = () => {
    if (!config.tiktok.encryptionKey) throw new HttpError(503, 'Defina TOKEN_ENCRYPTION_KEY no servidor para cadastrar proxies.', 'proxy_not_configured');
  };

  async function buildDispatcher(proxy) {
    const resolved = await resolveProxyHost(proxy.host, { allowPrivate, ...(lookup ? { lookup } : {}) });
    return createProxyDispatcher({
      kind: proxy.kind, address: resolved.address, port: proxy.port, hostname: proxy.host,
      username: proxy.username, password: proxy.password, requestTls: config.proxy?.requestTls,
    });
  }

  const closeQuietly = (dispatcher) => dispatcher?.close().catch(() => {});
  function evict(userId) {
    const cached = routes.get(userId);
    routes.delete(userId);
    closeQuietly(cached?.route.dispatcher);
  }

  /** Visão do usuário: sem senha, com o resultado do último teste. */
  const present = (proxy) => (proxy ? { ...proxy, password: undefined } : proxy);

  async function requireOwn(actor, id) {
    const proxy = await repo.get(actor.id, id);
    if (!proxy) throw notFound('Proxy não encontrada.');
    return proxy;
  }

  /** Junta o que veio do formulário com o que já está salvo (senha em branco = manter). */
  function mergeAuth(current, { username, password, clearAuth }, kind) {
    if (clearAuth === true) return null;
    if (username === undefined && password === undefined) return undefined; // não mexe
    const nextUsername = username === undefined ? current?.username ?? null : username || null;
    const nextPassword = password === undefined || password === '' ? current?.password ?? null : password;
    if (kind === 'socks4' && nextPassword) throw badRequest('SOCKS4 não usa senha: informe só o usuário (identificador) ou deixe em branco.', 'proxy_socks4_password');
    return nextUsername || nextPassword ? { username: nextUsername, password: nextPassword } : null;
  }

  return {
    isConfigured: () => Boolean(config.tiktok.encryptionKey),
    maxPerUser: MAX_PROXIES_PER_USER,

    async list(actor) {
      return repo.list(actor.id);
    },

    async create(actor, input) {
      ensureConfigured();
      if ((await repo.count(actor.id)) >= MAX_PROXIES_PER_USER) throw badRequest(`Limite de ${MAX_PROXIES_PER_USER} proxies atingido. Remova alguma antes de cadastrar outra.`, 'proxy_limit');
      // Valida o endereço já na criação (sintaxe + DNS + rede pública): erro cedo, com mensagem clara.
      await resolveProxyHost(input.host, { allowPrivate, ...(lookup ? { lookup } : {}) });
      const auth = mergeAuth(null, input, input.kind);
      let created;
      try {
        created = await repo.create(actor.id, { name: input.name, kind: input.kind, host: input.host, port: input.port, auth: auth ?? null });
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, 'Já existe uma proxy com este nome.', 'conflict');
        throw err;
      }
      if (input.active === true) {
        evict(actor.id);
        return present(await repo.activate(actor.id, created.id));
      }
      return present(created);
    },

    async update(actor, id, input) {
      ensureConfigured();
      const current = await repo.getWithSecrets(actor.id, id);
      if (!current) throw notFound('Proxy não encontrada.');
      if (input.host !== current.host) await resolveProxyHost(input.host, { allowPrivate, ...(lookup ? { lookup } : {}) });
      const auth = mergeAuth(current, input, input.kind);
      if (auth === undefined && input.kind === 'socks4' && current.password) throw badRequest('SOCKS4 não usa senha: remova a senha antes de mudar para SOCKS4.', 'proxy_socks4_password');
      try {
        const updated = await repo.update(actor.id, id, { name: input.name, kind: input.kind, host: input.host, port: input.port, auth });
        evict(actor.id); // a conexão em uso (se for a ativa) precisa ser refeita com os dados novos
        return present(updated);
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, 'Já existe uma proxy com este nome.', 'conflict');
        throw err;
      }
    },

    async remove(actor, id) {
      await requireOwn(actor, id);
      await repo.remove(actor.id, id);
      evict(actor.id);
    },

    async activate(actor, id) {
      await requireOwn(actor, id);
      let proxy;
      // Duas ativações simultâneas podem esbarrar no índice "uma ativa por usuário": a perdedora tenta de novo.
      for (let attempt = 1; ; attempt += 1) {
        try {
          proxy = await repo.activate(actor.id, id);
          break;
        } catch (err) {
          if (!isUniqueViolation(err) || attempt >= 3) throw err;
        }
      }
      evict(actor.id);
      return present(proxy);
    },

    async deactivate(actor, id) {
      await requireOwn(actor, id);
      const proxy = await repo.deactivate(actor.id, id);
      evict(actor.id);
      return present(proxy);
    },

    /**
     * Testa a proxy: conecta por ela, descobre o IP e o país de saída e confirma que o TikTok responde.
     * O resultado fica salvo (e aparece na lista).
     */
    async test(actor, id) {
      ensureConfigured();
      const proxy = await repo.getWithSecrets(actor.id, id);
      if (!proxy) throw notFound('Proxy não encontrada.');
      const started = Date.now();
      const outcome = { ok: false, ip: null, country: null, countryCode: null, tiktokReachable: false, error: null };
      let dispatcher;
      try {
        dispatcher = await buildDispatcher(proxy);
        const getJson = async (url) => {
          const response = await fetchFn(url, { headers: { Accept: 'application/json' }, dispatcher, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
          return { status: response.status, json: await response.json().catch(() => null) };
        };

        const seen = await getJson(IP_URL);
        const ip = typeof seen.json?.ip === 'string' && net.isIP(seen.json.ip) ? seen.json.ip : null;
        if (!ip) throw new HttpError(502, 'A proxy conectou, mas não consegui descobrir o IP de saída.', 'proxy_test_failed');
        outcome.ip = ip;
        try {
          const geo = await getJson(geoUrl(ip)); // melhor esforço: não reprova a proxy
          if (geo.json?.success !== false && typeof geo.json?.country === 'string') {
            outcome.country = geo.json.country.slice(0, 60);
            outcome.countryCode = typeof geo.json.country_code === 'string' ? geo.json.country_code.slice(0, 2) : null;
          }
        } catch {
          /* sem país: segue */
        }

        const tiktok = await getJson(new URL('/open_api/v1.3/oauth2/advertiser/get/', config.tiktok.apiBase).toString());
        outcome.tiktokReachable = tiktok.json !== null && typeof tiktok.json === 'object' && 'code' in tiktok.json;
        if (!outcome.tiktokReachable) outcome.error = 'A proxy conectou, mas não consegue acessar a API do TikTok.';
        outcome.ok = outcome.tiktokReachable;
      } catch (err) {
        outcome.error = err instanceof HttpError ? err.message : `Falha ao conectar pela proxy: ${describeProxyError(err)}.`;
        if (!(err instanceof HttpError)) log.error('[proxy] teste falhou:', describeProxyError(err));
      } finally {
        closeQuietly(dispatcher);
      }
      const saved = await repo.saveTest(actor.id, id, outcome);
      return { ...outcome, latencyMs: Date.now() - started, proxy: present(saved) };
    },

    /**
     * Rota das chamadas ao TikTok de um dono de BC: null (sem proxy ativa: conexão direta) ou { id, name, dispatcher }.
     * Lança `proxy_error` se a proxy ativa não puder ser preparada: NUNCA devolve null por causa de uma falha.
     */
    async routeFor(userId) {
      const proxy = await repo.getActiveWithSecrets(userId);
      if (!proxy) {
        evict(userId);
        return null;
      }
      const key = `${proxy.id}:${proxy.updatedAt}`;
      const cached = routes.get(userId);
      if (cached && cached.key === key && cached.expiresAt > Date.now()) return cached.route;
      let dispatcher;
      try {
        dispatcher = await buildDispatcher(proxy);
      } catch (err) {
        evict(userId);
        const reason = err instanceof HttpError ? err.message : describeProxyError(err);
        throw new HttpError(502, `A proxy ativa "${proxy.name}" não pôde ser usada: ${reason} Nenhuma chamada foi feita fora da proxy.`, 'proxy_error');
      }
      closeQuietly(cached?.route.dispatcher);
      const route = { id: proxy.id, name: proxy.name, dispatcher };
      routes.set(userId, { key, expiresAt: Date.now() + ROUTE_TTL_MS, route });
      return route;
    },

    /** Encerra as conexões abertas (desligamento do servidor). */
    close() {
      for (const userId of [...routes.keys()]) evict(userId);
    },
  };
}
