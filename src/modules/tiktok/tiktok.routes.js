import { Router } from 'express';
import { MAX_LABEL_BATCH, isAccountLabel } from '../../../shared/account-labels.js';
import { MAX_ACCOUNT_BASE_NAME, MAX_CREATE_ADVERTISERS, normalizeCountry, normalizeCurrency, normalizePromotionLink, normalizeTimezone } from '../../../shared/advertiser-create.js';
import { PIXEL_EVENT_NAME_MAX, isPixelEvent } from '../../../shared/pixel-events.js';
import { IDENTITY_NAME_MAX, IDENTITY_PHOTO_MAX_BYTES, LISTABLE_IDENTITY_TYPES } from '../../../shared/identity.js';
import { MAX_LINK_ADVERTISERS, PIXEL_LINK_ACTIONS, normalizePixelCode } from '../../../shared/pixel-link.js';
import { isIndustryFor } from '../../../shared/tiktok-industries.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { HttpError, badRequest, tooMany } from '../../lib/http-error.js';
import { readBody } from '../../lib/read-body.js';
import { asObject, parseEmail, parseId, parseText } from '../../lib/validation.js';
import { requireArea } from '../../middleware/workspace.js';

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

/** Código do pixel (o do Gerenciador de Eventos do TikTok). */
function parsePixelCode(value) {
  const code = normalizePixelCode(value);
  if (!code) throw badRequest('Código do pixel inválido (letras e números, como no Gerenciador de Eventos).');
  return code;
}

