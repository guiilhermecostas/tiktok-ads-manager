import { Router } from 'express';
import { applyAccountOverrides, summarize, validateConfig } from '../../../shared/campaign-spec.js';
import { CAMPAIGN_OBJECTIVES, CAMPAIGN_STATUSES } from '../../db/constants.js';
import { HttpError, badRequest, notFound, tooMany, validationError } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { asObject, parseCents, parseEnum, parseId, parseText } from '../../lib/validation.js';

/** API simples (anterior ao assistente): continua aceita para compatibilidade. */
function parseLegacyCampaign(body) {
  const data = asObject(body);
  return {
    name: parseText(data.name, 'Nome da campanha', { min: 2, max: 100 }),
    objective: parseEnum(data.objective, CAMPAIGN_OBJECTIVES, 'Objetivo'),
    dailyBudget: parseCents(data.dailyBudget, 'Orçamento diário'),
    status: parseEnum(data.status ?? 'draft', CAMPAIGN_STATUSES, 'Status'),
  };
}

/**
 * Campanha do assistente. Para salvar RASCUNHO basta a configuração ser bem formada e ter objetivo;
 * os campos obrigatórios só são exigidos na publicação.
 */
function parseWizardCampaign(body, { lockedFrom } = {}) {
  const data = asObject(body);
  let incoming = data.config;
  if (lockedFrom) {
    // O que já foi criado no TikTok (em qualquer conta) não pode mais mudar: a mesma configuração vale para todas as contas
    // e a publicação parcial é retomada, não refeita.
    const { locks } = lockedFrom.publish;
    incoming = { ...(typeof incoming === 'object' && incoming ? incoming : {}) };
    if (locks.campaign) incoming.campaign = lockedFrom.config.campaign;
    if (locks.adGroup) incoming.adGroup = lockedFrom.config.adGroup;
    if (locks.ad) incoming.ad = lockedFrom.config.ad;
  }
  const { config, errors } = validateConfig(incoming, { requireComplete: false });
  if (!config.campaign.objective) errors.push({ path: 'campaign.objective', message: 'Escolha o objetivo da campanha.' });
  if (errors.length) throw validationError(errors);
  const summary = summarize(config);
  return {
    name: summary.name ?? 'Rascunho sem nome',
    objective: summary.objective,
    dailyBudget: summary.dailyBudget,
    config,
  };
}

const ADVERTISER_ID_RE = /^\d{1,24}$/;

/**
 * Ajustes por conta: o que vale para o grupo de anúncios fica travado depois que o grupo existe no TikTok
 * (o servidor mantém o que foi usado na criação); o nível do anúncio ainda pode ser corrigido.
 */
function lockCreatedLevels(overrides, existing) {
  if (!existing?.tiktokAdGroupId) return overrides;
  const next = { ...overrides };
  if (existing.overrides?.adGroup) next.adGroup = existing.overrides.adGroup;
  else delete next.adGroup;
  return next;
}

/**
 * Rotas de campanhas (sessão + conta aprovada já garantidas pelo roteador pai).
 * Cada usuário só enxerga as próprias campanhas.
 */
