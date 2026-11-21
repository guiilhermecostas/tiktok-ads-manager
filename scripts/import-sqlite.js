import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { importFromSqlite } from '../src/db/import-sqlite.js';

/**
 * Importa os dados do banco antigo (SQLite) para o banco atual (DATABASE_URL = Supabase; sem ela, PGlite de desenvolvimento).
 *   npm run import:sqlite -- [caminho/do/app.db] [--dry-run]
 */
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sqlitePath = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'data/app.db');

if (!fs.existsSync(sqlitePath)) {
  console.error(`Arquivo SQLite não encontrado: ${sqlitePath}`);
  process.exit(1);
}

const config = loadConfig();
const target = config.database.url ? 'PostgreSQL (DATABASE_URL)' : `PGlite de desenvolvimento (${config.database.devDataDir})`;
console.log(`Origem : ${sqlitePath}\nDestino: ${target}${dryRun ? '\nModo   : simulação (nada será gravado)' : ''}`);

const db = await openDatabase(config.database);
try {
  const { counts, imported } = await importFromSqlite({ sqlitePath, db, dryRun });
  console.log(`\n${imported ? 'Importado' : 'Seria importado'}:`);
  console.log(`  usuários: ${counts.users}\n  campanhas: ${counts.campaigns}\n  Business Centers: ${counts.businessCenters}\n  contas de anúncio: ${counts.advertisers}`);
  if (imported) console.log('\nSessões não são copiadas: todos precisam entrar novamente. Guarde o arquivo SQLite original até confirmar que tudo está certo.');
} catch (err) {
  console.error(`\nFalha na importação: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
