import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db/index.js';
import { MIGRATIONS, findTablesWithoutRls, runMigrations } from '../src/db/migrations.js';
import { createPgliteDatabase } from '../src/db/adapters/pglite.js';
import { all, one } from './helpers.js';

const EXPECTED_TABLES = ['admin_audit_log', 'advertiser_status', 'advertiser_status_events', 'balance_transfers', 'billing_locks', 'billing_payments', 'billing_plans', 'billing_rates', 'billing_statements', 'campaign_creative_assets', 'campaign_publications', 'campaigns', 'catalog_defaults', 'catalog_hidden', 'creative_folders', 'creative_hooks', 'creative_tiktok_assets', 'creatives', 'manager_views', 'notification_reads', 'notifications', 'proxies', 'registration_codes', 'sessions', 'spend_ledger', 'tiktok_advertisers', 'tiktok_business_centers', 'tiktok_hourly_spend', 'tiktok_oauth_attempts', 'user_avatars', 'users', 'workspace_files', 'workspace_invites', 'workspace_members'];
const config = { url: null, sslCaPath: null, poolMax: 1, devDataDir: null, requireRls: true };
const silent = { info() {}, warn() {}, error() {} };

async function freshDb() {
  return createPgliteDatabase();
}

describe('migrações (PostgreSQL)', () => {
  it('cria todas as tabelas, registra a versão e é idempotente', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      await runMigrations(db); // segunda vez: não faz nada nem falha
      await runMigrations(db);
      const tables = (await all(db, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).map((t) => t.tablename);
      assert.deepEqual(tables, [...EXPECTED_TABLES, 'schema_migrations'].sort());
      const applied = await all(db, 'SELECT version FROM schema_migrations ORDER BY version');
      assert.deepEqual(applied.map((r) => r.version), MIGRATIONS.map((m) => m.version));
    } finally {
      await db.close();
    }
  });

  it('as versões são sequenciais, únicas e têm descrição', () => {
    assert.deepEqual(MIGRATIONS.map((m) => m.version), MIGRATIONS.map((_, i) => i + 1));
    assert.ok(MIGRATIONS.every((m) => m.description && m.sql.length > 10));
  });

  it('migração que falha desfaz TUDO (nem a tabela de controle registra a versão)', async () => {
    const db = await freshDb();
    try {
      const broken = [{ version: 1, description: 'quebrada', sql: 'CREATE TABLE a (id int); CREATE TABLE b (id int, id int);' }];
      await assert.rejects(() => runMigrations(db, broken), /Falha ao aplicar as migrações/);
      const tables = (await all(db, "SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).map((t) => t.tablename);
      assert.ok(!tables.includes('a'), 'a primeira instrução também foi desfeita');
      assert.ok(!tables.includes('schema_migrations'));
      await runMigrations(db); // e o banco continua utilizável depois da falha
      assert.ok((await findTablesWithoutRls(db)).length === 0);
    } finally {
      await db.close();
    }
  });

  it('migrações novas são aplicadas em ordem sobre um banco já migrado', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      const next = [...MIGRATIONS, { version: MIGRATIONS.length + 1, description: 'teste', sql: 'ALTER TABLE users ADD COLUMN phone TEXT;' }];
      await runMigrations(db, next);
      assert.ok((await all(db, "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'")).some((c) => c.column_name === 'phone'));
      assert.equal((await one(db, 'SELECT MAX(version)::int AS v FROM schema_migrations')).v, MIGRATIONS.length + 1);
    } finally {
      await db.close();
    }
  });
});

