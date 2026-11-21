import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const KEYS = ['TRUST_PROXY', 'TIKTOK_APP_ID', 'TIKTOK_APP_SECRET', 'TIKTOK_REDIRECT_URI', 'TOKEN_ENCRYPTION_KEY', 'NODE_ENV', 'PORT', 'DATABASE_URL'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

/** Aplica variáveis de ambiente só durante o teste; `undefined` remove. */
function withEnv(env, fn) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  return fn();
}
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const base = { TOKEN_ENCRYPTION_KEY: KEY_B64, TIKTOK_APP_ID: '7123456789012345678', TIKTOK_APP_SECRET: 'segredo-do-app-1234', PORT: '3100' };
const oauth = (env) => withEnv(env, () => loadConfig({ adminPassword: 'x' }).tiktok.oauth);

describe('config: app do TikTok para conexão por link', () => {
  it('sem App ID/Secret a conexão por link fica desligada (token manual segue funcionando)', () => {
    const config = withEnv({ TOKEN_ENCRYPTION_KEY: KEY_B64 }, () => loadConfig({ adminPassword: 'x' }));
    assert.equal(config.tiktok.oauth.enabled, false);
    assert.equal(config.tiktok.configured, true);
  });

  it('com App ID e Secret liga, e a URI de retorno padrão aponta para a porta local', () => {
    const o = oauth(base);
    assert.equal(o.enabled, true);
    assert.equal(o.redirectUri, 'http://localhost:3100/api/tiktok/callback');
  });

  it('sem TOKEN_ENCRYPTION_KEY não liga (não há como guardar o token com segurança)', () => {
    assert.equal(oauth({ ...base, TOKEN_ENCRYPTION_KEY: undefined }).enabled, false);
  });

  it('valida App ID, Secret e a URI de retorno', () => {
    const rejects = (env, pattern) => assert.throws(() => oauth({ ...base, ...env }), pattern);
    rejects({ TIKTOK_APP_ID: 'abc' }, /TIKTOK_APP_ID/);
    rejects({ TIKTOK_APP_ID: '123' }, /TIKTOK_APP_ID/);
    rejects({ TIKTOK_APP_SECRET: 'curto' }, /TIKTOK_APP_SECRET/);
    rejects({ TIKTOK_APP_SECRET: 'tem espaço no segredo' }, /TIKTOK_APP_SECRET/);
    rejects({ TIKTOK_APP_ID: undefined }, /TIKTOK_APP_ID/); // só o secret
    rejects({ TIKTOK_REDIRECT_URI: 'não é url' }, /TIKTOK_REDIRECT_URI/);
    rejects({ TIKTOK_REDIRECT_URI: 'https://x.com/outro/caminho' }, /TIKTOK_REDIRECT_URI/);
    rejects({ TIKTOK_REDIRECT_URI: 'https://x.com/api/tiktok/callback?a=1' }, /TIKTOK_REDIRECT_URI/);
    rejects({ TIKTOK_REDIRECT_URI: 'https://x.com/api/tiktok/callback#frag' }, /TIKTOK_REDIRECT_URI/);
    rejects({ TIKTOK_REDIRECT_URI: 'https://user:pw@x.com/api/tiktok/callback' }, /TIKTOK_REDIRECT_URI/);
    rejects({ TIKTOK_REDIRECT_URI: 'ftp://x.com/api/tiktok/callback' }, /TIKTOK_REDIRECT_URI/);
  });

  it('aceita URI https válida e, em produção, exige https', () => {
    assert.equal(oauth({ ...base, TIKTOK_REDIRECT_URI: 'https://painel.exemplo.com/api/tiktok/callback' }).redirectUri, 'https://painel.exemplo.com/api/tiktok/callback');
    const prod = { ...base, NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db.example.com:5432/postgres' };
    assert.throws(() => withEnv({ ...prod, TIKTOK_REDIRECT_URI: 'http://painel.exemplo.com/api/tiktok/callback' }, () => loadConfig({ adminPassword: 'x' })), /https/);
    assert.equal(withEnv({ ...prod, TIKTOK_REDIRECT_URI: 'https://painel.exemplo.com/api/tiktok/callback' }, () => loadConfig({ adminPassword: 'x' })).tiktok.oauth.enabled, true);
  });

  it('a mensagem de erro não vaza o segredo do app', () => {
    try {
      oauth({ ...base, TIKTOK_APP_ID: 'abc' });
      assert.fail('deveria lançar');
    } catch (err) {
      assert.ok(!err.message.includes(base.TIKTOK_APP_SECRET));
    }
  });
});

describe('config: proxy reverso (TRUST_PROXY)', () => {
  const trust = (value) => withEnv({ TRUST_PROXY: value }, () => loadConfig({ adminPassword: 'x' }).trustProxy);
  it('padrão 0 (não confia em X-Forwarded-For) e aceita de 0 a 5', () => {
    assert.equal(trust(undefined), 0);
    assert.equal(trust(''), 0);
    assert.equal(trust('1'), 1);
    assert.equal(trust('5'), 5);
  });
  it('recusa valores inválidos', () => {
    for (const bad of ['-1', '6', '1.5', 'true', 'abc', '1e1']) assert.throws(() => trust(bad), /TRUST_PROXY/, bad);
  });
});

describe('config: limpeza dos criativos (FFmpeg)', () => {
  const KEYS_CLEAN = ['CREATIVES_CLEAN_CONCURRENCY', 'CREATIVES_CLEAN_TIMEOUT_MIN', 'CREATIVES_CLEAN_THREADS', 'FFMPEG_PATH'];
  const withClean = (env, fn) => {
    const previous = Object.fromEntries(KEYS_CLEAN.map((k) => [k, process.env[k]]));
    for (const k of KEYS_CLEAN) delete process.env[k];
    Object.assign(process.env, env);
    try {
      return fn();
    } finally {
      for (const k of KEYS_CLEAN) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
      }
    }
  };
  const cleaning = (env) => withClean(env, () => loadConfig({ adminPassword: 'x' }).creatives.cleaning);

  it('padrões: binário do pacote ffmpeg-static, 1 limpeza por vez, 20 min e 2 threads', () => {
    const c = cleaning({});
    assert.ok(typeof c.ffmpegPath === 'string' && c.ffmpegPath.length > 0, 'o binário empacotado existe');
    assert.deepEqual([c.concurrency, c.timeoutMs, c.threads], [1, 20 * 60_000, 2]);
  });

  it('valida os limites e o caminho do binário', () => {
    for (const [name, value] of [['CREATIVES_CLEAN_CONCURRENCY', '0'], ['CREATIVES_CLEAN_CONCURRENCY', '9'], ['CREATIVES_CLEAN_TIMEOUT_MIN', '0'], ['CREATIVES_CLEAN_THREADS', 'abc'], ['CREATIVES_CLEAN_THREADS', '1.5']]) {
      assert.throws(() => cleaning({ [name]: value }), new RegExp(name), `${name}=${value}`);
    }
    assert.equal(cleaning({ CREATIVES_CLEAN_CONCURRENCY: '3' }).concurrency, 3);
    assert.throws(() => cleaning({ FFMPEG_PATH: 'ffmpeg' }), /FFMPEG_PATH/, 'caminho relativo');
    assert.throws(() => cleaning({ FFMPEG_PATH: '/nao/existe/ffmpeg' }), /FFMPEG_PATH/, 'arquivo inexistente');
    assert.equal(cleaning({ FFMPEG_PATH: process.execPath }).ffmpegPath, process.execPath, 'caminho absoluto existente é aceito');
  });
});
