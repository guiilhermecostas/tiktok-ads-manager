import { Router } from 'express';
import { summarize, validateConfig } from '../../../shared/campaign-spec.js';
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
    // Níveis já criados no TikTok não podem mais mudar (a publicação parcial é retomada, não refeita).
    incoming = { ...(typeof incoming === 'object' && incoming ? incoming : {}) };
    if (lockedFrom.publish.campaignId) {
      incoming.campaign = lockedFrom.config.campaign;
      incoming.account = lockedFrom.config.account;
    }
    if (lockedFrom.publish.adGroupId) incoming.adGroup = lockedFrom.config.adGroup;
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
    advertiserId: config.account.advertiserId ?? null,
  };
}

/**
 * Rotas de campanhas (sessão + conta aprovada já garantidas pelo roteador pai).
 * Cada usuário só enxerga as próprias campanhas.
 */
export function createCampaignsRouter({ campaigns, tiktok, creatives, limits = {} }) {
  const router = Router();
  const publishLimiter = new RateLimiter({ max: limits.campaignPublish ?? 10, windowMs: 60 * 1000 });
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
    if (current.publish.status === 'published') {
      throw new HttpError(409, 'Esta campanha já foi publicada no TikTok e não pode mais ser editada aqui.', 'already_published');
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
   * Publica no TikTok (Campanha → Grupo de anúncios → Anúncio), sempre PAUSADA.
   * Exige `confirm: true`. Se um nível falhar, os já criados ficam registrados e a próxima chamada retoma de onde parou.
   */
  router.post('/:id/publish', async (req, res) => {
    const limit = publishLimiter.consume(String(req.user.id));
    if (!limit.allowed) throw tooMany(limit.retryAfterSec);
    if (asObject(req.body).confirm !== true) throw badRequest('Confirme a publicação.', 'confirmation_required');

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
      if (current.publish.status === 'published') throw new HttpError(409, 'Esta campanha já foi publicada no TikTok.', 'already_published');

      // Valida tudo de novo, no servidor, com todos os campos obrigatórios.
      const { config, errors } = validateConfig(current.config, { requireComplete: true, publish: true });
      if (errors.length) throw validationError(errors);

      const progress = { ...current.publish };
      const persist = (extra) =>
        campaigns.saveProgress(req.user.id, id, {
          campaignId: progress.campaignId,
          adGroupId: progress.adGroupId,
          adId: progress.adId,
          status: current.status,
          ...extra,
        });

      try {
        // Criativos primeiro: se o envio de algum arquivo falhar, NADA foi criado no TikTok ainda.
        await assertCreativesOwned(req.user, config);
        const assets = await creatives.resolveForPublish({ actor: req.user, advertiserId: config.account.advertiserId, config });
        await tiktok.publishCampaign({
          actor: req.user,
          advertiserId: config.account.advertiserId,
          config,
          assets,
          existing: progress,
          onCreated: async (level, createdId) => {
            progress[{ campaign: 'campaignId', adGroup: 'adGroupId', ad: 'adId' }[level]] = createdId;
            await persist({ error: null }); // grava a cada nível para não perder o que já foi criado
          },
        });
      } catch (err) {
        const created = err.createdIds ?? {};
        Object.assign(progress, {
          campaignId: created.campaignId ?? progress.campaignId,
          adGroupId: created.adGroupId ?? progress.adGroupId,
          adId: created.adId ?? progress.adId,
        });
        await persist({ error: (err instanceof HttpError ? err.message : 'Falha inesperada ao publicar.').slice(0, 300) });
        throw err;
      }

      // Tudo criado: a campanha local passa a "pausada" (é assim que nasce no TikTok).
      res.json({ campaign: await persist({ error: null, publishedAt: new Date().toISOString(), status: 'paused' }) });
    } finally {
      publishing.delete(key);
    }
  });

  router.stop = () => publishLimiter.stop();
  return router;
}
