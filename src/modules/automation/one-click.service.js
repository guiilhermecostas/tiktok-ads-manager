import { summarize, validateConfig } from '../../../shared/campaign-spec.js';
import { copyNames, normalizeCopies } from '../../../shared/campaign-copies.js';
import { MAX_TEMPLATES, TEMPLATE_NAME_MAX, TEMPLATE_NAME_MIN } from '../../../shared/one-click.js';
import { isUniqueViolation } from '../../db/helpers.js';
import { HttpError, badRequest, notFound, validationError } from '../../lib/http-error.js';
import { asObject, parseText } from '../../lib/validation.js';

export { MAX_TEMPLATES };
const NAME_TAKEN = () => new HttpError(409, 'Você já tem uma configuração com este nome. Escolha outro nome.', 'template_name_taken');

/**
 * Campanha one-click: o dono monta UMA vez a configuração completa (campanha, grupo de anúncios e anúncio), dá um nome ("Campanha para o Brasil") e depois
 * publica em quantas contas quiser, quantas vezes quiser. Publicar cria uma campanha nova a partir do modelo (uma cópia) e a publicação em cada conta
 * usa a rota de sempre (`POST /api/campaigns/:id/publish`): mesmas travas, limites, criativos refeitos por conta e campanha sempre PAUSADA.
 */
export function createOneClickService({ repo, campaigns, creatives }) {
  /** Nome + configuração. O modelo só é salvo COMPLETO (todos os campos obrigatórios): o cartão tem de estar pronto para publicar. */
  async function parse(actor, body) {
    const data = asObject(body);
    const name = parseText(data.name, 'Nome da configuração', { min: TEMPLATE_NAME_MIN, max: TEMPLATE_NAME_MAX });
    const { config, errors } = validateConfig(data.config, { requireComplete: true });
    if (errors.length) throw validationError(errors);
    const refs = await creatives.verifyReferences(actor, config); // os criativos escolhidos precisam ser do próprio dono (nunca IDs de terceiros)
    if (refs.length) throw validationError(refs);
    return { name, objective: summarize(config).objective, config };
  }

  const guardName = async (action) => {
    try {
      return await action();
    } catch (err) {
      throw isUniqueViolation(err) ? NAME_TAKEN() : err;
    }
  };

  return {
    list: (actor) => repo.list(actor.id),

    async get(actor, id) {
      const template = await repo.get(actor.id, id);
      if (!template) throw notFound('Configuração não encontrada.');
      return template;
    },

    async create(actor, body) {
      const input = await parse(actor, body);
      if ((await repo.count(actor.id)) >= MAX_TEMPLATES) {
        throw new HttpError(409, `O limite é de ${MAX_TEMPLATES} configurações. Apague alguma que você não usa mais.`, 'template_limit');
      }
      return guardName(() => repo.create(actor.id, input));
    },

    async update(actor, id, body) {
      const input = await parse(actor, body);
      const updated = await guardName(() => repo.update(actor.id, id, input));
      if (!updated) throw notFound('Configuração não encontrada.');
      return updated;
    },

    async remove(actor, id) {
      if (!(await repo.remove(actor.id, id))) throw notFound('Configuração não encontrada.');
    },

    /**
     * Prepara uma publicação: cria as campanhas novas (rascunhos) a partir do modelo e as devolve. Com `count` > 1 são cópias IGUAIS com nome numerado ("Nome 01", "Nome 02"…),
     * para publicar várias campanhas idênticas de uma vez. A tela então publica cada uma, conta por conta, em /api/campaigns/:id/publish.
     * A configuração é conferida DE NOVO aqui (a especificação ou os criativos podem ter mudado desde que o modelo foi salvo).
     */
    async launch(actor, id, { count = 1 } = {}) {
      const copies = normalizeCopies(count);
      if (copies === null) throw badRequest('Escolha de 1 a 10 campanhas por conta.', 'copies_invalid');
      const template = await this.get(actor, id);
      const { config, errors } = validateConfig(template.config, { requireComplete: true });
      if (errors.length) throw validationError(errors);
      const missing = await creatives.verifyReferences(actor, config);
      if (missing.length) throw validationError(missing);
      const base = summarize(config).name ?? template.name;
      const created = [];
      for (const name of copyNames(base, copies)) {
        const copy = copies === 1 ? config : { ...config, campaign: { ...config.campaign, name } };
        const summary = summarize(copy);
        created.push(await campaigns.createWizard(actor.id, { name: summary.name ?? name, objective: summary.objective, dailyBudget: summary.dailyBudget, config: copy }));
      }
      return created;
    },
  };
}
