import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createPgliteDatabase } from '../src/db/adapters/pglite.js';
import { importFromSqlite } from '../src/db/import-sqlite.js';
import { runMigrations } from '../src/db/migrations.js';
import { all, one } from './helpers.js';

/** Banco SQLite no formato ANTIGO (esquema versão 2), com dados representativos. */
function buildLegacySqlite(file, { version = 2 } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, company TEXT,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), reviewed_at TEXT, reviewed_by INTEGER);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT);
    CREATE TABLE campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, objective TEXT NOT NULL,
      daily_budget INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), config TEXT, advertiser_id TEXT, tiktok_campaign_id TEXT,
      tiktok_adgroup_id TEXT, tiktok_ad_id TEXT, publish_error TEXT, published_at TEXT);
    CREATE TABLE tiktok_business_centers (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, bc_id TEXT NOT NULL, name TEXT NOT NULL,
      access_token TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', last_error TEXT, last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE tiktok_advertisers (business_center_id INTEGER NOT NULL, advertiser_id TEXT NOT NULL, name TEXT NOT NULL, currency TEXT, timezone TEXT,
      PRIMARY KEY (business_center_id, advertiser_id));
    PRAGMA user_version = ${version};
  `);
  // Admin só aparece com id MAIOR que o do usuário que ele revisou: testa a ordem de inserção de reviewed_by.
  db.prepare("INSERT INTO users (id, email, name, company, password_hash, role, status, created_at, reviewed_at, reviewed_by) VALUES (3, 'admin@example.com', 'Admin', NULL, 'h-admin', 'admin', 'approved', '2026-11-01T10:00:00.000Z', NULL, NULL)").run();
  db.prepare("INSERT INTO users (id, email, name, company, password_hash, role, status, created_at, reviewed_at, reviewed_by) VALUES (1, 'Ana@Example.com', 'Ana', 'Loja Ana', 'h-ana', 'user', 'approved', '2026-11-02T10:00:00.000Z', '2026-11-02T11:00:00.000Z', 3)").run();
  db.prepare("INSERT INTO users (id, email, name, password_hash, status) VALUES (7, 'bia@example.com', 'Bia', 'h-bia', 'pending')").run();
  db.prepare("INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ('t', 1, 'c', 9999999999999)").run();
  db.prepare("INSERT INTO campaigns (id, user_id, name, objective, daily_budget, status) VALUES (5, 1, 'Simples', 'TRAFFIC', 5000, 'active')").run();
  db.prepare("INSERT INTO campaigns (id, user_id, name, objective, daily_budget, status, config, advertiser_id, tiktok_campaign_id, publish_error, published_at) VALUES (9, 1, 'Assistente', 'REACH', 0, 'draft', ?, '9001', '7001', 'falhou', '2026-11-03T12:00:00.000Z')").run(JSON.stringify({ campaign: { name: 'Assistente', objective: 'REACH' }, adGroup: { locations: ['BR'] } }));
  db.prepare("INSERT INTO tiktok_business_centers (id, owner_id, bc_id, name, access_token, shared, status, last_error, last_synced_at) VALUES (4, 3, '111', 'Equipe', 'v1.tok', 1, 'active', NULL, '2026-11-04T09:00:00.000Z')").run();
  db.prepare("INSERT INTO tiktok_business_centers (id, owner_id, bc_id, name, access_token, shared, status, last_error) VALUES (6, 1, '222', 'Privada', 'v1.tok2', 0, 'error', 'token expirou')").run();
  db.prepare("INSERT INTO tiktok_advertisers (business_center_id, advertiser_id, name, currency, timezone) VALUES (4, '9001', 'Conta 1', 'BRL', 'America/Sao_Paulo')").run();
  db.prepare("INSERT INTO tiktok_advertisers (business_center_id, advertiser_id, name) VALUES (6, '9100', 'Conta sem moeda')").run();
  db.close();
}

describe('importação SQLite -> PostgreSQL', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-sqlite-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const newTarget = async () => {
    const db = await createPgliteDatabase();
    await runMigrations(db);
    return db;
  };

  it('importa tudo preservando IDs, tipos e relacionamentos; sessões não são copiadas', async () => {
    const file = path.join(dir, 'ok.db');
    buildLegacySqlite(file);
    const db = await newTarget();
    try {
      const result = await importFromSqlite({ sqlitePath: file, db });
      assert.deepEqual(result, { counts: { users: 3, campaigns: 2, businessCenters: 2, advertisers: 2 }, imported: true });

      const users = await all(db, 'SELECT id, email, name, company, role, status, reviewed_by, password_hash FROM users ORDER BY id');
      assert.deepEqual(users.map((u) => [u.id, u.email, u.status, u.reviewed_by]), [[1, 'Ana@Example.com', 'approved', 3], [3, 'admin@example.com', 'approved', null], [7, 'bia@example.com', 'pending', null]]);
      assert.equal(users[0].password_hash, 'h-ana', 'hash de senha intacto: ninguém precisa redefinir senha');
      assert.equal((await one(db, 'SELECT reviewed_at FROM users WHERE id = 1')).reviewed_at.toISOString(), '2026-11-02T11:00:00.000Z');

      const wizard = await one(db, 'SELECT * FROM campaigns WHERE id = 9');
      assert.deepEqual(wizard.config, { campaign: { name: 'Assistente', objective: 'REACH' }, adGroup: { locations: ['BR'] } }, 'config vira jsonb');
      // A publicação única do banco antigo vira uma linha em campaign_publications (uma por conta de anúncio).
      const publications = await all(db, 'SELECT campaign_id, advertiser_id, tiktok_campaign_id, tiktok_ad_id, error, published_at FROM campaign_publications');
      assert.equal(publications.length, 1);
      assert.deepEqual([publications[0].campaign_id, publications[0].advertiser_id, publications[0].tiktok_campaign_id, publications[0].tiktok_ad_id, publications[0].error], [9, '9001', '7001', null, 'falhou']);
      assert.equal(publications[0].published_at.toISOString(), '2026-11-03T12:00:00.000Z');
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM campaign_publications WHERE campaign_id <> 9')).c, 0, 'campanha sem publicação não gera linha');
      assert.equal((await one(db, 'SELECT config FROM campaigns WHERE id = 5')).config, null, 'campanha simples continua simples');

      const bcs = await all(db, 'SELECT id, owner_id, bc_id, shared, status, last_error, access_token FROM tiktok_business_centers ORDER BY id');
      assert.deepEqual(bcs.map((b) => [b.id, b.owner_id, b.shared, b.status, b.last_error]), [[4, 3, true, 'active', null], [6, 1, false, 'error', 'token expirou']]);
      assert.deepEqual(bcs.map((b) => b.access_token), ['v1.tok', 'v1.tok2'], 'token continua criptografado, byte a byte');
      assert.deepEqual((await all(db, 'SELECT business_center_id, advertiser_id, currency, timezone FROM tiktok_advertisers ORDER BY advertiser_id')).map((a) => [a.business_center_id, a.advertiser_id, a.currency, a.timezone]), [[4, '9001', 'BRL', 'America/Sao_Paulo'], [6, '9100', null, null]]);
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM sessions')).c, 0);
    } finally {
      await db.close();
    }
  });

  it('os próximos IDs continuam depois do maior ID importado (sem colisão)', async () => {
    const file = path.join(dir, 'seq.db');
    buildLegacySqlite(file);
    const db = await newTarget();
    try {
      await importFromSqlite({ sqlitePath: file, db });
      assert.equal((await one(db, "INSERT INTO users (email, name, password_hash) VALUES ('nova@example.com', 'Nova', 'x') RETURNING id")).id, 8);
      assert.equal((await one(db, "INSERT INTO campaigns (user_id, name, objective, daily_budget) VALUES (1, 'n', 'TRAFFIC', 1) RETURNING id")).id, 10);
      assert.equal((await one(db, "INSERT INTO tiktok_business_centers (owner_id, bc_id, name, access_token) VALUES (1, '999', 'n', 'v1.x') RETURNING id")).id, 7);
    } finally {
      await db.close();
    }
  });

  it('simulação (dry-run) conta, mas não grava nada', async () => {
    const file = path.join(dir, 'dry.db');
    buildLegacySqlite(file);
    const db = await newTarget();
    try {
      const result = await importFromSqlite({ sqlitePath: file, db, dryRun: true });
      assert.equal(result.imported, false);
      assert.equal(result.counts.users, 3);
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM users')).c, 0);
    } finally {
      await db.close();
    }
  });

  it('recusa destino que já tem usuários (não mistura dados) e não altera nada', async () => {
    const file = path.join(dir, 'nonempty.db');
    buildLegacySqlite(file);
    const db = await newTarget();
    try {
      await db.query("INSERT INTO users (email, name, password_hash) VALUES ('ja@existe.com', 'Já existe', 'x')");
      await assert.rejects(() => importFromSqlite({ sqlitePath: file, db }), /já tem usuários/);
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM users')).c, 1);
      assert.equal((await one(db, 'SELECT COUNT(*)::int AS c FROM campaigns')).c, 0);
    } finally {
      await db.close();
    }
  });

  it('recusa SQLite em versão de esquema diferente', async () => {
    const file = path.join(dir, 'old.db');
    buildLegacySqlite(file, { version: 1 });
    const db = await newTarget();
    try {
      await assert.rejects(() => importFromSqlite({ sqlitePath: file, db }), /versão de esquema 1/);
    } finally {
      await db.close();
    }
  });

  it('tudo ou nada: uma linha inválida desfaz a importação inteira', async () => {
    const file = path.join(dir, 'broken.db');
    buildLegacySqlite(file);
    const src = new DatabaseSync(file);
    src.prepare("INSERT INTO campaigns (id, user_id, name, objective, daily_budget, status) VALUES (11, 1, 'Orçamento inválido', 'TRAFFIC', -5, 'draft')").run();
    src.close();
    const db = await newTarget();
    try {
      await assert.rejects(() => importFromSqlite({ sqlitePath: file, db }));
      for (const table of ['users', 'campaigns', 'tiktok_business_centers', 'tiktok_advertisers']) {
        assert.equal((await one(db, `SELECT COUNT(*)::int AS c FROM ${table}`)).c, 0, `${table} deveria estar vazia após o rollback`);
      }
    } finally {
      await db.close();
    }
  });
});