describe('restrições do esquema', () => {
  it('e-mail é único sem diferenciar maiúsculas; status/role/objetivos inválidos são recusados pelo banco', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      await db.query("INSERT INTO users (email, name, password_hash) VALUES ('Ana@Example.com', 'Ana', 'x')");
      await assert.rejects(() => db.query("INSERT INTO users (email, name, password_hash) VALUES ('ana@example.COM', 'Outra', 'x')"), (e) => e.code === '23505');
      await assert.rejects(() => db.query("INSERT INTO users (email, name, password_hash, status) VALUES ('b@example.com', 'B', 'x', 'superuser')"), (e) => e.code === '23514');
      await assert.rejects(() => db.query("INSERT INTO users (email, name, password_hash, role) VALUES ('c@example.com', 'C', 'x', 'root')"), (e) => e.code === '23514');
      await assert.rejects(() => db.query("INSERT INTO campaigns (user_id, name, objective, daily_budget) VALUES (1, 'x', 'TRAFFIC', -1)"), (e) => e.code === '23514');
      await assert.rejects(() => db.query("INSERT INTO campaigns (user_id, name, objective, daily_budget) VALUES (999, 'x', 'TRAFFIC', 1)"), (e) => e.code === '23503', 'FK');
    } finally {
      await db.close();
    }
  });

  it('chave estrangeira em cascata: remover usuário apaga sessões, campanhas e Business Centers', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      await db.query("INSERT INTO users (email, name, password_hash) VALUES ('a@example.com', 'A', 'x')");
      await db.query("INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ('h', 1, 'c', now() + interval '1 day')");
      await db.query("INSERT INTO campaigns (user_id, name, objective, daily_budget, config) VALUES (1, 'x', 'TRAFFIC', 1, '{\"a\":1}'::jsonb)");
      await db.query("INSERT INTO tiktok_business_centers (owner_id, bc_id, name, access_token) VALUES (1, '111', 'BC', 'v1.x')");
      await db.query("INSERT INTO tiktok_advertisers (business_center_id, advertiser_id, name) VALUES (1, '9', 'Conta')");
      assert.deepEqual((await one(db, 'SELECT config FROM campaigns')).config, { a: 1 }, 'jsonb volta como objeto');
      await db.query('DELETE FROM users WHERE id = 1');
      for (const table of ['sessions', 'campaigns', 'tiktok_business_centers', 'tiktok_advertisers']) {
        assert.equal((await one(db, `SELECT COUNT(*)::int AS c FROM ${table}`)).c, 0, table);
      }
    } finally {
      await db.close();
    }
  });

  it('unicidade da BC é por (dono, bc_id)', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      await db.query("INSERT INTO users (email, name, password_hash) VALUES ('a@example.com', 'A', 'x'), ('b@example.com', 'B', 'x')");
      await db.query("INSERT INTO tiktok_business_centers (owner_id, bc_id, name, access_token) VALUES (1, '111', 'BC', 'v1.x'), (2, '111', 'BC', 'v1.y')");
      await assert.rejects(() => db.query("INSERT INTO tiktok_business_centers (owner_id, bc_id, name, access_token) VALUES (1, '111', 'Dup', 'v1.z')"), (e) => e.code === '23505');
    } finally {
      await db.close();
    }
  });
});

describe('conexão por link: restrições do esquema (migração v3)', () => {
  it('BC por token exige bc_id, por link não; tentativas com state único, status válido e cascata', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      await db.query("INSERT INTO users (email, name, password_hash) VALUES ('a@example.com', 'A', 'x'), ('b@example.com', 'B', 'x')");
      // padrão continua 'token' (dados existentes não mudam) e exige o bc_id
      await db.query("INSERT INTO tiktok_business_centers (owner_id, bc_id, name, access_token) VALUES (1, '111', 'BC', 'v1.x')");
      assert.equal((await one(db, 'SELECT auth_type FROM tiktok_business_centers')).auth_type, 'token');
      await assert.rejects(() => db.query("INSERT INTO tiktok_business_centers (owner_id, name, access_token) VALUES (1, 'sem id', 'v1.x')"), (e) => e.code === '23514', 'token manual sem bc_id');
      await assert.rejects(() => db.query("INSERT INTO tiktok_business_centers (owner_id, bc_id, name, access_token, auth_type) VALUES (1, '9', 'x', 'v1.x', 'magia')"), (e) => e.code === '23514', 'auth_type inválido');
      // por link: sem bc_id; várias do mesmo dono (bc_id NULL não colide no UNIQUE)
      await db.query("INSERT INTO tiktok_business_centers (owner_id, name, access_token, auth_type) VALUES (1, 'L1', 'v1.a', 'oauth'), (1, 'L2', 'v1.b', 'oauth')");
      assert.equal((await one(db, "SELECT COUNT(*)::int c FROM tiktok_business_centers WHERE auth_type = 'oauth'")).c, 2);

      const attempt = (id, hash, status = 'pending', user = 1) => db.query("INSERT INTO tiktok_oauth_attempts (attempt_id, state_hash, user_id, name, status, expires_at) VALUES ($1, $2, $3, 'n', $4, now() + interval '15 minutes')", [id, hash, user, status]);
      await attempt('a'.repeat(32), 'h1');
      await assert.rejects(() => attempt('b'.repeat(32), 'h1'), (e) => e.code === '23505', 'state único');
      await assert.rejects(() => attempt('a'.repeat(32), 'h2'), (e) => e.code === '23505', 'attempt_id único');
      await assert.rejects(() => attempt('c'.repeat(32), 'h3', 'hackeado'), (e) => e.code === '23514', 'status');
      await assert.rejects(() => attempt('d'.repeat(32), 'h4', 'pending', 999), (e) => e.code === '23503', 'FK do usuário');
      await attempt('e'.repeat(32), 'h5', 'pending', 2);
      // apagar a conexão não apaga a tentativa (só desfaz o vínculo); apagar o usuário apaga tudo dele
      const bc = (await one(db, "SELECT id FROM tiktok_business_centers WHERE name = 'L1'")).id;
      await db.query('UPDATE tiktok_oauth_attempts SET connection_id = $1 WHERE attempt_id = $2', [bc, 'a'.repeat(32)]);
      await db.query('DELETE FROM tiktok_business_centers WHERE id = $1', [bc]);
      assert.equal((await one(db, "SELECT connection_id FROM tiktok_oauth_attempts WHERE attempt_id = $1", ['a'.repeat(32)])).connection_id, null);
      await db.query('DELETE FROM users WHERE id = 1');
      assert.equal((await one(db, 'SELECT COUNT(*)::int c FROM tiktok_oauth_attempts')).c, 1, 'só as do usuário removido');
    } finally {
      await db.close();
    }
  });
});

