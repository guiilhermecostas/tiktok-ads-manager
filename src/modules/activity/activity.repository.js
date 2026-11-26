import { toIso } from '../../db/helpers.js';

const toEntry = (row) => ({
  id: String(row.id), actorId: row.actor_id, actorName: row.actor_name, actorIsOwner: row.actor_is_owner, action: row.action,
  targetName: row.target_name ?? null, details: row.details ?? {}, createdAt: toIso(row.created_at),
});

/**
 * Registro de atividades. Toda consulta é escopada por `workspace_id` (o dono do espaço): um dono nunca enxerga o registro de outro.
 * O código só INSERE e LÊ; a única remoção é a limpeza dos registros antigos.
 */
export function createActivityRepository(db) {
  return {
    async insert({ workspaceId, actorId, actorName, actorIsOwner, action, targetName, details }) {
      await db.query(
        `INSERT INTO workspace_activity (workspace_id, actor_id, actor_name, actor_is_owner, action, target_name, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [workspaceId, actorId, actorName, actorIsOwner, action, targetName, JSON.stringify(details)],
      );
    },

    /** Página do registro, do mais novo para o mais antigo. `actions`: lista de ações permitidas (ou null = todas). */
    async list(workspaceId, { actorId = null, actions = null, since, limit, offset }) {
      const where = ['workspace_id = $1', 'created_at >= $2'];
      const params = [workspaceId, since.toISOString()];
      if (actorId !== null) {
        params.push(actorId);
        where.push(`actor_id = $${params.length}`);
      }
      if (actions) {
        params.push(actions);
        where.push(`action = ANY($${params.length}::text[])`);
      }
      const clause = where.join(' AND ');
      const total = (await db.query(`SELECT COUNT(*)::int AS total FROM workspace_activity WHERE ${clause}`, params)).rows[0].total;
      const { rows } = await db.query(
        `SELECT id, actor_id, actor_name, actor_is_owner, action, target_name, details, created_at FROM workspace_activity
          WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      );
      return { entries: rows.map(toEntry), total };
    },

    /** Quantas vezes cada pessoa fez cada ação desde `since` (a pessoa removida continua aparecendo, pelo nome copiado). */
    async summary(workspaceId, { since }) {
      const { rows } = await db.query(
        `SELECT actor_id, actor_name, bool_or(actor_is_owner) AS is_owner, action, COUNT(*)::int AS total, MAX(created_at) AS last_at
           FROM workspace_activity WHERE workspace_id = $1 AND created_at >= $2
          GROUP BY actor_id, actor_name, action`,
        [workspaceId, since.toISOString()],
      );
      return rows.map((r) => ({ actorId: r.actor_id, actorName: r.actor_name, isOwner: r.is_owner, action: r.action, total: r.total, lastAt: toIso(r.last_at) }));
    },

    /** Limpeza: apaga o que for mais antigo que `before`. Devolve quantas linhas saíram. */
    async purgeOlderThan(before) {
      const { rowCount } = await db.query('DELETE FROM workspace_activity WHERE created_at < $1', [before.toISOString()]);
      return rowCount;
    },
  };
}
