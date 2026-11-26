import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { IMPERSONATION_TTL_MS } from '../src/modules/admin/impersonation.service.js';
import { ADMIN_EMAIL, all, createUser, loginAdmin, one, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, adminImpersonate: 1000 };

describe('Admin: acessar a conta de um usuário (somente leitura) e bloquear', () => {
  let ctx;
  let admin;
  before(async () => {
    ctx = await startTestServer({ limits: LIMITS });
    admin = await loginAdmin(ctx);
  });
  after(() => ctx.stop());

  const adminId = async () => (await one(ctx.db, 'SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL])).id;
  const auditActions = async () => (await all(ctx.db, 'SELECT action FROM admin_audit_log ORDER BY id')).map((r) => r.action);
  /** Um cliente admin novo (cada teste que entra na conta de alguém usa o seu, porque a sessão do navegador é trocada). */
  const freshAdmin = () => loginAdmin(ctx);
  const enter = async (client, id) => {
    const res = await client.post(`/api/admin/users/${id}/impersonate`);
    if (res.status === 200) client.csrf = res.json.csrfToken;
    return res;
  };

  describe('quem pode e em quem', () => {
    it('usuário comum e visitante NÃO conseguem (403/401) e nada é registrado', async () => {
      const { client } = await createUser(ctx, { approve: true });
      const { id } = await createUser(ctx, { approve: true });
      assert.equal((await client.post(`/api/admin/users/${id}/impersonate`)).status, 403);
      assert.equal((await ctx.client().post(`/api/admin/users/${id}/impersonate`)).status, 401);
      assert.equal((await auditActions()).filter((a) => a === 'impersonation_start').length, 0);
    });

    it('só contas comuns e APROVADAS: pendente, rejeitada e bloqueada são recusadas; outro admin e a própria conta também', async () => {
      const pending = await createUser(ctx);
      const rejected = await createUser(ctx);
      const blocked = await createUser(ctx, { approve: true });
      await run(ctx.db, "UPDATE users SET status = 'rejected' WHERE id = $1", [rejected.id]);
      await run(ctx.db, "UPDATE users SET status = 'blocked' WHERE id = $1", [blocked.id]);
      const a = await freshAdmin();
      for (const { id } of [pending, rejected, blocked]) {
        const res = await a.post(`/api/admin/users/${id}/impersonate`);
        assert.equal(res.status, 400, `id ${id}`);
        assert.match(res.json.error.message, /contas aprovadas/);
      }
      assert.equal((await a.post(`/api/admin/users/${await adminId()}/impersonate`)).status, 400);
      const other = await createUser(ctx, { approve: true });
      await run(ctx.db, "UPDATE users SET role = 'admin' WHERE id = $1", [other.id]);
      assert.equal((await a.post(`/api/admin/users/${other.id}/impersonate`)).status, 403);
      assert.equal((await a.post('/api/admin/users/999999/impersonate')).status, 404);
      assert.equal((await a.post('/api/admin/users/abc/impersonate')).status, 400);
      assert.equal((await a.get('/api/auth/me')).json.user.email, ADMIN_EMAIL, 'as recusas não trocam a sessão do admin');
    });

    it('exige o token CSRF', async () => {
      const { id } = await createUser(ctx, { approve: true });
      const a = await freshAdmin();
      assert.equal((await a.post(`/api/admin/users/${id}/impersonate`, undefined, { withCsrf: false })).status, 403);
      assert.equal((await a.get('/api/auth/me')).json.user.email, ADMIN_EMAIL);
    });

    it('tem limite por hora (o admin não consegue varrer contas em massa)', async () => {
      const limited = await startTestServer({ limits: { ...LIMITS, adminImpersonate: 2 }, isolated: true });
      try {
        const a = await loginAdmin(limited);
        const ids = [];
        for (let i = 0; i < 3; i += 1) ids.push((await createUser(limited, { approve: true })).id);
        // cada entrada troca a sessão: volta ao admin para tentar a próxima
        for (const [i, id] of ids.entries()) {
          const res = await enter(a, id);
          assert.equal(res.status, i < 2 ? 200 : 429, `tentativa ${i + 1}`);
          if (res.status === 200) a.csrf = (await a.post('/api/auth/impersonation/exit')).json.csrfToken;
        }
      } finally {
        await limited.stop();
      }
    });
  });

  describe('entrar na conta', () => {
    it('troca a sessão pela da pessoa, marca como acesso do admin e mostra os dados DELA', async () => {
      const { id, email } = await createUser(ctx, { approve: true, name: 'Cliente Silva' });
      const a = await freshAdmin();
      const res = await enter(a, id);
      assert.equal(res.status, 200);
      assert.equal(res.json.user.email, email);
      assert.equal(res.json.user.role, 'user');
      assert.deepEqual(res.json.impersonation, { adminName: 'Administrador' });
      assert.ok(res.json.csrfToken);
      const cookie = res.setCookies.join(';');
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Strict/i);

      const me = await a.get('/api/auth/me');
      assert.equal(me.json.user.email, email);
      assert.deepEqual(me.json.impersonation, { adminName: 'Administrador' });
      assert.equal((await a.get('/api/campaigns')).status, 200, 'navega nas áreas da pessoa');
    });

    it('a sessão tem prazo de 1 hora e guarda quem é o admin; a sessão antiga do admin deixa de valer', async () => {
      const { id } = await createUser(ctx, { approve: true });
      const a = await freshAdmin();
      const oldCookie = a.cookie;
      const startedAt = Date.now();
      assert.equal((await enter(a, id)).status, 200);
      const row = await one(ctx.db, 'SELECT impersonator_id, user_id, expires_at FROM sessions WHERE impersonator_id IS NOT NULL AND user_id = $1', [id]);
      assert.equal(row.impersonator_id, await adminId());
      const ttl = new Date(row.expires_at).getTime() - startedAt;
      assert.ok(ttl > IMPERSONATION_TTL_MS - 5000 && ttl <= IMPERSONATION_TTL_MS + 5000, `prazo ${ttl} ms`);
      const stale = ctx.client();
      const probe = await stale.request('GET', '/api/auth/me', { headers: { cookie: oldCookie } });
      assert.equal(probe.json.user, null, 'o token antigo do admin foi encerrado');
    });

    it('registra no histórico quem entrou e em qual conta', async () => {
      const { id } = await createUser(ctx, { approve: true, name: 'Conta Auditada' });
      const a = await freshAdmin();
      await enter(a, id);
      const log = await one(ctx.db, "SELECT admin_id, target_id, detail FROM admin_audit_log WHERE action = 'impersonation_start' AND target_id = $1", [id]);
      assert.equal(log.admin_id, await adminId());
      assert.match(log.detail, /Conta Auditada/);
    });
  });

  describe('dentro da conta: somente leitura', () => {
    let client;
    let targetId;
    before(async () => {
      ({ id: targetId } = await createUser(ctx, { approve: true }));
      client = await freshAdmin();
      assert.equal((await enter(client, targetId)).status, 200);
    });

    it('consulta normalmente (GET)', async () => {
      for (const path of ['/api/campaigns', '/api/campaigns/summary', '/api/tiktok/business-centers', '/api/tiktok/balance', '/api/creatives', '/api/proxies']) {
        const res = await client.get(path);
        assert.ok(res.status < 400, `${path}: ${res.status} ${res.text}`);
      }
    });

    it('qualquer alteração é barrada com a mensagem certa e NADA muda no banco', async () => {
      const attempts = [
        ['post', '/api/campaigns', { name: 'Não deveria existir', objective: 'TRAFFIC', dailyBudget: 100 }],
        ['patch', '/api/profile', { name: 'Nome trocado' }],
        ['post', '/api/tiktok/balance/transfer', { connectionId: 1, bcId: '1', advertiserId: '1', type: 'RECHARGE', amount: 10, operationId: 'a'.repeat(32), password: 'x' }],
        ['post', '/api/tiktok/manager/ads/status', { advertiserId: '1', adIds: ['1'], status: 'DISABLE' }],
        ['post', '/api/team/invitations', { email: 'novo@example.com', areas: ['reports'] }],
        ['delete', '/api/profile/avatar'],
        ['post', '/api/tiktok/hourly/refresh', {}],
      ];
      for (const [method, path, body] of attempts) {
        const res = await client[method](path, body);
        assert.equal(res.status, 403, `${method} ${path}`);
        assert.equal(res.json.error.code, 'impersonation_read_only', `${method} ${path}`);
      }
      assert.equal((await one(ctx.db, "SELECT COUNT(*)::int c FROM campaigns WHERE name = 'Não deveria existir'")).c, 0);
      assert.notEqual((await one(ctx.db, 'SELECT name FROM users WHERE id = $1', [targetId])).name, 'Nome trocado');
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM balance_transfers')).c, 0);
    });

    it('arquivos com logins (conteúdo sensível) não abrem nem para leitura', async () => {
      const res = await client.get('/api/files');
      assert.equal(res.status, 403);
      assert.equal(res.json.error.code, 'impersonation_blocked');
      assert.equal((await client.get('/api/files/1/download')).status, 403);
    });

    it('não vira admin: as rotas de administração continuam negadas', async () => {
      assert.equal((await client.get('/api/admin/users')).status, 403);
      assert.equal((await client.post(`/api/admin/users/${targetId}/impersonate`)).status, 403);
      assert.equal((await client.patch(`/api/admin/users/${targetId}/status`, { status: 'blocked' })).status, 403);
    });
  });

  describe('sair e encerramentos', () => {
    it('"Voltar ao admin": sessão nova do admin, CSRF novo, a da pessoa acaba e fica registrado', async () => {
      const { id } = await createUser(ctx, { approve: true });
      const a = await freshAdmin();
      await enter(a, id);
      const personCookie = a.cookie;
      const res = await a.post('/api/auth/impersonation/exit');
      assert.equal(res.status, 200);
      assert.equal(res.json.user.email, ADMIN_EMAIL);
      assert.equal(res.json.user.role, 'admin');
      assert.equal(res.json.impersonation, null);
      a.csrf = res.json.csrfToken;
      assert.equal((await a.get('/api/admin/users')).status, 200, 'voltou a ser admin completo');
      assert.equal((await a.post('/api/campaigns', { name: 'Do admin', objective: 'TRAFFIC', dailyBudget: 100 })).status, 201, 'e voltou a poder alterar');
      const stale = await ctx.client().request('GET', '/api/auth/me', { headers: { cookie: personCookie } });
      assert.equal(stale.json.user, null, 'o token da conta da pessoa não vale mais');
      assert.ok((await auditActions()).includes('impersonation_end'));
    });

    it('sair sem estar na conta de ninguém dá 400', async () => {
      const a = await freshAdmin();
      assert.equal((await a.post('/api/auth/impersonation/exit')).status, 400);
      const { client } = await createUser(ctx, { approve: true });
      assert.equal((await client.post('/api/auth/impersonation/exit')).status, 400);
    });

    it('bloquear a pessoa enquanto o admin está na conta encerra o acesso na hora', async () => {
      const { id } = await createUser(ctx, { approve: true });
      const watcher = await freshAdmin();
      await enter(watcher, id);
      const boss = await freshAdmin();
      assert.equal((await boss.patch(`/api/admin/users/${id}/status`, { status: 'blocked' })).status, 200);
      assert.equal((await watcher.get('/api/auth/me')).json.user, null);
    });

    it('se o admin deixar de ser admin, o acesso à conta da pessoa cai (e a saída pede login)', async () => {
      const { id } = await createUser(ctx, { approve: true });
      const other = await createUser(ctx, { approve: true });
      await run(ctx.db, "UPDATE users SET role = 'admin' WHERE id = $1", [other.id]);
      const temp = ctx.client();
      assert.equal((await temp.login(other.email, 'SenhaUsuario-Forte-1')).status, 200);
      assert.equal((await enter(temp, id)).status, 200);
      await run(ctx.db, "UPDATE users SET role = 'user' WHERE id = $1", [other.id]);
      assert.equal((await temp.get('/api/auth/me')).json.user, null);
    });

    it('sair da conta (logout) durante o acesso encerra tudo, registra e NÃO reabre o admin', async () => {
      const { id } = await createUser(ctx, { approve: true });
      const a = await freshAdmin();
      await enter(a, id);
      const endsBefore = (await auditActions()).filter((x) => x === 'impersonation_end').length;
      assert.equal((await a.post('/api/auth/logout')).status, 204);
      assert.equal((await a.get('/api/auth/me')).json.user, null);
      assert.equal((await auditActions()).filter((x) => x === 'impersonation_end').length, endsBefore + 1);
    });

    it('se o admin foi removido do admin antes de sair, a saída leva ao login', async () => {
      const { id } = await createUser(ctx, { approve: true });
      const other = await createUser(ctx, { approve: true });
      await run(ctx.db, "UPDATE users SET role = 'admin' WHERE id = $1", [other.id]);
      const temp = ctx.client();
      await temp.login(other.email, 'SenhaUsuario-Forte-1');
      await enter(temp, id);
      // a sessão já cai quando o admin perde o cargo: a saída deve responder sem sessão, nunca reabrir poderes
      await run(ctx.db, "UPDATE users SET role = 'user' WHERE id = $1", [other.id]);
      const res = await temp.post('/api/auth/impersonation/exit');
      assert.equal(res.status, 401);
    });
  });

  describe('bloquear e histórico', () => {
    it('bloquear derruba as sessões e fica no histórico; reativar também fica', async () => {
      const { client, id, email } = await createUser(ctx, { approve: true, name: 'Bloqueável' });
      assert.equal((await client.get('/api/campaigns')).status, 200);
      assert.equal((await admin.patch(`/api/admin/users/${id}/status`, { status: 'blocked' })).status, 200);
      assert.equal((await client.get('/api/auth/me')).json.user, null);
      const again = ctx.client();
      await again.login(email, 'SenhaUsuario-Forte-1');
      assert.equal((await again.get('/api/campaigns')).json.error.code, 'account_blocked');
      assert.equal((await admin.patch(`/api/admin/users/${id}/status`, { status: 'approved' })).status, 200);
      assert.equal((await again.get('/api/campaigns')).status, 200);
      const log = await all(ctx.db, "SELECT detail FROM admin_audit_log WHERE action = 'status_change' AND target_id = $1 ORDER BY id", [id]);
      assert.deepEqual(log.map((r) => r.detail), ['Bloqueável: approved → blocked', 'Bloqueável: blocked → approved']);
    });

    it('GET /api/admin/audit lista as ações mais recentes primeiro, só para admin', async () => {
      const a = await freshAdmin();
      const res = await a.get('/api/admin/audit');
      assert.equal(res.status, 200);
      assert.ok(res.json.entries.length > 0);
      assert.ok(res.json.entries.every((e) => ['impersonation_start', 'impersonation_end', 'status_change', 'notification_send', 'notification_change'].includes(e.action) && e.createdAt && !('ip' in e)));
      const ids = res.json.entries.map((e) => e.id);
      assert.deepEqual(ids, [...ids].sort((x, y) => y - x));
      const { client } = await createUser(ctx, { approve: true });
      assert.equal((await client.get('/api/admin/audit')).status, 403);
    });

    it('o registro de auditoria só aceita ações conhecidas (banco e código)', async () => {
      await assert.rejects(() => run(ctx.db, "INSERT INTO admin_audit_log (action) VALUES ('apagar_tudo')"));
      const { createAuditRepository } = await import('../src/modules/admin/audit.repository.js');
      await assert.rejects(() => createAuditRepository(ctx.db).record({ adminId: 1, action: 'x' }), /desconhecida/);
    });
  });
});
