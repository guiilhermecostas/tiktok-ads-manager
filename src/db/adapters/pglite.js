/**
 * Adaptador PGlite: PostgreSQL real rodando dentro do processo (WASM).
 * Usado nos TESTES (em memória) e como alternativa de DESENVOLVIMENTO sem Supabase (em disco).
 * Nunca é usado em produção (a configuração exige DATABASE_URL). Mesmo contrato do adaptador `pg`.
 */
import fs from 'node:fs';

export async function createPgliteDatabase({ dataDir, schema = null } = {}) {
  const { PGlite } = await import('@electric-sql/pglite'); // devDependency: só carrega quando necessário
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  if (dataDir) fs.chmodSync(dataDir, 0o700);
  if (schema) {
    await db.exec(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await db.exec(`SET search_path TO "${schema}"`);
  }

  const wrap = (client) => ({
    async query(sql, params = []) {
      const result = await client.query(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async exec(sql) {
      await client.exec(sql);
    },
  });

  return {
    dialect: 'pglite',
    ...wrap(db),
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx))),
    close: () => db.close(),
  };
}
