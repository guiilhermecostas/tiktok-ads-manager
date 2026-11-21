import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { findTablesWithoutRls } from '../src/db/migrations.js';

/**
 * Utilitário do banco.
 *   npm run db:check     diagnóstico (conexão, SSL, schema, migrações, RLS) — não altera nada
 *   npm run db:migrate   aplica as migrações pendentes e mostra o diagnóstico
 * Nunca imprime a DATABASE_URL (contém a senha).
 */
const command = process.argv[2];
if (!['check', 'migrate'].includes(command)) {
  console.error('Uso: node scripts/db.js <check|migrate>');
  process.exit(1);
}

const config = loadConfig();
const { database } = config;
const target = database.url ? `PostgreSQL ${new URL(database.url).host}` : `PGlite de desenvolvimento (${database.devDataDir})`;
console.log(`Destino: ${target}${database.schema ? `  schema: ${database.schema}` : ''}`);

let db;
try {
  db = await openDatabase(database, { migrate: command === 'migrate' });
  const { rows } = await db.query(
    "SELECT current_user AS usuario, current_schema() AS schema, split_part(version(), ' ', 2) AS versao",
  );
  const info = rows[0];
  const tls = database.url ? 'TLS com certificado verificado' : 'sem rede (Postgres embutido)';
  console.log(`Conexão : ok (usuário ${info.usuario}, PostgreSQL ${info.versao}, ${tls}; schema atual: ${info.schema})`);

  const tables = await db.query('SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename');
  console.log(`Tabelas : ${tables.rows.map((t) => t.tablename).join(', ') || '(nenhuma)'}`);
  const migrations = await db.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS exists");
  if (migrations.rows[0].exists) {
    const applied = await db.query('SELECT version, description FROM schema_migrations ORDER BY version');
    console.log(`Migrações aplicadas: ${applied.rows.map((m) => `v${m.version}`).join(', ') || '(nenhuma)'}`);
  } else {
    console.log('Migrações aplicadas: (nenhuma; rode npm run db:migrate)');
  }
  const unprotected = await findTablesWithoutRls(db);
  console.log(`RLS     : ${unprotected.length ? `ATENÇÃO, sem RLS: ${unprotected.join(', ')}` : 'ligado em todas as tabelas do app'}`);
  if (unprotected.length) process.exitCode = 2;
} catch (err) {
  console.error(`Falha: ${err.message}`);
  if (/self.signed|unable to verify|certificate/i.test(err.message)) {
    console.error('O certificado SSL do banco não foi reconhecido. Baixe a CA do provedor e informe o caminho em DATABASE_SSL_CA_PATH (a verificação nunca é desligada).');
  }
  process.exitCode = 1;
} finally {
  await db?.close().catch(() => {});
}