describe('publicações por conta de anúncio (migração v4)', () => {
  it('preserva a publicação única que já existia: vira uma linha por (campanha, conta); rascunhos não geram linha', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db, MIGRATIONS.slice(0, 3)); // banco como estava antes da v4
      await db.query("INSERT INTO users (email, name, password_hash) VALUES ('a@example.com', 'A', 'x')");
      const campaign = (name, advertiser, ids, error = null) => db.query(
        `INSERT INTO campaigns (user_id, name, objective, daily_budget, config, advertiser_id, tiktok_campaign_id, tiktok_adgroup_id, tiktok_ad_id, publish_error, published_at)
         VALUES (1, $1, 'TRAFFIC', 0, '{}'::jsonb, $2, $3, $4, $5, $6, $7)`,
        [name, advertiser, ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, error, ids[2] ? new Date('2026-11-05T10:00:00Z') : null],
      );
      await campaign('publicada', '9001', ['c1', 'g1', 'a1']);
      await campaign('parcial', '9002', ['c2', 'g2'], 'Identity not found');
      await campaign('falhou', '9003', [], 'Campaign name already exists');
      await campaign('rascunho com conta', '9004', []);
      await campaign('rascunho sem conta', null, []);
      await campaign('conta malformada', 'abc', ['c9']);

      await runMigrations(db); // aplica a v4
      const rows = await all(db, 'SELECT c.name, p.advertiser_id, p.tiktok_campaign_id, p.tiktok_adgroup_id, p.tiktok_ad_id, p.error, p.published_at FROM campaign_publications p JOIN campaigns c ON c.id = p.campaign_id ORDER BY c.id');
      assert.deepEqual(rows.map((r) => [r.name, r.advertiser_id, r.tiktok_campaign_id, r.tiktok_adgroup_id, r.tiktok_ad_id, r.error]), [
        ['publicada', '9001', 'c1', 'g1', 'a1', null],
        ['parcial', '9002', 'c2', 'g2', null, 'Identity not found'],
        ['falhou', '9003', null, null, null, 'Campaign name already exists'],
      ]);
      assert.equal(rows[0].published_at.toISOString(), '2026-11-05T10:00:00.000Z');
      // Nada foi apagado das colunas antigas (permite reverter o deploy).
      assert.equal((await one(db, "SELECT tiktok_ad_id FROM campaigns WHERE name = 'publicada'")).tiktok_ad_id, 'a1');
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM campaigns')).c, 6);
    } finally {
      await db.close();
    }
  });

  it('restrições: uma publicação por (campanha, conta), conta só com dígitos, FK com cascata', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      await db.query("INSERT INTO users (email, name, password_hash) VALUES ('a@example.com', 'A', 'x')");
      await db.query("INSERT INTO campaigns (user_id, name, objective, daily_budget) VALUES (1, 'c', 'TRAFFIC', 0)");
      await db.query("INSERT INTO campaign_publications (campaign_id, advertiser_id, overrides) VALUES (1, '9001', '{\"adGroup\":{\"pixelId\":\"1\"}}'::jsonb), (1, '9002', NULL)");
      assert.deepEqual((await one(db, "SELECT overrides FROM campaign_publications WHERE advertiser_id = '9001'")).overrides, { adGroup: { pixelId: '1' } }, 'jsonb volta como objeto');
      await assert.rejects(() => db.query("INSERT INTO campaign_publications (campaign_id, advertiser_id) VALUES (1, '9001')"), (e) => e.code === '23505');
      for (const bad of ['', 'abc', '12 34', "9001'; --", '9'.repeat(25)]) {
        await assert.rejects(() => db.query('INSERT INTO campaign_publications (campaign_id, advertiser_id) VALUES (1, $1)', [bad]), (e) => e.code === '23514', bad);
      }
      await assert.rejects(() => db.query("INSERT INTO campaign_publications (campaign_id, advertiser_id) VALUES (404, '9003')"), (e) => e.code === '23503');
      await db.query('DELETE FROM campaigns WHERE id = 1');
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM campaign_publications')).c, 0);
    } finally {
      await db.close();
    }
  });
});

