import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { createAdminRouter } from './modules/admin/admin.routes.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { createSessionsRepository } from './modules/auth/sessions.repository.js';
import { createCampaignsRepository } from './modules/campaigns/campaigns.repository.js';
import { createCampaignsRouter } from './modules/campaigns/campaigns.routes.js';
import { createMailer } from './modules/mail/mailer.js';
import { createCreativeCleaner } from './modules/creatives/creative-cleaner.js';
import { createLocalCreativeStorage } from './modules/creatives/creative-storage.js';
import { createCreativesRepository } from './modules/creatives/creatives.repository.js';
import { createCreativesRouter } from './modules/creatives/creatives.routes.js';
import { createCreativesService } from './modules/creatives/creatives.service.js';
import { createProxiesRepository } from './modules/proxies/proxies.repository.js';
import { createProxiesRouter } from './modules/proxies/proxies.routes.js';
import { createProxiesService } from './modules/proxies/proxies.service.js';
import { createTeamRepository } from './modules/team/team.repository.js';
import { createInvitationsRouter, createTeamRouter } from './modules/team/team.routes.js';
import { createTeamService } from './modules/team/team.service.js';
import { createTiktokClient } from './modules/tiktok/tiktok.client.js';
import { createBusinessCentersRepository } from './modules/tiktok/business-centers.repository.js';
import { createOauthAttemptsRepository } from './modules/tiktok/oauth-attempts.repository.js';
import { createTiktokCallbackRouter, createTiktokRouter } from './modules/tiktok/tiktok.routes.js';
import { createTiktokService } from './modules/tiktok/tiktok.service.js';
import { createUsersRepository } from './modules/users/users.repository.js';
import { apiNotFound, errorHandler } from './middleware/errors.js';
import { requireAdmin, requireApproved, requireAuth, sameOriginOnly } from './middleware/guards.js';
import { loadSession } from './middleware/session.js';
import { requireArea, requireAreaByMethod, requireOwner, resolveWorkspace } from './middleware/workspace.js';

const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SHARED_DIR = path.join(ROOT_DIR, 'shared');

/**
 * Monta a aplicação Express. Recebe dependências (config, db, log) para facilitar testes.
 */
