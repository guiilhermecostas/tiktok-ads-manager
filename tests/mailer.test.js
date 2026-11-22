import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { loadConfig, loadMailConfig } from '../src/config.js';
import { createMailer } from '../src/modules/mail/mailer.js';
import { escapeHtml, inviteEmail } from '../src/modules/mail/templates.js';
import { MAIL_CONFIG } from './fake-mailer.js';

const KEY = MAIL_CONFIG.apiKey;
const config = { mail: MAIL_CONFIG };
const silent = () => { const lines = []; return { lines, error: (...a) => lines.push(a.join(' ')), info: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')) }; };
const okFetch = (calls, { status = 200, body = { id: 'abc-123' } } = {}) => async (url, init) => {
  calls.push({ url, init });
  return { ok: status < 400, status, json: async () => body };
};
const message = { to: 'maria@example.com', subject: 'Olá', html: '<p>oi</p>', text: 'oi', idempotencyKey: 'k-1' };

describe('Resend: envio de e-mail', () => {
  it('chama a API do Resend com chave Bearer, remetente do domínio e destinatário em lista', async () => {
    const calls = [];
    const mailer = createMailer({ config, fetchFn: okFetch(calls), log: silent() });
    const result = await mailer.send(message);
    assert.deepEqual(result, { id: 'abc-123' });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers['Idempotency-Key'], 'k-1');
    assert.equal(init.redirect, 'error', 'nunca segue redirecionamento (a chave não vai para outro endereço)');
    assert.ok(init.signal instanceof AbortSignal, 'tem limite de tempo');
    assert.deepEqual(JSON.parse(init.body), { from: 'TikTok Ads Manager <convites@payfac.dev>', to: ['maria@example.com'], subject: 'Olá', html: '<p>oi</p>', text: 'oi' });
    assert.ok(!init.body.includes(KEY), 'a chave só vai no cabeçalho');
  });

  it('desligado (sem chave/URL): erro 503 claro e nenhuma chamada', async () => {
    const calls = [];
    const mailer = createMailer({ config: { mail: { ...MAIL_CONFIG, enabled: false } }, fetchFn: okFetch(calls), log: silent() });
    assert.equal(mailer.enabled, false);
    await assert.rejects(() => mailer.send(message), (e) => e.status === 503 && e.code === 'email_not_configured');
    assert.equal(calls.length, 0);
  });

  it('recusa destinatário e assunto com quebra de linha (injeção de cabeçalhos) sem chamar a API', async () => {
    const calls = [];
    const mailer = createMailer({ config, fetchFn: okFetch(calls), log: silent() });
    for (const to of ['a@example.com\r\nBcc: x@y.com', 'a@example.com, b@example.com', '<a@example.com>', 'sem-arroba', '', 'a b@example.com', null]) {
      await assert.rejects(() => mailer.send({ ...message, to }), /Destinatário/, JSON.stringify(to));
    }
    for (const subject of ['Oi\r\nBcc: x@y.com', 'Oi\nOutro', '', 'x'.repeat(201), null]) {
      await assert.rejects(() => mailer.send({ ...message, subject }), /Assunto/, JSON.stringify(subject)?.slice(0, 30));
    }
    assert.equal(calls.length, 0);
  });

  it('falha de rede e erros do Resend viram 502 genérico, sem vazar chave nem destinatário (nem no log)', async () => {
    const log = silent();
    const netDown = createMailer({ config, fetchFn: async () => { throw Object.assign(new Error(`getaddrinfo ${KEY} maria@example.com`), { name: 'TypeError' }); }, log });
    await assert.rejects(() => netDown.send(message), (e) => e.status === 502 && e.code === 'email_failed' && !e.message.includes(KEY) && !e.message.includes('maria'));

    for (const [status, body] of [[401, { name: 'restricted_api_key', message: `chave ${KEY}` }], [403, { name: 'validation_error', message: 'domain not verified maria@example.com' }], [429, { name: 'rate_limit_exceeded' }], [500, null]]) {
      const mailer = createMailer({ config, fetchFn: okFetch([], { status, body }), log });
      await assert.rejects(() => mailer.send(message), (e) => e.status === 502 && e.code === 'email_failed' && !e.message.includes('domain') && !e.message.includes(KEY), String(status));
    }
    const logged = log.lines.join('\n');
    assert.ok(!logged.includes(KEY), 'a chave nunca aparece no log');
    assert.ok(!logged.includes('maria@example.com'), 'o destinatário nunca aparece no log');
    assert.match(logged, /HTTP 401/);
  });

  it('resposta lenta é cortada pelo limite de tempo', async () => {
    const slow = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
    const mailer = createMailer({ config, fetchFn: slow, log: silent(), timeoutMs: 40 });
    const started = Date.now();
    await assert.rejects(() => mailer.send(message), (e) => e.status === 502);
    assert.ok(Date.now() - started < 2000);
  });

  it('resposta sem JSON válido não derruba o envio bem-sucedido', async () => {
    const mailer = createMailer({ config, fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } }), log: silent() });
    assert.deepEqual(await mailer.send(message), { id: null });
  });
});

