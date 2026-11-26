import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { proxyRuntimeSelfCheck } from './modules/proxies/proxy-dispatcher.js';

const config = loadConfig();
const db = await openDatabase(config.database);
console.log(`[db] ${config.database.url ? 'PostgreSQL (DATABASE_URL)' : `PGlite de desenvolvimento em ${config.database.devDataDir}`}`);

const { app, authService, sessions, creativeStorage, creativeCleaner, hourly, billing, hooks, close } = createApp({ config, db });
await creativeStorage.init(); // pastas privadas da biblioteca de criativos + limpeza de temporários antigos
// A limpeza dos criativos depende do FFmpeg: confere na subida e avisa alto se não executa (não derruba o sistema).
// O mesmo para as proxies: o fetch precisa aceitar os dispatchers (HTTP e SOCKS) neste ambiente.
const proxyRuntime = await proxyRuntimeSelfCheck();
if (proxyRuntime.ok) console.log('[proxy] roteamento por proxy pronto (HTTP, HTTPS, SOCKS4 e SOCKS5)');
else console.error(`[proxy] ATENÇÃO: o roteamento por proxy NÃO está funcionando: ${proxyRuntime.error} As chamadas com proxy ativa vão falhar.`);
const ffmpeg = await creativeCleaner.selfCheck();
if (ffmpeg.ok) console.log(`[criativos] limpeza de criativos pronta (FFmpeg ${ffmpeg.version})`);
else console.error(`[criativos] ATENÇÃO: a limpeza de criativos NÃO está disponível: ${ffmpeg.error} Publicações com arquivos serão recusadas.`);

await authService.ensureAdmin();

// Limpeza periódica de sessões vencidas. Erros são só registrados: nunca podem derrubar o processo.
const purge = () => sessions.purgeExpired().catch((err) => console.error('[sessões] falha na limpeza:', err.code ?? err.message));
await purge();
const purgeTimer = setInterval(purge, 60 * 60 * 1000);
purgeTimer.unref();

// Assinaturas: fecha os meses vencidos (uma vez cada) a cada hora.
billing.start();

// Coleta do gasto por hora (TikTok) a cada 30 minutos; só roda com a integração configurada. Erros são só registrados.
if (config.tiktok.configured) {
  hourly.start();
  console.log('[por hora] coleta do gasto por hora ligada (a cada 30 minutos)');
}

// Hook com IA: acompanha as gerações na Kling (a cada poucos segundos). Só liga com a chave configurada.
if (config.kling.enabled) {
  await hooks.start();
  console.log('[hook] Hook com IA (Kling) ligado');
} else {
  console.log('[hook] Hook com IA desligado (defina KLING_API_KEY para ligar)');
}

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
