import { Router } from 'express';
import { MAX_LABEL_BATCH, isAccountLabel } from '../../../shared/account-labels.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { badRequest, tooMany } from '../../lib/http-error.js';
import { asObject, parseId, parseText } from '../../lib/validation.js';

const PERIODS = new Set([7, 14, 30]);
const NUMERIC_ID_RE = /^\d{1,24}$/;
const TOKEN_RE = /^[\x21-\x7e]{16,512}$/; // ASCII imprimível, sem espaços

function parseBcId(value) {
  const bcId = typeof value === 'string' ? value.trim() : '';
  if (!NUMERIC_ID_RE.test(bcId)) throw badRequest('O ID da Business Center deve conter apenas números.');
  return bcId;
}

function parseToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!TOKEN_RE.test(token)) throw badRequest('Token de acesso inválido.');
  return token;
}

function parseOptionalBool(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badRequest(`${label} inválido.`);
  return value;
}

function parseAdvertiserId(value) {
  if (typeof value !== 'string' || !NUMERIC_ID_RE.test(value)) throw badRequest('Conta de anúncio inválida.');
  return value;
}

/** Corpo de "etiquetar contas": `{ advertiserIds: ['…'], label: 'agency' | null }` (null remove a etiqueta). */
function parseLabelRequest(body) {
  const { advertiserIds, label } = asObject(body);
  if (!Array.isArray(advertiserIds) || advertiserIds.length < 1 || advertiserIds.length > MAX_LABEL_BATCH) {
    throw badRequest(`Informe de 1 a ${MAX_LABEL_BATCH} contas de anúncio.`);
  }
  if (label !== null && !isAccountLabel(label)) throw badRequest('Etiqueta inválida.');
  return { advertiserIds: advertiserIds.map(parseAdvertiserId), label };
}

function parseDays(value) {
  const days = Number(value ?? 7);
  if (!PERIODS.has(days)) throw badRequest('Período inválido (use 7, 14 ou 30 dias).');
  return days;
}

/**
 * Todas as rotas exigem sessão + conta aprovada (montado em `protectedApi`).
 * - Cada usuário cadastra e gerencia as PRÓPRIAS Business Centers e consome os dados delas
 *   (mais as que o admin compartilhar com a equipe). As regras de dono/visibilidade ficam no serviço.
 * - Compartilhar uma BC com a equipe: somente admin.
 */