describe('versões limpas dos criativos por campanha e conta (migração v5)', () => {
  it('uma versão por (campanha, criativo, conta); conta só com dígitos; cascata ao apagar campanha ou criativo', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      await db.query("INSERT INTO users (email, name, password_hash) VALUES ('a@example.com', 'A', 'x')");
      await db.query("INSERT INTO campaigns (user_id, name, objective, daily_budget) VALUES (1, 'c1', 'TRAFFIC', 0), (1, 'c2', 'TRAFFIC', 0)");
      await db.query("INSERT INTO creatives (user_id, name, kind, source) VALUES (1, 'v1', 'video', 'tiktok'), (1, 'v2', 'video', 'tiktok')");
      const insert = (campaign, creative, advertiser, hash = 'h') => db.query('INSERT INTO campaign_creative_assets (campaign_id, creative_id, advertiser_id, tiktok_id, variant_sha256) VALUES ($1, $2, $3, $4, $5)', [campaign, creative, advertiser, 'tt-id', hash]);
      await insert(1, 1, '9001', 'a');
      await insert(1, 1, '9002', 'b'); // mesma campanha e criativo em OUTRA conta: outra versão
      await insert(2, 1, '9001', 'c'); // OUTRA campanha na mesma conta: outra versão
      await assert.rejects(() => insert(1, 1, '9001', 'd'), (e) => e.code === '23505', 'uma versão por (campanha, criativo, conta)');
      for (const bad of ['', 'abc', '9 1', "9001'; --", '9'.repeat(25)]) await assert.rejects(() => insert(1, 2, bad), (e) => e.code === '23514', bad);
      await assert.rejects(() => insert(404, 1, '9001'), (e) => e.code === '23503');
      await assert.rejects(() => insert(1, 404, '9001'), (e) => e.code === '23503');
      await db.query('DELETE FROM campaigns WHERE id = 2');
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM campaign_creative_assets')).c, 2, 'apagar a campanha apaga as versões dela');
      await db.query('DELETE FROM creatives WHERE id = 1');
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM campaign_creative_assets')).c, 0, 'apagar o criativo apaga as versões dele');
    } finally {
      await db.close();
    }
  });
});

describe('proxies por usuário (migração v6)', () => {
  it('tipos válidos, porta 1-65535, nome único por usuário (sem diferenciar maiúsculas), UMA ativa por usuário e cascata', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      await db.query("INSERT INTO users (email, name, password_hash) VALUES ('a@example.com', 'A', 'x'), ('b@example.com', 'B', 'x')");
      const insert = (user, name, { kind = 'socks5', port = 1080, active = false } = {}) => db.query("INSERT INTO proxies (user_id, name, kind, host, port, active) VALUES ($1, $2, $3, '203.0.113.9', $4, $5)", [user, name, kind, port, active]);
      for (const kind of ['http', 'https', 'socks4', 'socks5']) await insert(1, `p-${kind}`, { kind });
      for (const kind of ['ftp', 'socks', 'HTTP', '']) await assert.rejects(() => insert(1, `ruim-${kind}`, { kind }), (e) => e.code === '23514', kind);
      for (const port of [0, -1, 65536, 100000]) await assert.rejects(() => insert(1, `porta-${port}`, { port }), (e) => e.code === '23514', String(port));
      await assert.rejects(() => insert(1, 'P-HTTP'), (e) => e.code === '23505', 'nome único sem diferenciar maiúsculas');
      await insert(2, 'p-http'); // outro usuário pode usar o mesmo nome

      await insert(1, 'ativa-1', { active: true });
      await assert.rejects(() => insert(1, 'ativa-2', { active: true }), (e) => e.code === '23505', 'só uma ativa por usuário');
      await insert(2, 'ativa-do-outro', { active: true });
      await assert.rejects(() => db.query('UPDATE proxies SET active = true WHERE user_id = 1 AND name = $1', ['p-http']), (e) => e.code === '23505');
      await assert.rejects(() => db.query("INSERT INTO proxies (user_id, name, kind, host, port) VALUES (999, 'x', 'http', 'h', 80)"), (e) => e.code === '23503');
      await db.query('DELETE FROM users WHERE id = 1');
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM proxies')).c, 2, 'remover o usuário apaga as proxies dele');
    } finally {
      await db.close();
    }
  });
});

