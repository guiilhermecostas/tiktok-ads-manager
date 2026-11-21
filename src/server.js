import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';

const config = loadConfig();
const db = await openDatabase(config.database);
console.log(`[db] ${config.database.url ? 'PostgreSQL (DATABASE_URL)' : `PGlite de desenvolvimento em ${config.database.devDataDir}`}`);

const { app, authService, sessions, creativeStorage, creativeCleaner, close } = createApp({ config, db });
await creativeStorage.init(); // pastas privadas da biblioteca de criativos + limpeza de temporários antigos
// A limpeza dos criativos depende do FFmpeg: confere na subida e avisa alto se não executa (não derruba o sistema).
const ffmpeg = await creativeCleaner.selfCheck();
if (ffmpeg.ok) console.log(`[criativos] limpeza de criativos pronta (FFmpeg ${ffmpeg.version})`);
else console.error(`[criativos] ATENÇÃO: a limpeza de criativos NÃO está disponível: ${ffmpeg.error} Publicações com arquivos serão recusadas.`);

await authService.ensureAdmin();

// Limpeza periódica de sessões vencidas. Erros são só registrados: nunca podem derrubar o processo.
const purge = () => sessions.purgeExpired().catch((err) => console.error('[sessões] falha na limpeza:', err.code ?? err.message));
await purge();
const purgeTimer = setInterval(purge, 60 * 60 * 1000);
purgeTimer.unref();

const server = app.listen(config.port, config.host, () => {
  console.log(`TikTok Ads Manager rodando em http://localhost:${config.port}  (${config.env})`);
});

function shutdown(signal) {
  console.log(`\n${signal} recebido, encerrando...`);
  close();
  server.close(async () => {
    await db.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
