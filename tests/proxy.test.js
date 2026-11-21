import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { startTestServer, uniqueEmail } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 2, loginAccount: 1000 };
const attempt = (ctx, forwardedFor) => ctx.client().post('/api/auth/login', { email: uniqueEmail('x'), password: 'qualquer-senha-123' }, { headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} });

describe('IP do cliente atrás de proxy (limite de tentativas de login)', () => {
  const servers = [];
  after(async () => { for (const s of servers) await s.stop(); });
  const start = async (trustProxy) => {
    const ctx = await startTestServer({ limits: LIMITS, config: { trustProxy }, isolated: true });
    servers.push(ctx);
    return ctx;
  };

  it('sem proxy confiável (0), X-Forwarded-For é ignorado: forjar o IP não escapa do limite', async () => {
    const ctx = await start(0);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await attempt(ctx, `203.0.113.${i + 1}`)).status);
    assert.deepEqual(statuses, [401, 401, 429, 429]);
  });

  it('com 1 proxy confiável, cada IP real tem o seu próprio limite (e o mesmo IP continua limitado)', async () => {
    const ctx = await start(1);
    const different = [];
    for (let i = 0; i < 4; i++) different.push((await attempt(ctx, `198.51.100.${i + 1}`)).status);
    assert.deepEqual(different, [401, 401, 401, 401], 'IPs diferentes não se atrapalham');
    const same = [];
    for (let i = 0; i < 4; i++) same.push((await attempt(ctx, '192.0.2.77')).status);
    assert.deepEqual(same, [401, 401, 429, 429], 'o mesmo IP real estoura o limite');
  });
});