describe('ID da BC dona da conta de anúncio (migração v7)', () => {
  it('coluna opcional que só aceita números do TikTok; contas existentes ficam sem ID', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db, MIGRATIONS.slice(0, 6)); // banco como estava antes da v7
      await db.query("INSERT INTO users (email, name, password_hash) VALUES ('a@example.com', 'A', 'x')");
      await db.query("INSERT INTO tiktok_business_centers (owner_id, bc_id, name, access_token) VALUES (1, '111', 'BC', 'v1.x')");
      await db.query("INSERT INTO tiktok_advertisers (business_center_id, advertiser_id, name) VALUES (1, '9001', 'Antiga')");
      await runMigrations(db);
      assert.equal((await one(db, "SELECT owner_bc_id FROM tiktok_advertisers WHERE advertiser_id = '9001'")).owner_bc_id, null, 'dados antigos preservados, sem ID');
      const insert = (id, owner) => db.query('INSERT INTO tiktok_advertisers (business_center_id, advertiser_id, name, owner_bc_id) VALUES (1, $1, $1, $2)', [id, owner]);
      await insert('9002', '7123450000000000001');
      await insert('9003', null);
      for (const bad of ['', 'abc', '12 34', "1'; --", '1'.repeat(25), '-1']) await assert.rejects(() => insert(`b${bad.length}`, bad), (e) => e.code === '23514', JSON.stringify(bad));
    } finally {
      await db.close();
    }
  });
});

describe('Etiqueta das contas de anúncio (migração v8)', () => {
  it('coluna opcional que só aceita "agency"; contas existentes ficam comuns (sem etiqueta)', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db, MIGRATIONS.slice(0, 7)); // banco como estava antes da v8
      await db.query("INSERT INTO users (email, name, password_hash) VALUES ('a@example.com', 'A', 'x')");
      await db.query("INSERT INTO tiktok_business_centers (owner_id, bc_id, name, access_token) VALUES (1, '111', 'BC', 'v1.x')");
      await db.query("INSERT INTO tiktok_advertisers (business_center_id, advertiser_id, name) VALUES (1, '9001', 'Antiga')");
      await runMigrations(db);
      assert.equal((await one(db, "SELECT label FROM tiktok_advertisers WHERE advertiser_id = '9001'")).label, null, 'dados antigos preservados como conta comum');
      await db.query("UPDATE tiktok_advertisers SET label = 'agency' WHERE advertiser_id = '9001'");
      await db.query('UPDATE tiktok_advertisers SET label = NULL WHERE advertiser_id = $1', ['9001']);
      for (const bad of ['', 'Agency', 'vip', 'agency ', "agency'; --"]) {
        await assert.rejects(() => db.query('UPDATE tiktok_advertisers SET label = $1 WHERE advertiser_id = $2', [bad, '9001']), (e) => e.code === '23514', JSON.stringify(bad));
      }
    } finally {
      await db.close();
    }
  });
});

describe('Colaboradores (migração v9)', () => {
  it('vínculo e convite: áreas restritas, um dono por colaborador, cascatas e RLS ligado', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      assert.deepEqual(await findTablesWithoutRls(db), [], 'toda tabela nova com RLS');
      const user = async (email) => (await db.query("INSERT INTO users (email, name, password_hash, status) VALUES ($1, 'U', 'x', 'approved') RETURNING id", [email])).rows[0].id;
      const owner = await user('dono@example.com');
      const other = await user('outro@example.com');
      const collab = await user('colab@example.com');
      const member = (ownerId, userId, areas) => db.query('INSERT INTO workspace_members (owner_id, user_id, areas) VALUES ($1, $2, $3)', [ownerId, userId, areas]);
      const invite = (ownerId, email, areas, hash) => db.query("INSERT INTO workspace_invites (owner_id, email, name, areas, token_hash, expires_at) VALUES ($1, $2, 'N', $3, $4, now() + interval '1 day')", [ownerId, email, areas, hash]);

      // áreas: de 1 a 4, só nomes conhecidos
      for (const bad of [[], ['admin'], ['creatives', 'admin'], ['creatives', 'campaigns', 'reports', 'accounts', 'creatives'], ["creatives'; --"], ['Creatives']]) {
        await assert.rejects(() => member(owner, collab, bad), (e) => e.code === '23514', `membro ${JSON.stringify(bad)}`);
        await assert.rejects(() => invite(owner, 'c@example.com', bad, `h-${JSON.stringify(bad)}`), (e) => e.code === '23514', `convite ${JSON.stringify(bad)}`);
      }
      await assert.rejects(() => member(owner, owner, ['creatives']), (e) => e.code === '23514', 'ninguém é colaborador de si mesmo');
      await member(owner, collab, ['creatives', 'reports']);
      await assert.rejects(() => member(other, collab, ['creatives']), (e) => e.code === '23505', 'colaborador de UM dono só');

      // convites: um por dono+e-mail (sem diferenciar maiúsculas) e token único
      await invite(owner, 'Ana@Example.com', ['creatives'], 'hash-1');
      await assert.rejects(() => invite(owner, 'ana@example.com', ['creatives'], 'hash-2'), (e) => e.code === '23505');
      await assert.rejects(() => invite(other, 'ana@example.com', ['creatives'], 'hash-1'), (e) => e.code === '23505', 'hash do token é único');
      await invite(other, 'ana@example.com', ['creatives'], 'hash-3'); // outro dono pode convidar o mesmo e-mail

      // cascatas: apagar o colaborador remove o vínculo; apagar o dono remove tudo dele
      await db.query('DELETE FROM users WHERE id = $1', [collab]);
      assert.equal((await db.query('SELECT 1 FROM workspace_members')).rows.length, 0);
      await db.query('DELETE FROM users WHERE id = $1', [owner]);
      assert.deepEqual((await db.query('SELECT token_hash FROM workspace_invites')).rows.map((r) => r.token_hash), ['hash-3']);
    } finally {
      await db.close();
    }
  });
});