export function createTiktokRouter({ service, limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.tiktokRead ?? 120, windowMs: 60 * 1000 });
  const writeLimiter = new RateLimiter({ max: limits.tiktokWrite ?? 20, windowMs: 60 * 1000 });

  const throttle = (limiter) => (req, _res, next) => {
    const result = limiter.consume(String(req.user.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };
  const read = throttle(readLimiter);
  const write = [throttle(writeLimiter)];

  // ---------- Business Centers ----------
  router.get('/business-centers', read, async (req, res) => {
    res.json({ configured: service.isConfigured(), oauth: service.oauthInfo(req.user), businessCenters: await service.listBusinessCenters(req.user) });
  });

  router.post('/business-centers', ...write, async (req, res) => {
    service.ensureConfigured();
    const body = asObject(req.body);
    const businessCenter = await service.addBusinessCenter(req.user, {
      bcId: parseBcId(body.bcId),
      name: parseText(body.name, 'Nome'),
      accessToken: parseToken(body.accessToken),
      shared: parseOptionalBool(body.shared, 'Compartilhamento') ?? false,
    });
    res.status(201).json({ businessCenter });
  });

  router.patch('/business-centers/:id', ...write, async (req, res) => {
    service.ensureConfigured();
    const id = parseId(req.params.id);
    const body = asObject(req.body);
    const changes = {
      name: body.name === undefined ? undefined : parseText(body.name, 'Nome'),
      accessToken: body.accessToken === undefined || body.accessToken === '' ? undefined : parseToken(body.accessToken),
      shared: parseOptionalBool(body.shared, 'Compartilhamento'),
    };
    if (Object.values(changes).every((v) => v === undefined)) throw badRequest('Nada para atualizar.');
    res.json({ businessCenter: await service.updateBusinessCenter(req.user, id, changes) });
  });

  router.post('/business-centers/:id/sync', ...write, async (req, res) => {
    res.json({ businessCenter: await service.syncBusinessCenter(req.user, parseId(req.params.id)) });
  });

  // Etiqueta as contas de anúncio desta BC (ex.: "conta de agência"). Só o dono da BC ou o admin.
  router.patch('/business-centers/:id/advertisers', ...write, async (req, res) => {
    const { advertiserIds, label } = parseLabelRequest(req.body);
    res.json(await service.setAdvertiserLabels(req.user, parseId(req.params.id), advertiserIds, label));
  });

  router.delete('/business-centers/:id', ...write, async (req, res) => {
    await service.removeBusinessCenter(req.user, parseId(req.params.id));
    res.status(204).end();
  });

  // ---------- Conexão por link de autorização ----------
  // Gera o link (15 min, uso único) que o usuário abre onde está logado na Business Center do TikTok.
  router.post('/connect', ...write, async (req, res) => {
    const name = parseText(asObject(req.body).name, 'Nome da conexão', { min: 1, max: 80 });
    res.status(201).json(await service.startConnection(req.user, { name }));
  });

  // A tela consulta aqui até o TikTok devolver o resultado (só o dono enxerga a tentativa).
  router.get('/connect/:attemptId', read, async (req, res) => {
    res.json(await service.connectionStatus(req.user, req.params.attemptId));
  });

  // Cancelar invalida o link na hora.
  router.delete('/connect/:attemptId', ...write, async (req, res) => {
    await service.cancelConnection(req.user, req.params.attemptId);
    res.status(204).end();
  });

  // ---------- Dados consumidos pelo resto do sistema ----------
  router.get('/advertisers', read, async (req, res) => {
    res.json({ advertisers: await service.listAdvertisers(req.user) });
  });

  router.get('/advertisers/:advertiserId/campaigns', read, async (req, res) => {
    res.json(await service.campaigns(req.user, parseAdvertiserId(req.params.advertiserId)));
  });

  router.get('/advertisers/:advertiserId/report', read, async (req, res) => {
    res.json(await service.report(req.user, parseAdvertiserId(req.params.advertiserId), parseDays(req.query.days)));
  });

  router.get('/overview', read, async (req, res) => {
    res.json(await service.overview(req.user, parseDays(req.query.days)));
  });

  router.stop = () => {
    readLimiter.stop();
    writeLimiter.stop();
  };
  return router;
}

/**
 * Retorno da autorização do TikTok: `GET /api/tiktok/callback?auth_code=…&state=…`.
 * É PÚBLICO de propósito (o navegador chega aqui vindo do TikTok, possivelmente em outro perfil/aba sem a sessão do sistema,
 * e o cookie SameSite=Strict não acompanha). Quem valida é o `state` (aleatório, uso único, 15 min).
 * O resultado vai para uma página própria; nenhum dado da conta aparece na URL de resposta.
 */
export function createTiktokCallbackRouter({ service, limits = {} }) {
  const router = Router();
  const limiter = new RateLimiter({ max: limits.tiktokCallback ?? 30, windowMs: 15 * 60 * 1000 });
  const one = (value) => (typeof value === 'string' ? value : undefined); // parâmetro repetido (array) vira inválido

  router.get('/callback', async (req, res) => {
    const result = limiter.consume(req.ip);
    if (!result.allowed) throw tooMany(result.retryAfterSec);
    const { status } = await service.completeConnection({ state: one(req.query.state), authCode: one(req.query.auth_code), error: one(req.query.error) });
    res.set('Cache-Control', 'no-store');
    res.redirect(302, `/tiktok/connected?status=${status}`);
  });

  router.stop = () => limiter.stop();
  return router;
}
