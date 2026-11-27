import { toIso } from '../../db/helpers.js';

const toTemplate = (row) => ({
  id: row.id, name: row.name, objective: row.objective, config: row.config, createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
});

/**
 * Modelos de campanha "one-click". TODA consulta é escopada por `owner_id` (o dono do espaço): um dono nunca enxerga nem altera os modelos de outro.
 * Os valores sempre vão como parâmetros ($1…), nunca dentro do texto do SQL.
 */
export function createOneClickRepository(db) {
  return {
    async list(ownerId) {
      const { rows } = await db.query('SELECT * FROM campaign_templates WHERE owner_id = $1 ORDER BY created_at DESC, id DESC', [ownerId]);
      return rows.map(toTemplate);
    },
    async get(ownerId, id) {
      const { rows } = await db.query('SELECT * FROM campaign_templates WHERE owner_id = $1 AND id = $2', [ownerId, id]);
      return rows[0] ? toTemplate(rows[0]) : null;
    },
    async count(ownerId) {
      const { rows } = await db.query('SELECT COUNT(*)::int AS total FROM campaign_templates WHERE owner_id = $1', [ownerId]);
      return rows[0].total;
    },
    async create(ownerId, { name, objective, config }) {
      const { rows } = await db.query(
        'INSERT INTO campaign_templates (owner_id, name, objective, config) VALUES ($1, $2, $3, $4::jsonb) RETURNING *',
        [ownerId, name, objective, JSON.stringify(config)],
      );
      return toTemplate(rows[0]);
    },
    async update(ownerId, id, { name, objective, config }) {
      const { rows } = await db.query(
        `UPDATE campaign_templates SET name = $3, objective = $4, config = $5::jsonb, updated_at = now()
          WHERE owner_id = $1 AND id = $2 RETURNING *`,
        [ownerId, id, name, objective, JSON.stringify(config)],
      );
      return rows[0] ? toTemplate(rows[0]) : null;
    },
    async remove(ownerId, id) {
      const { rowCount } = await db.query('DELETE FROM campaign_templates WHERE owner_id = $1 AND id = $2', [ownerId, id]);
      return rowCount > 0;
    },
  };
}