describe('Foto de perfil (migração v10)', () => {
  it('uma foto por usuário, só JPEG até 200 KB, e some junto com o usuário', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      assert.deepEqual(await findTablesWithoutRls(db), []);
      const user = (await db.query("INSERT INTO users (email, name, password_hash) VALUES ('a@example.com', 'A', 'x') RETURNING id")).rows[0].id;
      const insert = (data, mime) => db.query('INSERT INTO user_avatars (user_id, data, mime) VALUES ($1, $2, COALESCE($3, \'image/jpeg\'))', [user, data, mime ?? null]);
      await assert.rejects(() => insert(Buffer.alloc(0)), (e) => e.code === '23514', 'vazio');
      await assert.rejects(() => insert(Buffer.alloc(204_801)), (e) => e.code === '23514', 'maior que 200 KB');
      await assert.rejects(() => insert(Buffer.from([1, 2, 3]), 'image/svg+xml'), (e) => e.code === '23514', 'SVG nunca');
      await assert.rejects(() => insert(Buffer.from([1, 2, 3]), 'text/html'), (e) => e.code === '23514');
      await insert(Buffer.alloc(204_800, 1));
      await assert.rejects(() => insert(Buffer.from([1])), (e) => e.code === '23505', 'uma por usuário');
      await db.query('DELETE FROM users WHERE id = $1', [user]);
      assert.equal((await db.query('SELECT 1 FROM user_avatars')).rows.length, 0, 'cascata');
    } finally {
      await db.close();
    }
  });
});

