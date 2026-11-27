import { summarize, validateConfig } from '../../../shared/campaign-spec.js';
import { validationError } from '../../lib/http-error.js';
import { asObject } from '../../lib/validation.js';

/**
 * Campanha do assistente. Para salvar RASCUNHO basta a configuração ser bem formada e ter objetivo;
 * os campos obrigatórios só são exigidos na publicação. `lockedFrom`: campanha já publicada em alguma conta (o que já existe no TikTok não muda).
 */
export function parseWizardCampaign(body, { lockedFrom } = {}) {
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
