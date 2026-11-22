import fs from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { parseEncryptionKey } from './lib/crypto.js';

function parsePort(value) {
  const port = Number(value ?? 3100);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT inválida: ${value}`);
  }
  return port;
}

const OAUTH_CALLBACK_PATH = '/api/tiktok/callback';

/**
 * App do TikTok (API for Business) usado na conexão por link. É UM app da plataforma: cada usuário autoriza o app
 * para as próprias contas. As credenciais são segredos do servidor (nunca vão ao navegador).
 */
function loadOauthConfig({ port, isProduction, encryptionKey }) {
  const appId = (process.env.TIKTOK_APP_ID ?? '').trim();
  const appSecret = (process.env.TIKTOK_APP_SECRET ?? '').trim();
  const redirectUri = (process.env.TIKTOK_REDIRECT_URI ?? '').trim() || `http://localhost:${port}${OAUTH_CALLBACK_PATH}`;
  if (appId || appSecret) {
    if (!/^\d{5,25}$/.test(appId)) throw new Error('TIKTOK_APP_ID inválido (apenas números).');
    if (!/^\S{8,200}$/.test(appSecret)) throw new Error('TIKTOK_APP_SECRET inválido.');
    let url;
    try {
      url = new URL(redirectUri);
    } catch {
      throw new Error('TIKTOK_REDIRECT_URI inválida.');
    }
    if (url.pathname !== OAUTH_CALLBACK_PATH || url.search || url.hash || url.username) throw new Error(`TIKTOK_REDIRECT_URI deve terminar em ${OAUTH_CALLBACK_PATH} (sem parâmetros).`);
    if (isProduction && url.protocol !== 'https:') throw new Error('Em produção, TIKTOK_REDIRECT_URI precisa ser https.');
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('TIKTOK_REDIRECT_URI inválida.');
  }
  return { appId, appSecret, redirectUri, enabled: Boolean(appId && appSecret && encryptionKey) };
}

const DEFAULT_EMAIL_FROM = 'TikTok Ads Manager <convites@payfac.dev>';

/**
 * E-mail transacional (convites de colaboradores) pelo Resend. Tudo é segredo/configuração do SERVIDOR:
 *  - RESEND_API_KEY: chave da API (nunca vai ao navegador nem aos logs). Sem ela, o envio fica desligado.
 *  - EMAIL_FROM: remetente, em domínio verificado no Resend (ex.: "TikTok Ads Manager <convites@payfac.dev>").
 *  - APP_URL: endereço público do sistema, usado nos links dos e-mails. NUNCA é deduzido do cabeçalho Host da requisição
 *    (isso permitiria forjar links de convite apontando para outro site).
 */
export function loadMailConfig({ port, isProduction }) {
  const apiKey = (process.env.RESEND_API_KEY ?? '').trim();
  const from = (process.env.EMAIL_FROM ?? '').trim() || DEFAULT_EMAIL_FROM;
  const rawUrl = (process.env.APP_URL ?? '').trim();
  if (apiKey && !/^re_[A-Za-z0-9_-]{16,200}$/.test(apiKey)) throw new Error('RESEND_API_KEY inválida (deve começar com "re_").');
  if (!/^(?:[^<>\r\n"]{1,80} )?<?[^\s@<>"]{1,64}@[a-z0-9.-]{3,190}\.[a-z]{2,}>?$/i.test(from) || (from.includes('<') !== from.includes('>'))) throw new Error('EMAIL_FROM inválido (use "Nome <email@dominio>").');
  let appUrl = '';
  if (rawUrl || !isProduction) {
    let url;
    try {
      url = new URL(rawUrl || `http://localhost:${port}`);
    } catch {
      throw new Error('APP_URL inválida.');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('APP_URL deve ser só o endereço do sistema (ex.: https://meu-sistema.com).');
    if (isProduction && url.protocol !== 'https:') throw new Error('Em produção, APP_URL precisa ser https.');
    appUrl = url.origin;
  }
  return { apiKey, from, appUrl, enabled: Boolean(apiKey && appUrl) };
}

function loadTiktokConfig(context) {
  const rawKey = (process.env.TOKEN_ENCRYPTION_KEY ?? '').trim();
  const encryptionKey = rawKey ? parseEncryptionKey(rawKey) : null;
  return {
    apiBase: 'https://business-api.tiktok.com',
    encryptionKey,
    oauth: loadOauthConfig({ ...context, encryptionKey }),
    // Sem a chave não é possível guardar tokens com segurança: o cadastro de Business Centers fica desligado.
    configured: Boolean(encryptionKey),
  };
}

/**
 * Quantos proxies reversos confiáveis existem na frente do app (ex.: Render = 1). Com 0 (padrão) o cabeçalho
 * X-Forwarded-For é IGNORADO: qualquer cliente poderia forjá-lo para escapar do limite de tentativas.
 */
function loadTrustProxy() {
  const raw = (process.env.TRUST_PROXY ?? '').trim();
  if (!raw) return 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) throw new Error('TRUST_PROXY inválido (inteiro de 0 a 5: quantos proxies reversos existem na frente do app).');
  return hops;
}

const MB = 1024 * 1024;

/** Inteiro positivo de uma variável de ambiente (em MB), com padrão e teto. */
function megabytes(name, fallback, max) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} inválido (inteiro de 1 a ${max}).`);
  return value * MB;
}

/**
 * Proxies para as chamadas ao TikTok. Por padrão o endereço da proxy precisa ser PÚBLICO (anti-SSRF: o servidor não conecta
 * em redes internas). PROXY_ALLOW_PRIVATE_HOSTS=true libera redes internas só para DESENVOLVIMENTO (ex.: proxy local).
 */
function loadProxyConfig({ isProduction }) {
  const allowPrivateHosts = (process.env.PROXY_ALLOW_PRIVATE_HOSTS ?? '').trim().toLowerCase() === 'true';
  if (allowPrivateHosts && isProduction) throw new Error('PROXY_ALLOW_PRIVATE_HOSTS não é permitido em produção (abriria o servidor a conexões para redes internas).');
  return { allowPrivateHosts };
}

/** Inteiro de uma variável de ambiente, com padrão e limites. */
function integer(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} inválido (inteiro de ${min} a ${max}).`);
  return value;
}