describe('biblioteca de criativos: restrições do esquema (migração v2)', () => {
  it('tipos, coerência arquivo/referência, duplicidade por usuário e cascatas', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      await db.query("INSERT INTO users (email, name, password_hash) VALUES ('a@example.com', 'A', 'x'), ('b@example.com', 'B', 'x')");
      const upload = (user, sha, extra = '') => db.query(`INSERT INTO creatives (user_id, name, kind, source, mime_type, size_bytes, sha256, md5, storage_key ${extra}) VALUES ($1, 'c', 'image', 'upload', 'image/png', 10, $2, 'md5', '1/${'a'.repeat(32)}.png')`, [user, sha]);
      await upload(1, 'h1');
      // mesmo arquivo: bloqueado para o mesmo usuário, permitido para outro
      await assert.rejects(() => upload(1, 'h1'), (e) => e.code === '23505');
      await upload(2, 'h1');
      // CHECKs
      await assert.rejects(() => db.query("INSERT INTO creatives (user_id, name, kind, source) VALUES (1, 'x', 'audio', 'tiktok')"), (e) => e.code === '23514', 'kind');
      await assert.rejects(() => db.query("INSERT INTO creatives (user_id, name, kind, source) VALUES (1, 'x', 'image', 'ftp')"), (e) => e.code === '23514', 'source');
      await assert.rejects(() => db.query("INSERT INTO creatives (user_id, name, kind, source) VALUES (1, 'x', 'image', 'upload')"), (e) => e.code === '23514', 'upload exige arquivo, hashes, tipo e tamanho');
      await assert.rejects(() => db.query("INSERT INTO creatives (user_id, name, kind, source, storage_key) VALUES (1, 'x', 'image', 'tiktok', '1/x.png')"), (e) => e.code === '23514', 'referência do TikTok não guarda arquivo');
      await assert.rejects(() => db.query("INSERT INTO creatives (user_id, name, kind, source, mime_type, size_bytes, sha256, md5, storage_key) VALUES (1, 'x', 'image', 'upload', 'image/png', -1, 'h9', 'm', 'k')"), (e) => e.code === '23514', 'tamanho negativo');
      await assert.rejects(() => db.query("INSERT INTO creatives (user_id, name, kind, source) VALUES (999, 'x', 'image', 'tiktok')"), (e) => e.code === '23503', 'FK do usuário');
      // referência do TikTok (sem hash) pode repetir
      await db.query("INSERT INTO creatives (user_id, name, kind, source) VALUES (1, 'r1', 'video', 'tiktok'), (1, 'r2', 'video', 'tiktok')");
      // vínculos por conta de anúncio
      await db.query("INSERT INTO creative_tiktok_assets (creative_id, advertiser_id, tiktok_id) VALUES (1, '9001', 'v1'), (1, '9002', 'v2')");
      await assert.rejects(() => db.query("INSERT INTO creative_tiktok_assets (creative_id, advertiser_id, tiktok_id) VALUES (1, '9001', 'v3')"), (e) => e.code === '23505', 'PK (criativo, conta)');
      await assert.rejects(() => db.query("INSERT INTO creative_tiktok_assets (creative_id, advertiser_id, tiktok_id) VALUES (999, '9001', 'v')"), (e) => e.code === '23503');
      // cascatas: criativo -> vínculos; usuário -> criativos -> vínculos
      await db.query('DELETE FROM creatives WHERE id = 1');
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM creative_tiktok_assets')).c, 0);
      await db.query("INSERT INTO creative_tiktok_assets (creative_id, advertiser_id, tiktok_id) SELECT id, '9001', 'v' FROM creatives WHERE user_id = 1 LIMIT 1");
      await db.query('DELETE FROM users WHERE id = 1');
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM creatives WHERE user_id = 1')).c, 0);
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM creative_tiktok_assets')).c, 0);
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM creatives WHERE user_id = 2')).c, 1, 'só os dados do usuário removido');
    } finally {
      await db.close();
    }
  });

  it('tamanhos de arquivo grandes (bigint) voltam como número', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      await db.query("INSERT INTO users (email, name, password_hash) VALUES ('a@example.com', 'A', 'x')");
      await db.query("INSERT INTO creatives (user_id, name, kind, source, mime_type, size_bytes, sha256, md5, storage_key) VALUES (1, 'grande', 'video', 'upload', 'video/mp4', 5368709120, 'h', 'm', '1/" + 'b'.repeat(32) + ".mp4')");
      const row = await one(db, 'SELECT size_bytes, COALESCE(SUM(size_bytes), 0)::bigint AS total FROM creatives GROUP BY size_bytes');
      assert.equal(typeof row.size_bytes, 'number');
      assert.equal(row.size_bytes, 5 * 1024 ** 3, '5 GB passa do limite do int4');
    } finally {
      await db.close();
    }
  });
});

describe('segurança do Supabase: RLS e privilégios das chaves públicas', () => {
  it('toda tabela nasce com RLS ligado e sem políticas', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      assert.deepEqual(await findTablesWithoutRls(db), []);
      const policies = await all(db, "SELECT tablename FROM pg_policies WHERE schemaname = 'public'");
      assert.deepEqual(policies, [], 'sem políticas = nega tudo para quem não é dono');
    } finally {
      await db.close();
    }
  });

  it('simulando o Supabase: anon, authenticated e service_role não recebem NENHUM privilégio', async () => {
    const db = await freshDb();
    try {
      // O Supabase cria estes papéis e concede privilégios por padrão em tabelas novas do schema public.
      await db.exec(`
        CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
      `);
      await runMigrations(db);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        for (const table of [...EXPECTED_TABLES, 'schema_migrations']) {
          for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            const { allowed } = await one(db, 'SELECT has_table_privilege($1, $2, $3) AS allowed', [role, `public.${table}`, privilege]);
            assert.equal(allowed, false, `${role} não deveria ter ${privilege} em ${table}`);
          }
        }
      }
    } finally {
      await db.close();
    }
  });

  it('detecta tabela criada sem RLS (impede que um esquecimento exponha dados pela API REST)', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      await db.exec('CREATE TABLE esquecida (id int)');
      assert.deepEqual(await findTablesWithoutRls(db), ['esquecida']);
      await db.exec('ALTER TABLE esquecida ENABLE ROW LEVEL SECURITY');
      assert.deepEqual(await findTablesWithoutRls(db), []);
    } finally {
      await db.close();
    }

  });

  it('openDatabase entrega um banco migrado e protegido', async () => {
    const db = await openDatabase(config, { log: silent });
    try {
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM users')).c, 0);
      assert.deepEqual(await findTablesWithoutRls(db), []);
    } finally {
      await db.close();
    }
  });
});

