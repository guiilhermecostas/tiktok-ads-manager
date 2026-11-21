import fs from 'node:fs';
import pg from 'pg';

/**
 * Adaptador PostgreSQL (Supabase ou qualquer Postgres) sobre `pg.Pool`.
 *
 * Contrato comum a todos os adaptadores:
 *   query(sql, params) -> { rows, rowCount }     (parâmetros $1, $2…)
 *   exec(sql)                                    (várias instruções, sem parâmetros)
 *   transaction(fn(tx))                          (tx tem query/exec; COMMIT/ROLLBACK automáticos)
 *   close()
 */

// int8 (COUNT, SUM de bigint) chega como string no `pg`; nossos números cabem com folga em Number.
const types = {
  getTypeParser: (oid, format) => (oid === 20 ? (value) => Number(value) : pg.types.getTypeParser(oid, format)),
};

/**
 * Remove parâmetros de SSL da URL: o `pg` deixa a URL sobrescrever a opção `ssl`, o que poderia
 * rebaixar a verificação do certificado sem ninguém perceber. O SSL é decidido só por `buildSsl`.
 */
export function normalizeConnectionString(connectionString) {
  const url = new URL(connectionString);
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl']) url.searchParams.delete(key);
  return url.toString();
}

export function buildSsl({ connectionString, caPath }) {
  const mode = new URL(connectionString).searchParams.get('sslmode');
  if (mode === 'disable') return false; // (em produção a configuração já recusa isso)
  // Verificação do certificado SEMPRE ligada. Se o provedor usar uma CA própria, informe-a em DATABASE_SSL_CA_PATH.
  return caPath ? { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true } : { rejectUnauthorized: true };
}

export function createPgDatabase({ connectionString, caPath, poolMax = 10, log = console }) {
  const pool = new pg.Pool({
    connectionString: normalizeConnectionString(connectionString),
    ssl: buildSsl({ connectionString, caPath }),
    max: poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    application_name: 'tiktok-ads-manager',
    types,
  });
  // Erro em conexão ociosa (ex.: o pooler reiniciou) não pode derrubar o processo.
  pool.on('error', (err) => log.error('[db] erro em conexão ociosa:', err.code ?? err.message));

  const wrap = (client) => ({
    async query(sql, params = []) {
      const result = await client.query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    async exec(sql) {
      await client.query(sql);
    },
  });

  return {
    dialect: 'postgres',
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* a conexão pode já ter caído */
        }
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