/** Binário do FFmpeg usado na limpeza dos criativos: o do pacote `ffmpeg-static` ou o informado em FFMPEG_PATH. */
function resolveFfmpegPath() {
  const custom = (process.env.FFMPEG_PATH ?? '').trim();
  if (!custom) return ffmpegStatic ?? null;
  if (!path.isAbsolute(custom) || !fs.existsSync(custom)) throw new Error('FFMPEG_PATH inválido (use o caminho absoluto de um arquivo existente).');
  return custom;
}

/** Biblioteca de criativos: onde os arquivos ficam, os limites de envio e a limpeza feita a cada publicação. */
function loadCreativesConfig() {
  return {
    cleaning: {
      ffmpegPath: resolveFfmpegPath(),
      concurrency: integer('CREATIVES_CLEAN_CONCURRENCY', 1, 1, 4), // limpezas ao mesmo tempo (CPU compartilhada)
      timeoutMs: integer('CREATIVES_CLEAN_TIMEOUT_MIN', 20, 1, 120) * 60_000,
      threads: integer('CREATIVES_CLEAN_THREADS', 2, 1, 8), // threads do codificador (limita CPU e memória)
    },
    dir: path.resolve(process.env.CREATIVES_DIR ?? path.join(process.cwd(), 'data', 'creatives')),
    maxImageBytes: megabytes('CREATIVES_MAX_IMAGE_MB', 10, 50),
    maxVideoBytes: megabytes('CREATIVES_MAX_VIDEO_MB', 200, 1024),
    quotaBytes: megabytes('CREATIVES_USER_QUOTA_MB', 2048, 102_400),
  };
}

/**
 * Banco de dados.
 *  - DATABASE_URL (Supabase/Postgres): produção e desenvolvimento "de verdade". É um SEGREDO (contém a senha).
 *  - Sem DATABASE_URL: só em desenvolvimento/testes, usa PGlite (Postgres embutido) em `data/pglite`.
 */
function loadDatabaseConfig({ isProduction }) {
  const url = (process.env.DATABASE_URL ?? '').trim() || null;
  if (url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      // Não ecoa a URL na mensagem (ela contém a senha).
      throw new Error('DATABASE_URL inválida: use o formato postgresql://usuario:senha@host:porta/banco');
    }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL deve começar com postgresql://');
    if (isProduction && parsed.searchParams.get('sslmode') === 'disable') throw new Error('Em produção, a conexão com o banco precisa usar SSL (remova sslmode=disable).');
  } else if (isProduction) {
    throw new Error('Em produção, defina DATABASE_URL (connection string do Supabase).');
  }
  const schema = (process.env.DATABASE_SCHEMA ?? '').trim() || null;
  if (schema && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('DATABASE_SCHEMA inválido (use letras minúsculas, números e _).');
  const poolMax = Number(process.env.DATABASE_POOL_MAX ?? 10);
  if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 100) throw new Error('DATABASE_POOL_MAX inválido (1 a 100).');
  return {
    url,
    sslCaPath: (process.env.DATABASE_SSL_CA_PATH ?? '').trim() ? path.resolve((process.env.DATABASE_SSL_CA_PATH ?? '').trim()) : null,
    schema,
    poolMax,
    devDataDir: url ? null : (process.env.DATABASE_PATH ?? path.join(process.cwd(), 'data', 'pglite')),
    requireRls: isProduction,
  };
}

export function loadConfig(overrides = {}) {
  const env = process.env.NODE_ENV ?? 'development';
  const isProduction = env === 'production';
  const port = parsePort(process.env.PORT);
  const config = {
    env,
    isProduction,
    isTest: env === 'test',
    port,
    host: process.env.HOST ?? '127.0.0.1',
    trustProxy: loadTrustProxy(),
    database: loadDatabaseConfig({ isProduction }),
    adminEmail: (process.env.ADMIN_EMAIL ?? 'contato.guilhermecostas@gmail.com').trim().toLowerCase(),
    adminPassword: process.env.ADMIN_PASSWORD ?? '',
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    cookieName: 'tt_sid',
    tiktok: loadTiktokConfig({ port, isProduction }),
    mail: loadMailConfig({ port, isProduction }),
    proxy: loadProxyConfig({ isProduction }),
    creatives: loadCreativesConfig(),
    ...overrides,
  };
  // Em produção, cookies só trafegam por HTTPS.
  config.cookieSecure = overrides.cookieSecure ?? isProduction;
  return config;
}