export function createCampaignsRouter({ campaigns, tiktok, creatives, limits = {} }) {
  const router = Router();
  // Cada conta de anúncio é uma chamada de publicação: o limite comporta lotes de várias contas.
  const publishLimiter = new RateLimiter({ max: limits.campaignPublish ?? 30, windowMs: 60 * 1000 });
  // Campanhas com publicação em andamento (instância única). Evita criar itens duplicados no TikTok quando chegam
  // duas publicações simultâneas (duplo clique, duas abas) e impede editar/excluir no meio do processo.
  const publishing = new Set();
  const lockKey = (userId, id) => `${userId}:${id}`;
  const rejectIfPublishing = (userId, id) => {
    if (publishing.has(lockKey(userId, id))) {
      throw new HttpError(409, 'Esta campanha está sendo publicada agora. Aguarde a conclusão.', 'publish_in_progress');
    }
  };

  router.get('/summary', async (req, res) => {
    res.json({ summary: await campaigns.summary(req.user.id) });
  });

  router.get('/', async (req, res) => {
    res.json({ campaigns: await campaigns.list(req.user.id) });
  });

  /** Os criativos escolhidos precisam ser do próprio usuário (e do tipo certo): nunca aceite IDs de terceiros. */
  const assertCreativesOwned = async (user, config) => {
    const errors = await creatives.verifyReferences(user, config);
    if (errors.length) throw validationError(errors);
  };

  router.post('/', async (req, res) => {
    const body = asObject(req.body);
    if (body.config === undefined) {
      res.status(201).json({ campaign: await campaigns.create(req.user.id, parseLegacyCampaign(body)) });
      return;
    }
    const parsed = parseWizardCampaign(body);
    await assertCreativesOwned(req.user, parsed.config);
    res.status(201).json({ campaign: await campaigns.createWizard(req.user.id, parsed) });
  });

  router.get('/:id', async (req, res) => {
    const campaign = await campaigns.get(req.user.id, parseId(req.params.id));
    if (!campaign) throw notFound('Campanha não encontrada.');
    res.json({ campaign });
  });

  router.put('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    rejectIfPublishing(req.user.id, id);
    const body = asObject(req.body);
    const current = await campaigns.get(req.user.id, id);
    if (!current) throw notFound('Campanha não encontrada.');

    if (body.config === undefined) {
      if (current.wizard) throw badRequest('Esta campanha usa o assistente: envie a configuração completa.', 'wizard_required');
      res.json({ campaign: await campaigns.update(req.user.id, id, parseLegacyCampaign(body)) });
      return;
    }
    if (!current.wizard) throw badRequest('Campanhas simples não podem ser convertidas pelo assistente.', 'legacy_campaign');
    if (current.publish.locks.ad) {
      throw new HttpError(409, 'Esta campanha já foi publicada no TikTok e não pode mais ser editada aqui. Para mudar o anúncio, crie uma nova campanha.', 'already_published');
    }
    const parsed = parseWizardCampaign(body, { lockedFrom: current });
    await assertCreativesOwned(req.user, parsed.config);
    res.json({ campaign: await campaigns.updateWizard(req.user.id, id, parsed) });
  });

  router.delete('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    rejectIfPublishing(req.user.id, id);
    if (!(await campaigns.remove(req.user.id, id))) throw notFound('Campanha não encontrada.');
    res.status(204).end();
  });

  /**
   * Publica a campanha no TikTok em UMA conta de anúncio (Campanha → Grupo de anúncios → Anúncio), sempre PAUSADA.
   * Para várias contas, o cliente chama esta rota uma vez por conta: cada uma tem progresso, erro e retomada próprios,
   * e a falha de uma não impede as outras. Corpo: { confirm: true, advertiserId, overrides? } — `overrides` são os IDs
   * próprios daquela conta (pixel, app, catálogo, formulário, identidade).
   */
  router.post('/:id/publish', async (req, res) => {
    const limit = publishLimiter.consume(String(req.user.id));
    if (!limit.allowed) throw tooMany(limit.retryAfterSec);
    const body = asObject(req.body);
    if (body.confirm !== true) throw badRequest('Confirme a publicação.', 'confirmation_required');
    const advertiserId = typeof body.advertiserId === 'string' ? body.advertiserId.trim() : '';
    if (!ADVERTISER_ID_RE.test(advertiserId)) throw badRequest('Escolha a conta de anúncio onde publicar.', 'advertiser_required');

    const id = parseId(req.params.id);
    // A trava é adquirida ANTES de qualquer await (verificar + registrar no mesmo "tick"): o acesso ao banco é
    // assíncrono, e uma segunda requisição não pode passar pela verificação enquanto a primeira ainda está lendo.
    rejectIfPublishing(req.user.id, id);
    const key = lockKey(req.user.id, id);
    publishing.add(key);
    try {
      const current = await campaigns.get(req.user.id, id);
      if (!current) throw notFound('Campanha não encontrada.');
      if (!current.wizard) throw badRequest('Somente campanhas criadas pelo assistente podem ser publicadas.', 'legacy_campaign');

      // A conta precisa ser de uma Business Center do usuário (ou compartilhada com ele): 404 se não for.
      await tiktok.assertAdvertiserAccess(req.user, advertiserId);
      const existing = await campaigns.getPublication(req.user.id, id, advertiserId);
      if (existing?.status === 'published') throw new HttpError(409, 'Esta campanha já foi publicada nesta conta de anúncio.', 'already_published');

      // Configuração da campanha + ajustes desta conta, validada de novo no servidor com todos os campos obrigatórios.
      const incoming = applyAccountOverrides(current.config, body.overrides);
      if (incoming.errors.length) throw validationError(incoming.errors);
      const overrides = lockCreatedLevels(incoming.overrides, existing);
      const { config, errors } = validateConfig(applyAccountOverrides(current.config, overrides).config, { requireComplete: true });
      if (errors.length) throw validationError(errors);

      const progress = {
        tiktokCampaignId: existing?.tiktokCampaignId ?? null,
        tiktokAdGroupId: existing?.tiktokAdGroupId ?? null,
        tiktokAdId: existing?.tiktokAdId ?? null,
      };
      const persist = (extra) =>
        campaigns.saveProgress(req.user.id, id, advertiserId, { overrides: Object.keys(overrides).length ? overrides : null, ...progress, ...extra });

      try {
        // Criativos primeiro: se o envio de algum arquivo falhar, NADA foi criado no TikTok ainda.
        await assertCreativesOwned(req.user, config);
        const assets = await creatives.resolveForPublish({ actor: req.user, campaignId: id, advertiserId, config });
        await tiktok.publishCampaign({
          actor: req.user,
          advertiserId,
          config,
          assets,
          existing: { campaignId: progress.tiktokCampaignId, adGroupId: progress.tiktokAdGroupId, adId: progress.tiktokAdId },
          onCreated: async (level, createdId) => {
            progress[{ campaign: 'tiktokCampaignId', adGroup: 'tiktokAdGroupId', ad: 'tiktokAdId' }[level]] = createdId;
            await persist({ error: null }); // grava a cada nível para não perder o que já foi criado
          },
        });
      } catch (err) {
        const created = err.createdIds ?? {};
        progress.tiktokCampaignId = created.campaignId ?? progress.tiktokCampaignId;
        progress.tiktokAdGroupId = created.adGroupId ?? progress.tiktokAdGroupId;
        progress.tiktokAdId = created.adId ?? progress.tiktokAdId;
        await persist({ error: (err instanceof HttpError ? err.message : 'Falha inesperada ao publicar.').slice(0, 300) });
        throw err;
      }

      // Tudo criado nesta conta: a campanha local passa a "pausada" (é assim que nasce no TikTok).
      const publication = await persist({ error: null, publishedAt: new Date().toISOString() });
      res.json({ campaign: await campaigns.setStatus(req.user.id, id, 'paused'), publication });
    } finally {
      publishing.delete(key);
    }
  });

  router.stop = () => publishLimiter.stop();
  return router;
}
