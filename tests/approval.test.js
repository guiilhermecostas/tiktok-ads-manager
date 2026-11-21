import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_EMAIL, createUser, loginAdmin, one, run, startTestServer } from './helpers.js';

describe('Fluxo de aprovação de contas', () => {
  let ctx;
  let admin;
  before(async () => {
    ctx = await startTestServer({ limits: { register: 1000, loginIp: 1000, loginAccount: 1000 } });
    admin = await loginAdmin(ctx);
  });
  after(() => ctx.stop());

  const PROTECTED_GETS = ['/api/campaigns', '/api/campaigns/summary', '/api/campaigns/1', '/api/admin/users', '/api/admin/stats'];

  it('conta PENDENTE loga, vê o próprio status, mas NÃO acessa nenhuma área do sistema', async () => {
    const { client } = await createUser(ctx);
    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.user.status, 'pending');
    for (const path of PROTECTED_GETS) {
      const res = await client.get(path);
      assert.equal(res.status, 403, path);
      assert.equal(res.json.error.code, 'account_pending', path);
    }
    const create = await client.post('/api/campaigns', { name: 'Tentativa', objective: 'TRAFFIC', dailyBudget: 100 });
    assert.equal(create.status, 403);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*) c FROM campaigns')).c, 0);
  });

  it('visitante sem login recebe 401 em todas as rotas protegidas', async () => {
    const anon = ctx.client();
    for (const path of PROTECTED_GETS) assert.equal((await anon.get(path)).status, 401, path);
  });

  it('pendente não consegue se auto-aprovar nem escalar privilégios', async () => {
    const { client, id } = await createUser(ctx);
    assert.equal((await client.patch(`/api/admin/users/${id}/status`, { status: 'approved' })).status, 403);
    assert.equal((await one(ctx.db, 'SELECT status FROM users WHERE id = $1', [id])).status, 'pending');
  });

  it('usuário aprovado comum NÃO acessa rotas de admin', async () => {
    const { client, id } = await createUser(ctx, { approve: true });
    assert.equal((await client.get('/api/admin/users')).status, 403);
    assert.equal((await client.patch(`/api/admin/users/${id}/status`, { status: 'blocked' })).status, 403);
    assert.equal((await client.get('/api/campaigns')).status, 200);
  });

  it('admin lista pendentes e aprova: acesso é liberado SEM novo login', async () => {
    const { client, id, email } = await createUser(ctx);
    const pending = await admin.get('/api/admin/users?status=pending');
    assert.equal(pending.status, 200);
    assert.ok(pending.json.users.some((u) => u.email === email));
    assert.ok(pending.json.users.every((u) => u.status === 'pending' && !('password_hash' in u)));

    assert.equal((await client.get('/api/campaigns')).status, 403);
    const res = await admin.patch(`/api/admin/users/${id}/status`, { status: 'approved' });
    assert.equal(res.status, 200);
    assert.equal(res.json.user.status, 'approved');
    assert.equal((await client.get('/api/campaigns')).status, 200);

    const row = (await one(ctx.db, 'SELECT reviewed_by, reviewed_at FROM users WHERE id = $1', [id]));
    assert.ok(row.reviewed_at);
    assert.equal(row.reviewed_by, (await one(ctx.db, 'SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL])).id);
  });

  it('rejeitar derruba a sessão e impede novo acesso', async () => {
    const { client, id, email } = await createUser(ctx);
    assert.equal((await admin.patch(`/api/admin/users/${id}/status`, { status: 'rejected' })).status, 200);
    assert.equal((await client.get('/api/auth/me')).json.user, null);
    const relogin = await ctx.client().login(email, 'SenhaUsuario-Forte-1');
    assert.equal(relogin.status, 200);
    const again = ctx.client();
    await again.login(email, 'SenhaUsuario-Forte-1');
    assert.equal((await again.get('/api/campaigns')).json.error.code, 'account_rejected');
  });

  it('bloquear derruba a sessão imediatamente; reativar devolve o acesso', async () => {
    const { client, id, email } = await createUser(ctx, { approve: true });
    assert.equal((await client.get('/api/campaigns')).status, 200);
    assert.equal((await admin.patch(`/api/admin/users/${id}/status`, { status: 'blocked' })).status, 200);
    assert.equal((await client.get('/api/campaigns')).status, 401);

    const blocked = ctx.client();
    await blocked.login(email, 'SenhaUsuario-Forte-1');
    assert.equal((await blocked.get('/api/campaigns')).json.error.code, 'account_blocked');

    await admin.patch(`/api/admin/users/${id}/status`, { status: 'approved' });
    assert.equal((await blocked.get('/api/campaigns')).status, 200);
  });

  it('status alterado direto no banco vale na próxima requisição (sem cache de sessão)', async () => {
    const { client, id } = await createUser(ctx, { approve: true });
    (await run(ctx.db, "UPDATE users SET status = 'blocked' WHERE id = $1", [id]));
    assert.equal((await client.get('/api/campaigns')).status, 403);
  });

  it('admin não pode alterar contas de admin nem a si mesmo', async () => {
    const adminId = (await one(ctx.db, 'SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL])).id;
    const res = await admin.patch(`/api/admin/users/${adminId}/status`, { status: 'blocked' });
    assert.equal(res.status, 403);
    assert.equal((await one(ctx.db, 'SELECT status FROM users WHERE id = $1', [adminId])).status, 'approved');
  });

  it('valida parâmetros do admin', async () => {
    const { id } = await createUser(ctx);
    assert.equal((await admin.patch(`/api/admin/users/${id}/status`, { status: 'superuser' })).status, 400);
    assert.equal((await admin.patch(`/api/admin/users/${id}/status`, {})).status, 400);
    assert.equal((await admin.patch('/api/admin/users/abc/status', { status: 'approved' })).status, 400);
    assert.equal((await admin.patch('/api/admin/users/-1/status', { status: 'approved' })).status, 400);
    assert.equal((await admin.patch('/api/admin/users/999999/status', { status: 'approved' })).status, 404);
    assert.equal((await admin.get('/api/admin/users?status=hack')).status, 400);
    assert.equal((await admin.get('/api/admin/users?status=pending&status=approved')).status, 400);
    assert.equal((await admin.get("/api/admin/users?status=pending'%20OR%201=1")).status, 400);
  });

  it('estatísticas refletem as contagens por status', async () => {
    const res = await admin.get('/api/admin/stats');
    assert.equal(res.status, 200);
    const total = Object.values(res.json.counts).reduce((a, b) => a + b, 0);
    assert.equal(total, (await one(ctx.db, 'SELECT COUNT(*) c FROM users')).c);
  });
});