describe('E-mail de convite: conteúdo', () => {
  const base = { ownerName: 'Lucas', inviteeName: 'Maria', areas: ['campaigns', 'creatives'], link: 'https://app.example.com/invite#abc', expiresInDays: 7 };

  it('traz o dono, o link, as áreas em português e a validade, em HTML e texto', () => {
    const { subject, html, text } = inviteEmail(base);
    assert.match(subject, /Lucas convidou você/);
    for (const part of [html, text]) {
      assert.ok(part.includes('Lucas') && part.includes('Maria') && part.includes('https://app.example.com/invite#abc'));
      assert.ok(part.includes('Criativos') && part.includes('Campanhas'), 'áreas por nome');
      assert.ok(part.includes('7 dias'));
    }
  });

  it('nomes vindos de usuários nunca viram HTML (XSS) nem quebram o assunto', () => {
    const evil = '<img src=x onerror=alert(1)> "aspas" & \'apóstrofo\'';
    const { subject, html } = inviteEmail({ ...base, ownerName: `${evil}\r\nBcc: x@y.com`, inviteeName: evil });
    assert.ok(!html.includes('<img'), 'tag escapada');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!/[\r\n]/.test(subject), 'assunto numa linha só');
  });

  it('escapeHtml cobre os 5 caracteres perigosos e aceita vazio', () => {
    assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
    assert.equal(escapeHtml(null), '');
  });
});

describe('Configuração do e-mail (variáveis de ambiente)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ['RESEND_API_KEY', 'EMAIL_FROM', 'APP_URL', 'NODE_ENV']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  const load = (env) => {
    for (const key of ['RESEND_API_KEY', 'EMAIL_FROM', 'APP_URL']) delete process.env[key];
    Object.assign(process.env, env);
    return loadConfig({}).mail;
  };

  it('sem chave: desligado; com chave e URL: ligado, remetente padrão no domínio configurado', () => {
    assert.equal(load({ NODE_ENV: 'development' }).enabled, false);
    const mail = load({ NODE_ENV: 'development', RESEND_API_KEY: KEY, APP_URL: 'https://app.example.com/' });
    assert.deepEqual({ enabled: mail.enabled, appUrl: mail.appUrl, from: mail.from }, { enabled: true, appUrl: 'https://app.example.com', from: 'TikTok Ads Manager <convites@payfac.dev>' });
  });

  it('valida a chave, o remetente e o endereço do sistema', () => {
    assert.throws(() => load({ RESEND_API_KEY: 'chave-sem-prefixo-123456' }), /RESEND_API_KEY/);
    for (const from of ['sem-arroba', 'Nome <a@b.com\nBcc: x@y.com>', 'Nome <a@b.com', '<>@x']) assert.throws(() => load({ EMAIL_FROM: from }), /EMAIL_FROM/, from);
    assert.equal(load({ EMAIL_FROM: 'convites@payfac.dev' }).from, 'convites@payfac.dev');
    for (const url of ['ftp://x.com', 'https://user:pw@x.com', 'https://x.com/caminho', 'https://x.com/?a=1', 'https://x.com/#h', 'nao-e-url']) assert.throws(() => load({ APP_URL: url }), /APP_URL/, url);
  });

  it('em produção, APP_URL precisa ser https e nunca é deduzida de cabeçalhos', () => {
    const production = (env) => {
      for (const key of ['RESEND_API_KEY', 'EMAIL_FROM', 'APP_URL']) delete process.env[key];
      Object.assign(process.env, env);
      return loadMailConfig({ port: 3100, isProduction: true });
    };
    assert.throws(() => production({ APP_URL: 'http://x.com' }), /precisa ser https/);
    assert.deepEqual(production({}), { apiKey: '', from: 'TikTok Ads Manager <convites@payfac.dev>', appUrl: '', enabled: false }, 'sem APP_URL em produção o envio fica desligado (nada de adivinhar o endereço)');
    assert.equal(production({ RESEND_API_KEY: KEY, APP_URL: 'https://app.example.com' }).enabled, true);
    assert.equal(load({ NODE_ENV: 'development' }).appUrl, 'http://localhost:3100', 'em desenvolvimento usa o localhost');
  });
});
