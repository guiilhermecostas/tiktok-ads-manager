import { MAX_HIDDEN_PER_USER } from '../../../shared/catalog-filters.js';
import { HttpError } from '../../lib/http-error.js';

/** Catálogos que cada pessoa ocultou da própria lista (só visual). Toda consulta é escopada por user_id. */
export function createCatalogHiddenRepository(db) {
  return {
    /** IDs dos catálogos que a pessoa ocultou. */
    async ids(userId) {
      const { rows } = await db.query('SELECT catalog_id FROM catalog_hidden WHERE user_id = $1', [userId]);
      return new Set(rows.map((r) => r.catalog_id));
    },

    /** Oculta (idempotente: o que já estava oculto não conta). Passando do limite por pessoa, recusa tudo. Devolve quantos ficaram ocultos agora. */
    async hide(userId, items) {
      const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM catalog_hidden WHERE user_id = $1', [userId]);
      if (rows[0].n + items.length > MAX_HIDDEN_PER_USER) {
        throw new HttpError(409, `Você já ocultou muitos catálogos (o máximo é ${MAX_HIDDEN_PER_USER}). Mostre alguns de volta para ocultar outros.`, 'too_many_hidden');
      }
      const { rowCount } = await db.query(
        `INSERT INTO catalog_hidden (user_id, bc_id, catalog_id)
         SELECT $1, t.bc_id, t.catalog_id FROM unnest($2::text[], $3::text[]) AS t(bc_id, catalog_id)
         ON CONFLICT (user_id, catalog_id) DO NOTHING`,
        [userId, items.map((i) => i.bcId), items.map((i) => i.catalogId)],
      );
      return rowCount;
    },

    /** Mostra de volta. Devolve quantos voltaram a aparecer. */
    async show(userId, catalogIds) {
      const { rowCount } = await db.query('DELETE FROM catalog_hidden WHERE user_id = $1 AND catalog_id = ANY($2::text[])', [userId, catalogIds]);
      return rowCount;
    },
  };
}