export function createApp({ config, db, log = console, limits, fetchFn, cleaner, mailer }) {
  const users = createUsersRepository(db);
  const sessions = createSessionsRepository(db, { ttlMs: config.sessionTtlMs });
  const campaigns = createCampaignsRepository(db);
  const authService = createAuthService({ users, sessions, config });
  const tiktokClient = createTiktokClient({ config, fetchFn });
  // Sem TOKEN_ENCRYPTION_KEY a chave é nula: o serviço recusa cadastros (ensureConfigured) e nada é gravado.
  const businessCenters = createBusinessCentersRepository(db, { encryptionKey: config.tiktok.encryptionKey });
  // Proxies do usuário: com uma ativa, TODAS as chamadas ao TikTok feitas com as BCs dele saem por ela.
  const proxiesService = createProxiesService({ repo: createProxiesRepository(db, { encryptionKey: config.tiktok.encryptionKey }), config, fetchFn: fetchFn ?? fetch, log });
  const tiktokService = createTiktokService({ client: tiktokClient, repo: businessCenters, attempts: createOauthAttemptsRepository(db), users, proxies: proxiesService, config, log });
  const creativeStorage = createLocalCreativeStorage({ dir: config.creatives.dir });
  // Limpeza dos criativos a cada publicação (metadados, hash e cantos). `cleaner` pode ser injetado nos testes.
  const cleaning = config.creatives.cleaning ?? {};
  const creativeCleaner = cleaner ?? createCreativeCleaner({ ffmpegPath: cleaning.ffmpegPath ?? null, tmpDir: creativeStorage.tmpDir, concurrency: cleaning.concurrency, timeoutMs: cleaning.timeoutMs, threads: cleaning.threads, log });
  const creativesService = createCreativesService({ repo: createCreativesRepository(db), storage: creativeStorage, cleaner: creativeCleaner, tiktok: tiktokService, config, log });

  // E-mail (convites de colaboradores) pelo Resend. `mailer` pode ser injetado nos testes.
  const mail = mailer ?? createMailer({ config, fetchFn, log });
  const teamService = createTeamService({ repo: createTeamRepository(db), mailer: mail, sessions, config, log });

  const app = express();
  app.set('trust proxy', config.trustProxy ?? 0); // 0: ignora X-Forwarded-*; N: confia nos N proxies à frente (IP real do cliente)
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
          // Em http://localhost isso quebraria o carregamento dos recursos.
          'upgrade-insecure-requests': config.isProduction ? [] : null,
        },
      },
      frameguard: { action: 'deny' }, // coerente com frame-ancestors 'none' (navegadores antigos)
      strictTransportSecurity: config.isProduction,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // ---------- API ----------
  const api = express.Router();
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  // A configuração completa de uma campanha é maior que os demais corpos; o parser abaixo (10 kb) vale para o restante da API.
  api.use('/campaigns', express.json({ limit: '64kb' }));
  api.use(express.json({ limit: '10kb' }));
  api.use(sameOriginOnly);

  // Saúde para monitoramento/hospedagem: público e mínimo (não revela nada além de "ok"/"indisponível").
  api.get('/health', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch (err) {
      log.error('[health] banco indisponível:', err.code ?? err.message);
      res.status(503).json({ status: 'unavailable' });
    }
  });

  api.use(loadSession({ sessions, config }));

  const authRouter = createAuthRouter({ authService, sessions, config, limits });
  api.use('/auth', authRouter);

  // Retorno da autorização do TikTok: público (vem de outro site/aba), protegido pelo `state` de uso único.
  const tiktokCallbackRouter = createTiktokCallbackRouter({ service: tiktokService, limits });
  api.use('/tiktok', tiktokCallbackRouter);

  // Aceite de convite de colaborador: público (a pessoa ainda não tem conta), protegido pelo token de uso único do e-mail.
  const invitationsRouter = createInvitationsRouter({ service: teamService, sessions, config, limits });
  api.use('/invitations', invitationsRouter);

  // Tudo abaixo exige sessão + conta aprovada. Contas pendentes NÃO passam daqui.
  // `resolveWorkspace` define de quem são os dados (req.actor: o próprio usuário ou o dono do espaço, no caso de colaborador)
  // e as áreas liberadas; cada módulo exige a sua área (o dono da conta sempre tem todas).
  const protectedApi = express.Router();
  protectedApi.use(requireAuth, requireApproved, resolveWorkspace);
  const campaignsRouter = createCampaignsRouter({ campaigns, tiktok: tiktokService, creatives: creativesService, limits });
  protectedApi.use('/campaigns', requireArea('campaigns'), campaignsRouter);
  const proxiesRouter = createProxiesRouter({ service: proxiesService, limits });
  protectedApi.use('/proxies', requireArea('accounts'), proxiesRouter);
  // As áreas de cada rota do TikTok (contas, relatórios, lista de contas de anúncio) são exigidas dentro do próprio roteador.
  const tiktokRouter = createTiktokRouter({ service: tiktokService, limits });
  protectedApi.use('/tiktok', tiktokRouter);
  // Ver criativos serve a quem publica campanhas; enviar, renomear e excluir é de quem gerencia a biblioteca.
  const creativesRouter = createCreativesRouter({ service: creativesService, limits });
  protectedApi.use('/creatives', requireAreaByMethod({ read: ['creatives', 'campaigns'], write: ['creatives'] }), creativesRouter);
  // Equipe e administração: nunca para colaboradores (a administração usa a conta real da pessoa, não o espaço).
  const teamRouter = createTeamRouter({ service: teamService, limits });
  protectedApi.use('/team', requireOwner, teamRouter);
  protectedApi.use('/admin', requireAdmin, requireOwner, createAdminRouter({ users, sessions }));
  api.use(protectedApi);

  api.use(apiNotFound);
  app.use('/api', api);

  // ---------- Front-end estático (SPA) ----------
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      dotfiles: 'ignore',
      setHeaders: (res) => res.set('Cache-Control', config.isProduction ? 'public, max-age=300' : 'no-cache'),
    }),
  );
  // Regras de campanha compartilhadas com o servidor (somente leitura, sem dados sensíveis).
  app.use('/shared', express.static(SHARED_DIR, { index: false, dotfiles: 'ignore', setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  // Qualquer rota de navegação devolve o shell da SPA; o acesso aos dados é protegido pela API.
  app.get(/^\/(?!api\/)[^.]*$/, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use(errorHandler(log));

  return {
    app,
    authService,
    sessions,
    creativeStorage,
    creativeCleaner,
    close: () => {
      authRouter.stop();
      tiktokRouter.stop();
      proxiesRouter.stop();
      proxiesService.close();
      tiktokCallbackRouter.stop();
      creativesRouter.stop();
      teamRouter.stop();
      invitationsRouter.stop();
      campaignsRouter.stop();
    },
  };
}