describe('isolamento em banco COMPARTILHADO com outro sistema (schema próprio)', () => {
  const SIMULATE_SUPABASE = `
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    -- "Outro sistema" que já vive no schema public: tabela SEM RLS e com sequência, acessível às funções da API.
    CREATE TABLE public.outro_sistema_pedidos (id SERIAL PRIMARY KEY, valor INT);
    CREATE TABLE public.outro_sistema_pagamentos (id SERIAL PRIMARY KEY, valor INT);
    GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
    -- Para o pior caso, os privilégios padrão também valeriam no nosso schema (o app precisa revogá-los).
    CREATE SCHEMA tiktok_ads;
    ALTER DEFAULT PRIVILEGES IN SCHEMA tiktok_ads GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA tiktok_ads GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  `;

  async function privilegeSnapshot(db) {
    const out = [];
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const table of ['outro_sistema_pedidos', 'outro_sistema_pagamentos']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          out.push([role, table, privilege, (await one(db, 'SELECT has_table_privilege($1, $2, $3) AS ok', [role, `public.${table}`, privilege])).ok]);
        }
      }
      for (const seq of ['outro_sistema_pedidos_id_seq', 'outro_sistema_pagamentos_id_seq']) {
        out.push([role, seq, 'USAGE', (await one(db, 'SELECT has_sequence_privilege($1, $2, $3) AS ok', [role, `public.${seq}`, 'USAGE'])).ok]);
      }
    }
    return out;
  }

  it('as tabelas do app nascem SÓ no schema próprio e o public do outro sistema não é tocado', async () => {
    const db = await createPgliteDatabase();
    try {
      await db.exec(SIMULATE_SUPABASE);
      const before = await privilegeSnapshot(db);
      assert.ok(before.every(([, , , ok]) => ok === true), 'pré-condição: o outro sistema tem privilégios para as funções da API');

      await db.exec('SET search_path TO tiktok_ads'); // o que DATABASE_SCHEMA faz em cada conexão
      await runMigrations(db);

      const where = async (schema) => (await all(db, 'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [schema])).map((t) => t.tablename);
      assert.deepEqual(await where('tiktok_ads'), [...EXPECTED_TABLES, 'schema_migrations'].sort());
      assert.deepEqual(await where('public'), ['outro_sistema_pagamentos', 'outro_sistema_pedidos'], 'nenhuma tabela nossa no public');

      assert.deepEqual(await privilegeSnapshot(db), before, 'privilégios do outro sistema (tabelas E sequências) continuam EXATAMENTE como estavam');
      assert.equal((await one(db, 'SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass', ['public.outro_sistema_pedidos'])).relrowsecurity, false, 'não ligamos RLS em tabela alheia');
    } finally {
      await db.close();
    }
  });

  it('as NOSSAS tabelas e sequências ficam sem privilégio para as funções da API (mesmo com privilégios padrão)', async () => {
    const db = await createPgliteDatabase();
    try {
      await db.exec(SIMULATE_SUPABASE);
      await db.exec('SET search_path TO tiktok_ads');
      await runMigrations(db);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        for (const table of [...EXPECTED_TABLES, 'schema_migrations']) {
          for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            assert.equal((await one(db, 'SELECT has_table_privilege($1, $2, $3) AS ok', [role, `tiktok_ads.${table}`, privilege])).ok, false, `${role} ${privilege} ${table}`);
          }
        }
        for (const seq of ['users_id_seq', 'campaigns_id_seq', 'tiktok_business_centers_id_seq', 'creatives_id_seq']) {
          assert.equal((await one(db, 'SELECT has_sequence_privilege($1, $2, $3) AS ok', [role, `tiktok_ads.${seq}`, 'USAGE'])).ok, false, `${role} USAGE ${seq}`);
        }
      }
    } finally {
      await db.close();
    }
  });

  it('a checagem de RLS ignora tabelas do outro sistema (não bloqueia a subida do servidor) mas pega as do app', async () => {
    const db = await createPgliteDatabase({ schema: 'tiktok_ads' });
    try {
      await db.exec('CREATE TABLE public.outro_sistema_sem_rls (id int)');
      await runMigrations(db);
      assert.deepEqual(await findTablesWithoutRls(db), [], 'a tabela alheia sem RLS não é problema deste app');
      await db.exec('CREATE TABLE tabela_do_app_esquecida (id int)');
      assert.deepEqual(await findTablesWithoutRls(db), ['tabela_do_app_esquecida'], 'esquecimento nosso continua sendo detectado');
    } finally {
      await db.close();
    }
  });

  it('openDatabase com DATABASE_SCHEMA migra no schema configurado e passa na checagem de produção', async () => {
    const db = await openDatabase({ ...config, schema: 'tiktok_ads' }, { log: silent });
    try {
      const { schema } = await one(db, 'SELECT current_schema() AS schema');
      assert.equal(schema, 'tiktok_ads');
      assert.equal((await one(db, "SELECT COUNT(*)::int AS c FROM pg_tables WHERE schemaname = 'public'")).c, 0);
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM users')).c, 0);
    } finally {
      await db.close();
    }
  });
});
