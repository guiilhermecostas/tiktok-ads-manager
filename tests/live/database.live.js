import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { isUniqueViolation, toIso } from '../../src/db/helpers.js';
import { findTablesWithoutRls } from '../../src/db/migrations.js';
import { createSessionsRepository } from '../../src/modules/auth/sessions.repository.js';
import { createCampaignsRepository } from '../../src/modules/campaigns/campaigns.repository.js';
import { createBusinessCentersRepository } from '../../src/modules/tiktok/business-centers.repository.js';
import { createOauthAttemptsRepository } from '../../src/modules/tiktok/oauth-attempts.repository.js';
import { createUsersRepository } from '../../src/modules/users/users.repository.js';

/**
 * Teste contra o banco REAL configurado em DATABASE_URL (Supabase). Fica fora do `npm test`.
 * Roda tudo dentro de UMA transação que é SEMPRE desfeita (ROLLBACK): nenhum dado é gravado.
 *
 *   npm run test:db-live
 */
const enabled = process.env.DATABASE_LIVE === '1';
const ROLLBACK = Symbol('rollback');

/** Executa `fn` com um "db" ligado a uma transação única e a desfaz no final (sucesso ou falha). */
async function withRollback(db, fn) {
  try {
    await db.transaction(async (tx) => {
      // Transações aninhadas dos repositórios reaproveitam a mesma transação externa.
      const txDb = { dialect: db.dialect, query: tx.query, exec: tx.exec, transaction: (inner) => inner(tx), close: async () => {} };
      await fn(txDb, tx);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

/** Erro esperado dentro da transação: SAVEPOINT evita que o Postgres aborte o resto da transação. */
async function expectDbError(tx, sql, params, predicate, message) {
  await tx.query('SAVEPOINT esperado');
  await assert.rejects(() => tx.query(sql, params), predicate, message);
  await tx.query('ROLLBACK TO SAVEPOINT esperado');
}

describe('banco REAL (Supabase): repositórios, tipos e restrições (transação desfeita no final)', { skip: enabled ? false : 'defina DATABASE_LIVE=1 (use npm run test:db-live)' }, () => {
  it('conecta com o papel e o schema do app, com migrações aplicadas e RLS em tudo', async () => {
    const config = loadConfig();
    assert.ok(config.database.url, 'DATABASE_URL precisa estar definida');
    const db = await openDatabase(config.database, { migrate: false });
    try {
      const { rows } = await db.query('SELECT current_user AS u, current_schema() AS s');
      assert.equal(rows[0].s, config.database.schema ?? rows[0].s);
      assert.notEqual(rows[0].u, 'postgres', 'o app não deve usar o superusuário');
      assert.ok((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.length >= 1);
      assert.deepEqual(await findTablesWithoutRls(db), []);
    } finally {
      await db.close();
    }
  });

  it('usuários, sessões, campanhas (jsonb) e Business Centers funcionam de ponta a ponta', async () => {
    const config = loadConfig();
    const db = await openDatabase(config.database, { migrate: false });
    const before = (await db.query('SELECT COUNT(*)::int AS c FROM users')).rows[0].c;
    try {
      await withRollback(db, async (txDb, tx) => {
        const users = createUsersRepository(txDb);
        const sessions = createSessionsRepository(txDb, { ttlMs: 60_000 });
        const campaigns = createCampaignsRepository(txDb);
        const centers = createBusinessCentersRepository(txDb, { encryptionKey: randomBytes(32) });

        // ---- usuários: e-mail sem diferenciar maiúsculas, índice único, tipos ----
        const id = await users.create({ email: 'Live.Teste@Example.com', name: 'Teste Live', passwordHash: 'h', role: 'user', status: 'pending' });
        assert.equal(typeof id, 'number', 'identity int4 volta como number');
        assert.equal((await users.findByEmail('live.teste@example.COM')).id, id);
        await expectDbError(tx, "INSERT INTO users (email, name, password_hash) VALUES ('LIVE.TESTE@EXAMPLE.COM', 'Dup', 'x')", [], (e) => isUniqueViolation(e), 'e-mail duplicado');
        await users.updateStatus(id, 'approved', id);
        const listed = (await users.list('approved')).find((u) => u.id === id);
        assert.equal(listed.status, 'approved');
        assert.match(listed.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/, 'datas voltam em ISO-8601');
        assert.equal((await users.counts()).approved >= 1, true);
        await expectDbError(tx, "INSERT INTO users (email, name, password_hash, status) VALUES ('x@y.co', 'x', 'x', 'superuser')", [], (e) => e.code === '23514', 'CHECK de status');

        // ---- sessões: token só em hash, expiração, exclusão ----
        const created = await sessions.create(id);
        const found = await sessions.resolve(created.token);
        assert.equal(found.user.id, id);
        assert.equal(found.session.csrfToken, created.csrfToken);
        assert.ok(found.session.expiresAt > Date.now());
        assert.equal((await tx.query('SELECT COUNT(*)::int AS c FROM sessions WHERE token_hash = $1', [created.token])).rows[0].c, 0, 'token puro nunca é gravado');
        await tx.query("UPDATE sessions SET expires_at = now() - interval '1 minute'");
        assert.equal(await sessions.resolve(created.token), null, 'sessão vencida é recusada e removida');
        const second = await sessions.create(id);
        await sessions.destroyAllForUser(id);
        assert.equal(await sessions.resolve(second.token), null);

        // ---- campanhas: jsonb, resumo numérico, publicação parcial ----
        const config1 = { campaign: { name: 'Live', objective: 'REACH' }, adGroup: { locations: ['BR'], budget: 5000 }, ad: { text: 'Olá ✓ ação' } };
        const wizard = await campaigns.createWizard(id, { name: 'Live', objective: 'REACH', dailyBudget: 5000, config: config1, advertiserId: '9001' });
        assert.deepEqual(wizard.config, config1, 'jsonb preserva o objeto (inclusive acentos)');
        const simple = await campaigns.create(id, { name: 'Simples', objective: 'TRAFFIC', dailyBudget: 1000, status: 'active' });
        assert.equal(simple.wizard, false);
        const summary = await campaigns.summary(id);
        assert.deepEqual({ total: summary.total, active: summary.active, draft: summary.draft, activeBudget: summary.activeBudget }, { total: 2, active: 1, draft: 1, activeBudget: 1000 });
        assert.equal(typeof summary.activeBudget, 'number');
        const progress = await campaigns.saveProgress(id, wizard.id, { campaignId: '7001', error: 'falhou', status: 'draft' });
        assert.deepEqual([progress.publish.status, progress.publish.campaignId, progress.publish.error], ['partial', '7001', 'falhou']);
        assert.equal((await campaigns.get(999_999_999 % 2_000_000_000, wizard.id)), null, 'isolamento por usuário');
        await expectDbError(tx, "INSERT INTO campaigns (user_id, name, objective, daily_budget) VALUES ($1, 'x', 'TRAFFIC', -1)", [id], (e) => e.code === '23514', 'CHECK de orçamento');

        // ---- Business Centers: token cifrado, lote de contas (unnest), visibilidade, preferência pelo dono ----
        const other = await users.create({ email: 'live.outro@example.com', name: 'Outro', passwordHash: 'h', status: 'approved' });
        const bcId = await centers.create({ ownerId: id, bcId: '111', name: 'BC Live', accessToken: 'token-secreto-live-123456', advertisers: [{ id: '9001', name: 'Conta 1', currency: 'BRL', timezone: 'America/Sao_Paulo' }, { id: '9002', name: 'Conta 2', currency: null, timezone: null }] });
        assert.equal(await centers.getToken(bcId), 'token-secreto-live-123456');
        assert.ok(!(await tx.query('SELECT access_token FROM tiktok_business_centers WHERE id = $1', [bcId])).rows[0].access_token.includes('token-secreto'), 'token cifrado no banco');
        await expectDbError(tx, "INSERT INTO tiktok_business_centers (owner_id, bc_id, name, access_token) VALUES ($1, '111', 'dup', 'v1.x')", [id], (e) => isUniqueViolation(e), 'unicidade (dono, BC)');
        assert.equal((await centers.get(bcId)).advertiserCount, 2);
        assert.deepEqual((await centers.advertisers(id)).map((a) => a.id), ['9001', '9002']);
        assert.deepEqual(await centers.advertisers(other), [], 'BC privada não é visível a outro usuário');
        await centers.setShared(bcId, true);
        assert.equal((await centers.advertisers(other)).length, 2, 'compartilhada: visível a todos');
        assert.equal((await centers.findAdvertiser('9001', other)).timezone, 'America/Sao_Paulo');
        await centers.replaceAdvertisers(bcId, [{ id: '9003', name: 'Nova', currency: 'USD', timezone: null }]);
        assert.deepEqual((await centers.advertisers(id)).map((a) => a.id), ['9003']);
        await centers.markError(bcId, 'token expirou');
        assert.equal(await centers.findAdvertiser('9003', id), null, 'BC com erro não serve contas');

        // ---- cascata ----
        await tx.query('DELETE FROM users WHERE id = $1', [id]);
        for (const table of ['sessions', 'campaigns', 'tiktok_business_centers']) {
          assert.equal((await tx.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${table === 'tiktok_business_centers' ? 'owner_id' : 'user_id'} = $1`, [id])).rows[0].c, 0, table);
        }
        assert.equal(toIso(null), null);
      });
      // Prova de que nada foi gravado.
      assert.equal((await db.query('SELECT COUNT(*)::int AS c FROM users')).rows[0].c, before, 'o ROLLBACK desfez tudo');
      assert.equal((await db.query("SELECT COUNT(*)::int AS c FROM users WHERE email LIKE 'live.%'")).rows[0].c, 0);
    } finally {
      await db.close();
    }
  });

  it('transações concorrentes no pool: nenhuma conexão vaza e o COMMIT/ROLLBACK funcionam', async () => {
    const config = loadConfig();
    const db = await openDatabase(config.database, { migrate: false });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          db.transaction(async (tx) => {
            await tx.query('SELECT pg_sleep(0.05)');
            if (i % 3 === 0) throw new Error(`falha proposital ${i}`);
            return (await tx.query('SELECT $1::int AS n', [i])).rows[0].n;
          }),
        ),
      );
      assert.equal(results.filter((r) => r.status === 'rejected').length, 4);
      assert.deepEqual(results.filter((r) => r.status === 'fulfilled').map((r) => r.value).sort((a, b) => a - b), [1, 2, 4, 5, 7, 8, 10, 11]);
      assert.equal((await db.query('SELECT 1 AS ok')).rows[0].ok, 1, 'o pool continua utilizável');
    } finally {
      await db.close();
    }
  });

  it('tabelas da biblioteca e da conexão por link: RLS, sem privilégios às chaves públicas, restrições e FKs no Supabase', async () => {
    const config = loadConfig();
    const db = await openDatabase(config.database, { migrate: false });
    try {
      const own = ['creatives', 'creative_tiktok_assets', 'tiktok_oauth_attempts'];
      const { rows: versions } = await db.query('SELECT version FROM schema_migrations ORDER BY version');
      assert.ok(versions.length >= 3, 'migrações v2 e v3 aplicadas');
      for (const table of own) {
        const rls = (await db.query('SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass', [table])).rows[0];
        assert.equal(rls.relrowsecurity, true, `${table}: RLS ligado`);
        assert.equal((await db.query('SELECT COUNT(*)::int AS c FROM pg_policies WHERE schemaname = current_schema() AND tablename = $1', [table])).rows[0].c, 0, `${table}: sem políticas`);
        for (const role of ['anon', 'authenticated', 'service_role']) {
          for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            const { rows } = await db.query('SELECT has_table_privilege($1, $2::regclass, $3) AS granted', [role, table, priv]);
            assert.equal(rows[0].granted, false, `${role} não pode ${priv} em ${table}`);
          }
        }
      }
      // Restrições que sustentam a segurança: estado válido, state único e vínculo coerente.
      const defs = (await db.query("SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'tiktok_business_centers'::regclass AND contype = 'c'")).rows;
      assert.ok(defs.some((d) => d.conname === 'tiktok_bc_auth_coherence'), 'coerência auth_type/bc_id');
      assert.equal((await db.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'tiktok_business_centers' AND column_name = 'bc_id'")).rows[0].is_nullable, 'YES');
      const unique = (await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'tiktok_oauth_attempts'::regclass AND contype = 'u'")).rows.map((r) => r.def).join(' | ');
      assert.match(unique, /state_hash/);
      const fks = (await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'tiktok_oauth_attempts'::regclass AND contype = 'f'")).rows.map((r) => r.def).join(' | ');
      assert.match(fks, /user_id\) REFERENCES users\(id\) ON DELETE CASCADE/);
      assert.deepEqual(await findTablesWithoutRls(db), []);
    } finally {
      await db.close();
    }
  });

  it('conexão por link no banco real: gravação, unicidade do state, uso único atômico e cascata (transação desfeita)', async () => {
    const config = loadConfig();
    const db = await openDatabase(config.database, { migrate: false });
    try {
      await withRollback(db, async (txDb, tx) => {
        const users = createUsersRepository(txDb);
        const email = `live.${randomBytes(4).toString('hex')}@example.com`;
        const user = { id: await users.create({ email, name: 'Live', passwordHash: 'x', role: 'user', status: 'approved' }) };
        const attempts = createOauthAttemptsRepository(txDb);
        const first = await attempts.create(user.id, { name: 'Loja', ttlMs: 60_000 });
        assert.equal(await attempts.countPending(user.id), 1);
        assert.equal((await attempts.findForUser(user.id, first.attemptId)).status, 'pending');
        const claimed = await attempts.claim(first.state);
        assert.equal(claimed.attemptId, first.attemptId);
        assert.equal(await attempts.claim(first.state), null, 'uso único: o segundo uso não encontra nada');
        const bcs = createBusinessCentersRepository(txDb, { encryptionKey: randomBytes(32) });
        const id = await bcs.create({ ownerId: user.id, name: 'Por link', accessToken: 'token-de-teste-0123456789', advertisers: [{ id: '9001', name: 'Conta' }], authType: 'oauth' });
        await attempts.finish(first.attemptId, { status: 'connected', connectionId: id });
        assert.equal((await attempts.findForUser(user.id, first.attemptId)).connectionId, id);
        assert.equal(await bcs.findOauthByAdvertisers(user.id, ['9001']), id);
        assert.equal(await bcs.findOauthByAdvertisers(user.id, ['0000']), null);
        const stored = (await tx.query('SELECT access_token FROM tiktok_business_centers WHERE id = $1', [id])).rows[0];
        assert.match(stored.access_token, /^v1\./, 'token criptografado em repouso');
        await expectDbError(tx, "INSERT INTO tiktok_business_centers (owner_id, name, access_token) VALUES ($1, 'sem id', 'v1.x')", [user.id], (e) => e.code === '23514', 'token manual exige bc_id');
        await expectDbError(tx, "INSERT INTO tiktok_oauth_attempts (attempt_id, state_hash, user_id, name, status, expires_at) VALUES ($1, 'h', $2, 'n', 'hackeado', now())", ['f'.repeat(32), user.id], (e) => e.code === '23514', 'status inválido');
        await tx.query('DELETE FROM users WHERE id = $1', [user.id]);
        assert.equal((await tx.query('SELECT COUNT(*)::int AS c FROM tiktok_oauth_attempts WHERE user_id = $1', [user.id])).rows[0].c, 0, 'cascata do usuário');
      });
    } finally {
      await db.close();
    }
  });
});
