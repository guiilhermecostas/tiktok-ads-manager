import { createPgDatabase } from './adapters/pg.js';
import { createPgliteDatabase } from './adapters/pglite.js';
import { findTablesWithoutRls, runMigrations } from './migrations.js';

/**
 * O schema do app (DATABASE_SCHEMA) é fixado no NÍVEL DO PAPEL do banco (`ALTER ROLE ... SET search_path`), o que vale em
 * qualquer pooler. Aqui confirmamos que isso está valendo: se não estiver, as tabelas iriam parar no schema errado.
 */
export async function assertConfiguredSchema(db, schema) {
  if (!schema) return;
  const { rows } = await db.query('SELECT current_schema() AS schema');
  if (rows[0].schema !== schema) {
    throw new Error(
      `A conexão está usando o schema "${rows[0].schema}", mas DATABASE_SCHEMA é "${schema}". ` +
        `Defina no banco: CREATE SCHEMA IF NOT EXISTS ${schema}; ALTER ROLE <seu_papel> SET search_path = ${schema};`,
    );
  }
}

/**
 * Abre o banco e aplica as migrações.
 *  - Com `DATABASE_URL` (Supabase/Postgres): conexão por pool, SSL verificado.
 *  - Sem URL (somente desenvolvimento/testes): PGlite (Postgres embutido), em disco ou em memória.
 * Retorna um objeto com `query`, `exec`, `transaction` e `close` (veja adapters/pg.js).
 */
export async function openDatabase(databaseConfig, { log = console, migrate = true } = {}) {
  const db = databaseConfig.url
    ? createPgDatabase({ connectionString: databaseConfig.url, caPath: databaseConfig.sslCaPath, poolMax: databaseConfig.poolMax, log })
    : await createPgliteDatabase({ dataDir: databaseConfig.devDataDir, schema: databaseConfig.schema });

  try {
    await assertConfiguredSchema(db, databaseConfig.schema);
  } catch (err) {
    await db.close().catch(() => {});
    throw err;
  }

  if (migrate) {
    try {
      await runMigrations(db);
      const unprotected = await findTablesWithoutRls(db);
      if (unprotected.length) {
        const message = `Tabelas do app sem RLS (poderiam ficar expostas pela API REST do Supabase): ${unprotected.join(', ')}`;
        if (databaseConfig.requireRls) throw new Error(message);
        log.warn?.(`[db] AVISO: ${message}`);
      }
    } catch (err) {
      await db.close().catch(() => {});
      throw err;
    }
  }
  return db;
}
