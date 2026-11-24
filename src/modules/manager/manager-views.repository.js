import { toIso } from '../../db/helpers.js';
import { normalizeViewConfig } from '../../../shared/manager-columns.js';

/** Visão pública. A configuração é revalidada ao sair do banco: nunca devolve algo fora do formato conhecido. */
function toView(row) {
  const config = normalizeViewConfig(typeof row.config === 'string' ? JSON.parse(row.config) : row.config);
  return config ? { id: row.id, name: row.name, isDefault: row.is_default === true, config, updatedAt: toIso(row.updated_at) } : null;
}

/** Visualizações salvas do Gerenciador. Todas as consultas são escopadas por pessoa (user_id): ninguém vê a visualização de outro. */
export function createManagerViewsRepository(db) {
  return {
    async list(userId) {
      const { rows } = await db.query('SELECT * FROM manager_views WHERE user_id = $1 ORDER BY is_default DESC, lower(name), id', [userId]);
      return rows.map(toView).filter(Boolean);
    },
    async get(userId, id) {
      const { rows } = await db.query('SELECT * FROM manager_views WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ? toView(rows[0]) : null;
    },
    async count(userId) {
      const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM manager_views WHERE user_id = $1', [userId]);
      return rows[0].n;
    },
    /** Cria; com `isDefault`, esta passa a ser a padrão (a anterior deixa de ser) na mesma transação. */
    async create(userId, { name, config, isDefault }) {
      return db.transaction(async (tx) => {
        if (isDefault) await tx.query('UPDATE manager_views SET is_default = false WHERE user_id = $1', [userId]);
        const { rows } = await tx.query('INSERT INTO manager_views (user_id, name, config, is_default) VALUES ($1, $2, $3::jsonb, $4) RETURNING id', [userId, name, JSON.stringify(config), Boolean(isDefault)]);
        return rows[0].id;
      });
    },
    async update(userId, id, { name, config, isDefault }) {
      return db.transaction(async (tx) => {
        const { rows } = await tx.query('SELECT id FROM manager_views WHERE user_id = $1 AND id = $2 FOR UPDATE', [userId, id]);
        if (!rows[0]) return false;
        if (isDefault === true) await tx.query('UPDATE manager_views SET is_default = false WHERE user_id = $1 AND id <> $2', [userId, id]);
        await tx.query(
          `UPDATE manager_views SET name = COALESCE($3, name), config = COALESCE($4::jsonb, config), is_default = COALESCE($5, is_default), updated_at = now()
            WHERE user_id = $1 AND id = $2`,
          [userId, id, name ?? null, config ? JSON.stringify(config) : null, isDefault ?? null],
        );
        return true;
      });
    },
    async remove(userId, id) {
      const { rowCount } = await db.query('DELETE FROM manager_views WHERE user_id = $1 AND id = $2', [userId, id]);
      return rowCount > 0;
    },
  };
}
