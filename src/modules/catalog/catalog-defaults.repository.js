import { toIso } from '../../db/helpers.js';

/** Anúncio padrão de cada catálogo. Toda consulta é escopada por user_id (cada pessoa vê e altera só o dela). */
export function createCatalogDefaultsRepository(db) {
  return {
    async get(userId, bcId, catalogId) {
      const { rows } = await db.query('SELECT config, video_creative_id, cover_creative_id, updated_at FROM catalog_defaults WHERE user_id = $1 AND bc_id = $2 AND catalog_id = $3', [userId, bcId, catalogId]);
      const row = rows[0];
      return row ? { config: row.config, videoCreativeId: row.video_creative_id, coverCreativeId: row.cover_creative_id, updatedAt: toIso(row.updated_at) } : null;
    },
    /** Cria ou substitui (um por pessoa e catálogo). */
    async save(userId, bcId, catalogId, { config, videoCreativeId = null, coverCreativeId = null }) {
      await db.query(
        `INSERT INTO catalog_defaults (user_id, bc_id, catalog_id, config, video_creative_id, cover_creative_id)
              VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (user_id, bc_id, catalog_id)
         DO UPDATE SET config = EXCLUDED.config, video_creative_id = EXCLUDED.video_creative_id, cover_creative_id = EXCLUDED.cover_creative_id, updated_at = now()`,
        [userId, bcId, catalogId, JSON.stringify(config), videoCreativeId, coverCreativeId],
      );
    },
    async remove(userId, bcId, catalogId) {
      const { rowCount } = await db.query('DELETE FROM catalog_defaults WHERE user_id = $1 AND bc_id = $2 AND catalog_id = $3', [userId, bcId, catalogId]);
      return rowCount > 0;
    },
  };
}
