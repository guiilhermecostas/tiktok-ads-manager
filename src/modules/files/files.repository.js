import { toIso } from '../../db/helpers.js';

const toRecord = (row) => ({ id: row.id, name: row.name, ext: row.ext, size: row.size, uploadedBy: row.uploaded_by_name ?? null, uploadedById: row.uploaded_by ?? null, createdAt: toIso(row.created_at) });

/** Arquivos anexados de uma conta (dono do espaço). A lista NUNCA traz o conteúdo; tudo é filtrado por `owner_id`. */
export function createFilesRepository(db) {
  return {
    async list(ownerId) {
      const { rows } = await db.query(
        `SELECT f.id, f.name, f.ext, f.size, f.uploaded_by, f.created_at, u.name AS uploaded_by_name
           FROM workspace_files f LEFT JOIN users u ON u.id = f.uploaded_by
          WHERE f.owner_id = $1 ORDER BY f.created_at DESC, f.id DESC`,
        [ownerId],
      );
      return rows.map(toRecord);
    },
    async usage(ownerId) {
      const { rows } = await db.query('SELECT COUNT(*)::int AS count, COALESCE(SUM(size), 0)::bigint AS bytes FROM workspace_files WHERE owner_id = $1', [ownerId]);
      return { count: rows[0].count, bytes: Number(rows[0].bytes) };
    },
    /** `data` já vem CRIPTOGRAFADO pelo serviço. */
    async create(ownerId, { uploadedBy, name, ext, size, data }) {
      const { rows } = await db.query(
        'INSERT INTO workspace_files (owner_id, uploaded_by, name, ext, size, data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [ownerId, uploadedBy, name, ext, size, data],
      );
      return rows[0].id;
    },
    async get(ownerId, id) {
      const { rows } = await db.query('SELECT id, name, ext, size, data FROM workspace_files WHERE id = $1 AND owner_id = $2', [id, ownerId]);
      return rows[0] ?? null;
    },
    async remove(ownerId, id) {
      const { rowCount } = await db.query('DELETE FROM workspace_files WHERE id = $1 AND owner_id = $2', [id, ownerId]);
      return rowCount > 0;
    },
  };
}