/** Corpo de "vincular pixel": BC do TikTok, código do pixel, 1 a MAX contas (IDs numéricos, sem repetição) e a ação. */
function parsePixelLinkRequest(body) {
  const b = asObject(body);
  if (!Array.isArray(b.advertiserIds) || b.advertiserIds.length < 1 || b.advertiserIds.length > MAX_LINK_ADVERTISERS) throw badRequest(`Escolha de 1 a ${MAX_LINK_ADVERTISERS} contas de anúncio.`);
  if (!PIXEL_LINK_ACTIONS.includes(b.action)) throw badRequest('Ação inválida: use vincular ou desvincular.');
  return { bcId: parseBcId(b.bcId), pixelCode: parsePixelCode(b.pixelCode), advertiserIds: [...new Set(b.advertiserIds.map(parseAdvertiserId))], action: b.action };
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

/**
 * Corpo de "criar contas de anúncio": BC do TikTok, quantidade (1 a MAX), nome base, moeda, fuso, empresa e país de registro;
 * opcionais: ramo de atividade (ID numérico do TikTok) e contato. Cada valor é validado aqui, nada é repassado "como veio".
 */
function parseCreateAdvertisersRequest(body) {
  const b = asObject(body);
  const count = b.count;
  if (!Number.isInteger(count) || count < 1 || count > MAX_CREATE_ADVERTISERS) throw badRequest(`A quantidade deve ser de 1 a ${MAX_CREATE_ADVERTISERS}.`);
  const currency = normalizeCurrency(b.currency);
  if (!currency) throw badRequest('Moeda inválida (use o código de 3 letras, ex.: USD ou BRL).');
  const timezone = normalizeTimezone(b.timezone);
  if (!timezone) throw badRequest('Fuso horário inválido: escolha um da lista do TikTok (ex.: America/Sao_Paulo).');
  const registeredArea = normalizeCountry(b.registeredArea);
  if (!registeredArea) throw badRequest('País de registro inválido: escolha um da lista do TikTok.');
  const hasValue = (value) => value !== undefined && value !== null && value !== '';
  // Ramo de atividade: o TikTok exige (ID numérico da tabela de ramos do TikTok). Aceita número ou texto só com dígitos.
  const rawIndustry = typeof b.industry === 'string' ? b.industry.trim() : b.industry;
  const industry = typeof rawIndustry === 'string' && /^\d{1,9}$/.test(rawIndustry) ? Number(rawIndustry) : rawIndustry;
  if (!Number.isSafeInteger(industry) || !isIndustryFor(industry, null)) throw badRequest('Escolha o ramo de atividade na lista do TikTok.');
  let promotionLink = null;
  if (hasValue(b.promotionLink)) {
    promotionLink = normalizePromotionLink(b.promotionLink);
    if (!promotionLink) throw badRequest('Site da empresa inválido (use um endereço http ou https, ex.: https://minhaempresa.com).');
  }
  return {
    bcId: parseBcId(b.bcId),
    count,
    name: parseText(b.name, 'Nome', { min: 2, max: MAX_ACCOUNT_BASE_NAME }),
    currency,
    timezone,
    company: parseText(b.company, 'Empresa', { min: 2, max: 255 }),
    registeredArea,
    industry,
    promotionLink,
    contactEmail: hasValue(b.contactEmail) ? parseEmail(b.contactEmail) : null,
    contactName: hasValue(b.contactName) ? parseText(b.contactName, 'Nome do contato', { min: 2, max: 100 }) : null,
  };
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
    const result = limiter.consume(String(req.actor.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };
  // Criar contas é irreversível por aqui e consome o limite do TikTok: poucos pedidos por 10 minutos, por usuário.
  const createLimiter = new RateLimiter({ max: limits.tiktokCreate ?? 6, windowMs: 10 * 60 * 1000 });
  // Vincular pixel altera ativos da Business Center no TikTok: limite próprio, por usuário.
  const pixelLinkLimiter = new RateLimiter({ max: limits.tiktokPixelLink ?? 30, windowMs: 10 * 60 * 1000 });
  // Criar identidade cria algo no TikTok e envia uma imagem: poucos pedidos por 10 minutos, por usuário.
  // Criar evento no pixel altera o pixel no TikTok: limite próprio, por usuário.
  const pixelEventLimiter = new RateLimiter({ max: limits.tiktokPixelEvent ?? 20, windowMs: 10 * 60 * 1000 });
  const identityLimiter = new RateLimiter({ max: limits.tiktokIdentity ?? 20, windowMs: 10 * 60 * 1000 });
  const read = throttle(readLimiter);
  const write = [throttle(writeLimiter)];
  // Permissões de colaborador (o dono sempre passa): gerenciar conexões = "accounts"; relatórios = "reports";
  // a lista de contas de anúncio também serve a quem publica campanhas.
  const accounts = requireArea('accounts');
  const reports = requireArea('reports');
  const anyAdvertiserArea = requireArea('accounts', 'campaigns', 'reports');

  // ---------- Business Centers ----------
  router.get('/business-centers', accounts, read, async (req, res) => {
    res.json({ configured: service.isConfigured(), oauth: service.oauthInfo(req.actor), businessCenters: await service.listBusinessCenters(req.actor) });
  });

  router.post('/business-centers', accounts, ...write, async (req, res) => {
    service.ensureConfigured();
    const body = asObject(req.body);
    const businessCenter = await service.addBusinessCenter(req.actor, {
      bcId: parseBcId(body.bcId),
      name: parseText(body.name, 'Nome'),
      accessToken: parseToken(body.accessToken),
      shared: parseOptionalBool(body.shared, 'Compartilhamento') ?? false,
    });
    res.status(201).json({ businessCenter });
  });

  router.patch('/business-centers/:id', accounts, ...write, async (req, res) => {
    service.ensureConfigured();
    const id = parseId(req.params.id);
    const body = asObject(req.body);
    const changes = {
      name: body.name === undefined ? undefined : parseText(body.name, 'Nome'),
      accessToken: body.accessToken === undefined || body.accessToken === '' ? undefined : parseToken(body.accessToken),
      shared: parseOptionalBool(body.shared, 'Compartilhamento'),
    };
    if (Object.values(changes).every((v) => v === undefined)) throw badRequest('Nada para atualizar.');
    res.json({ businessCenter: await service.updateBusinessCenter(req.actor, id, changes) });
  });

  router.post('/business-centers/:id/sync', accounts, ...write, async (req, res) => {
    res.json({ businessCenter: await service.syncBusinessCenter(req.actor, parseId(req.params.id)) });
  });

  // Etiqueta as contas de anúncio desta BC (ex.: "conta de agência"). Só o dono da BC ou o admin.
  router.patch('/business-centers/:id/advertisers', accounts, ...write, async (req, res) => {
    const { advertiserIds, label } = parseLabelRequest(req.body);
    res.json(await service.setAdvertiserLabels(req.actor, parseId(req.params.id), advertiserIds, label));
  });

  // Sugestões para o formulário "+ CA" (moeda, fuso, empresa… de uma conta que a BC já tem). ?bcId= é a BC do TikTok escolhida.
  router.get('/business-centers/:id/advertiser-defaults', accounts, read, async (req, res) => {
    res.json(await service.advertiserDefaults(req.actor, parseId(req.params.id), parseBcId(req.query.bcId)));
  });

  // Cria novas contas de anúncio dentro de uma Business Center do TikTok desta conexão. Só o dono da conexão ou o admin.
  router.post('/business-centers/:id/advertisers', accounts, ...write, throttle(createLimiter), async (req, res) => {
    res.status(201).json(await service.createAdvertisers(req.actor, parseId(req.params.id), parseCreateAdvertisersRequest(req.body)));
  });

  // Pixel × contas de anúncio (Gerenciador de Eventos → pixel → Ativos). Só o dono da conexão ou o admin.
  // GET ?bcId=&pixelCode= → { advertiserIds }: contas desta conexão que já têm o pixel vinculado.
  router.get('/business-centers/:id/pixel-links', accounts, read, async (req, res) => {
    res.json(await service.pixelLinks(req.actor, parseId(req.params.id), { bcId: parseBcId(req.query.bcId), pixelCode: parsePixelCode(req.query.pixelCode) }));
  });

  // POST { bcId, pixelCode, advertiserIds: [...], action: 'LINK' | 'UNLINK' }
  router.post('/business-centers/:id/pixel-links', accounts, ...write, throttle(pixelLinkLimiter), async (req, res) => {
    res.json(await service.updatePixelLinks(req.actor, parseId(req.params.id), parsePixelLinkRequest(req.body)));
  });

  router.delete('/business-centers/:id', accounts, ...write, async (req, res) => {
    await service.removeBusinessCenter(req.actor, parseId(req.params.id));
    res.status(204).end();
  });

  // ---------- Conexão por link de autorização ----------
  // Gera o link (15 min, uso único) que o usuário abre onde está logado na Business Center do TikTok.
  router.post('/connect', accounts, ...write, async (req, res) => {
    const name = parseText(asObject(req.body).name, 'Nome da conexão', { min: 1, max: 80 });
    res.status(201).json(await service.startConnection(req.actor, { name }));
  });

  // A tela consulta aqui até o TikTok devolver o resultado (só o dono enxerga a tentativa).
  router.get('/connect/:attemptId', accounts, read, async (req, res) => {
    res.json(await service.connectionStatus(req.actor, req.params.attemptId));
  });

  // Cancelar invalida o link na hora.
  router.delete('/connect/:attemptId', accounts, ...write, async (req, res) => {
    await service.cancelConnection(req.actor, req.params.attemptId);
    res.status(204).end();
  });

  // ---------- Dados consumidos pelo resto do sistema ----------
  router.get('/advertisers', anyAdvertiserArea, read, async (req, res) => {
    res.json({ advertisers: await service.listAdvertisers(req.actor) });
  });

  router.get('/advertisers/:advertiserId/campaigns', reports, read, async (req, res) => {
    res.json(await service.campaigns(req.actor, parseAdvertiserId(req.params.advertiserId)));
  });

  // Pixels já criados na conta (seletor do passo "Conversão"): quem publica campanhas ou gerencia as contas.
  router.get('/advertisers/:advertiserId/pixels', requireArea('campaigns', 'accounts'), read, async (req, res) => {
    res.json({ pixels: await service.pixels(req.actor, parseAdvertiserId(req.params.advertiserId), { fresh: req.query.fresh === '1' }) });
  });

  // Identidades que a conta pode usar no anúncio (seletor do passo "Anúncio"). ?type= CUSTOMIZED_USER | TT_USER | BC_AUTH_TT; ?fresh=1 ignora o cache.
  router.get('/advertisers/:advertiserId/identities', requireArea('campaigns', 'accounts'), read, async (req, res) => {
    const type = typeof req.query.type === 'string' ? req.query.type : 'CUSTOMIZED_USER';
    if (!LISTABLE_IDENTITY_TYPES.includes(type)) throw badRequest('Tipo de identidade inválido.');
    res.json({ identities: await service.identities(req.actor, parseAdvertiserId(req.params.advertiserId), { type, fresh: req.query.fresh === '1' }) });
  });

  // Cria uma identidade personalizada: o nome vai em ?name=; a foto (opcional) é o CORPO da requisição (image/jpeg ou image/png, quadrada, até 2 MB).
  // Sem foto, o corpo é JSON vazio. O servidor confere a imagem pelo conteúdo.
  router.post('/advertisers/:advertiserId/identities', requireArea('campaigns', 'accounts'), ...write, throttle(identityLimiter), async (req, res) => {
    const advertiserId = parseAdvertiserId(req.params.advertiserId);
    const name = parseText(req.query.name, 'Nome da identidade', { min: 1, max: IDENTITY_NAME_MAX });
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    let image = null;
    if (type === 'image/jpeg' || type === 'image/png') {
      const declared = Number(req.headers['content-length']);
      const tooLarge = () => new HttpError(413, 'A foto é grande demais (máximo 2 MB).', 'photo_too_large');
      if (Number.isFinite(declared) && declared > IDENTITY_PHOTO_MAX_BYTES) throw tooLarge(); // recusa antes de ler
      image = await readBody(req, IDENTITY_PHOTO_MAX_BYTES, tooLarge);
      if (!image.length) image = null;
    } else if (type !== 'application/json') {
      throw new HttpError(415, 'Envie a foto como JPG ou PNG (ou nenhuma foto).', 'unsupported_media_type');
    }
    res.status(201).json({ identity: await service.createIdentity(req.actor, advertiserId, { name, image }) });
  });

  // Cria um evento padrão no pixel da conta (para a campanha otimizar por ele): { pixelId, eventType, name? }.
  router.post('/advertisers/:advertiserId/pixel-events', requireArea('campaigns', 'accounts'), ...write, throttle(pixelEventLimiter), async (req, res) => {
    const body = asObject(req.body);
    if (typeof body.pixelId !== 'string' || !NUMERIC_ID_RE.test(body.pixelId)) throw badRequest('Pixel inválido.');
    if (!isPixelEvent(body.eventType)) throw badRequest('Tipo de evento inválido.');
    const name = body.name === undefined || body.name === null || body.name === '' ? '' : parseText(body.name, 'Nome do evento', { min: 1, max: PIXEL_EVENT_NAME_MAX });
    res.status(201).json(await service.createPixelEvent(req.actor, parseAdvertiserId(req.params.advertiserId), { pixelId: body.pixelId, eventType: body.eventType, name }));
  });

  router.get('/advertisers/:advertiserId/report', reports, read, async (req, res) => {
    res.json(await service.report(req.actor, parseAdvertiserId(req.params.advertiserId), parseDays(req.query.days)));
  });

  router.get('/overview', reports, read, async (req, res) => {
    const advertiserId = req.query.advertiserId === undefined || req.query.advertiserId === '' ? null : parseAdvertiserId(req.query.advertiserId);
    res.json(await service.overview(req.actor, parseDays(req.query.days), { advertiserId, compare: req.query.compare === '1' }));
  });

  router.stop = () => {
    readLimiter.stop();
    writeLimiter.stop();
    pixelLinkLimiter.stop();
    identityLimiter.stop();
    pixelEventLimiter.stop();
    createLimiter.stop();
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
