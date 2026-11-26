import { ACTIONS, ACTIVITY_PAGE_SIZE, RETENTION_DAYS, actionsOfGroup, cleanTarget, normalizeActivityQuery, sanitizeDetails } from '../../../shared/activity.js';
import { badRequest } from '../../lib/http-error.js';

const DAY_MS = 86_400_000;

/**
 * Registro de atividades da equipe: guarda quem fez o quê (e quando) dentro do espaço de trabalho de um dono e mostra isso a ELE (só o dono lê).
 *  - `record` NUNCA lança: se não conseguir registrar, avisa no log do servidor e a ação da pessoa segue normalmente;
 *  - só ações do catálogo (`shared/activity.js`) e só os campos de detalhe permitidos são aceitos (nada de token, senha ou texto livre longo);
 *  - o nome de quem fez é guardado junto: mesmo se a pessoa for removida da equipe, o registro dela continua.
 */
export function createActivityService({ repo, log = console, now = () => new Date() }) {
  const sinceOf = (days) => new Date(now().getTime() - days * DAY_MS);

  return {
    /**
     * @param {{ workspaceId: number, actor: { id: number, name: string }, action: string, targetName?: string|null, details?: object }} entry
     * `workspaceId` é o dono do espaço; `actor` é a PESSOA que agiu (pode ser o próprio dono). Devolve true se registrou.
     */
    async record({ workspaceId, actor, action, targetName = null, details = {} }) {
      try {
        if (!ACTIONS[action] || !Number.isInteger(workspaceId) || !Number.isInteger(actor?.id)) return false;
        await repo.insert({
          workspaceId,
          actorId: actor.id,
          actorName: cleanTarget(actor.name) ?? 'Pessoa',
          actorIsOwner: actor.id === workspaceId,
          action,
          targetName: cleanTarget(targetName),
          details: sanitizeDetails(details),
        });
        return true;
      } catch (err) {
        log.warn?.(`[atividade] não foi possível registrar "${action}": ${err?.code ?? 'erro'}`); // sem dados da pessoa
        return false;
      }
    },

    /** Página do registro (do mais novo ao mais antigo) com os filtros do dono: pessoa, tipo de ação e período. */
    async list(owner, rawQuery) {
      const { value: q, errors } = normalizeActivityQuery(rawQuery);
      if (errors.length) throw badRequest(errors[0].message, 'validation_error');
      const { entries, total } = await repo.list(owner.id, {
        actorId: q.actorId,
        actions: q.group ? actionsOfGroup(q.group) : null,
        since: sinceOf(q.range),
        limit: ACTIVITY_PAGE_SIZE,
        offset: (q.page - 1) * ACTIVITY_PAGE_SIZE,
      });
      return { entries, total, page: q.page, pageSize: ACTIVITY_PAGE_SIZE, totalPages: Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE)), range: q.range };
    },

    /** Resumo por pessoa no período: quantas vezes fez cada ação, o total e a última atividade (para o dono medir o trabalho da equipe). */
    async summary(owner, rawQuery) {
      const { value: q, errors } = normalizeActivityQuery({ range: rawQuery?.range });
      if (errors.length) throw badRequest(errors[0].message, 'validation_error');
      const rows = await repo.summary(owner.id, { since: sinceOf(q.range) });
      const people = new Map();
      for (const row of rows) {
        const key = row.actorId ?? `removed:${row.actorName}`;
        const person = people.get(key) ?? { actorId: row.actorId, name: row.actorName, isOwner: row.isOwner, removed: row.actorId === null, total: 0, lastAt: null, counts: {} };
        person.counts[row.action] = (person.counts[row.action] ?? 0) + row.total;
        person.total += row.total;
        if (!person.lastAt || row.lastAt > person.lastAt) person.lastAt = row.lastAt;
        people.set(key, person);
      }
      return { range: q.range, people: [...people.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'pt-BR')) };
    },

    /** Apaga o que tem mais de um ano (rodado junto da limpeza periódica do servidor). */
    purge() {
      return repo.purgeOlderThan(sinceOf(RETENTION_DAYS));
    },
  };
}
