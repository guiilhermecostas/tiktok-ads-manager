import { toIso } from '../../db/helpers.js';

/** Todas as consultas são escopadas por user_id: ninguém acessa criativo de outro usuário. */

/** Visão pública do criativo (nunca expõe storage_key nem hashes). */
function toCreative(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    source: row.source,
    originalFilename: row.original_filename ?? null,
    mimeType: row.mime_type ?? null,
    sizeBytes: row.size_bytes ?? null,
    hasFile: row.storage_key !== null && row.storage_key !== undefined,
    tiktokAdvertisers: row.tiktok_advertisers ?? [],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const SELECT = `
  SELECT c.*,
         COALESCE((SELECT array_agg(a.advertiser_id ORDER BY a.advertiser_id) FROM creative_tiktok_assets a WHERE a.creative_id = c.id), '{}') AS tiktok_advertisers
    FROM creatives c`;

/** Escapa % _ \ para uso em ILIKE (o texto do usuário é dado, nunca padrão). */
const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export function createCreativesRepository(db) {
  return {
    async list(userId, { kind, q, limit = 60, offset = 0 } = {}) {
      const where = ['c.user_id = $1'];
      const params = [userId];
      if (kind) {
        params.push(kind);
        where.push(`c.kind = $${params.length}`);
      }
      if (q) {
        params.push(`%${escapeLike(q)}%`);
        where.push(`c.name ILIKE $${params.length}`);
      }
      const clause = where.join(' AND ');
      const total = (await db.query(`SELECT COUNT(*)::int AS total FROM creatives c WHERE ${clause}`, params)).rows[0].total;
      const { rows } = await db.query(`${SELECT} WHERE ${clause} ORDER BY c.created_at DESC, c.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);
      return { creatives: rows.map(toCreative), total };
    },

    async get(userId, id) {
      const { rows } = await db.query(`${SELECT} WHERE c.user_id = $1 AND c.id = $2`, [userId, id]);
      return rows[0] ? toCreative(rows[0]) : null;
    },

    /** Linha completa, INCLUINDO storage_key e md5: uso interno do servidor (servir arquivo, enviar ao TikTok). */
    async getInternal(userId, id) {
      const { rows } = await db.query('SELECT * FROM creatives WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ?? null;
    },

    async getManyInternal(userId, ids) {
      if (!ids.length) return [];
      const { rows } = await db.query('SELECT * FROM creatives WHERE user_id = $1 AND id = ANY($2::int[])', [userId, ids]);
      return rows;
    },

    async findByHash(userId, sha256) {
      const { rows } = await db.query('SELECT id, name FROM creatives WHERE user_id = $1 AND sha256 = $2', [userId, sha256]);
      return rows[0] ?? null;
    },

    async usedBytes(userId) {
      const { rows } = await db.query('SELECT COALESCE(SUM(size_bytes), 0)::bigint AS used FROM creatives WHERE user_id = $1', [userId]);
      return Number(rows[0].used);
    },

    async createUpload(userId, { name, kind, originalFilename, mimeType, sizeBytes, sha256, md5, storageKey }) {
      const { rows } = await db.query(
        `INSERT INTO creatives (user_id, name, kind, source, original_filename, mime_type, size_bytes, sha256, md5, storage_key)
         VALUES ($1, $2, $3, 'upload', $4, $5, $6, $7, $8, $9) RETURNING id`,
        [userId, name, kind, originalFilename, mimeType, sizeBytes, sha256, md5, storageKey],
      );
      return rows[0].id;
    },

    /** Referência a um criativo que já existe na conta do TikTok (sem arquivo guardado aqui). */
    async createTikTokReference(userId, { name, kind, advertiserId, tiktokId }) {
      return db.transaction(async (tx) => {
        const { rows } = await tx.query("INSERT INTO creatives (user_id, name, kind, source) VALUES ($1, $2, $3, 'tiktok') RETURNING id", [userId, name, kind]);
        await tx.query('INSERT INTO creative_tiktok_assets (creative_id, advertiser_id, tiktok_id) VALUES ($1, $2, $3)', [rows[0].id, advertiserId, tiktokId]);
        return rows[0].id;
      });
    },

    async rename(userId, id, name) {
      const { rowCount } = await db.query('UPDATE creatives SET name = $1, updated_at = now() WHERE user_id = $2 AND id = $3', [name, userId, id]);
      return rowCount > 0;
    },

    /** Remove e devolve a linha apagada (o serviço precisa da storage_key para apagar o arquivo). */
    async remove(userId, id) {
      const { rows } = await db.query('DELETE FROM creatives WHERE user_id = $1 AND id = $2 RETURNING *', [userId, id]);
      return rows[0] ?? null;
    },

    // ---- IDs que o TikTok deu a cada criativo, por conta de anúncio ----
    async findAsset(creativeId, advertiserId) {
      const { rows } = await db.query('SELECT tiktok_id FROM creative_tiktok_assets WHERE creative_id = $1 AND advertiser_id = $2', [creativeId, advertiserId]);
      return rows[0]?.tiktok_id ?? null;
    },
    async saveAsset(creativeId, advertiserId, tiktokId) {
      await db.query(
        `INSERT INTO creative_tiktok_assets (creative_id, advertiser_id, tiktok_id) VALUES ($1, $2, $3)
         ON CONFLICT (creative_id, advertiser_id) DO UPDATE SET tiktok_id = EXCLUDED.tiktok_id`,
        [creativeId, advertiserId, tiktokId],
      );
    },

    /** Campanhas ainda NÃO publicadas (rascunho/parcial) do usuário que usam este criativo. */
    async findDraftCampaignsUsing(userId, id) {
      const { rows } = await db.query(
        `SELECT id, name FROM campaigns
          WHERE user_id = $1 AND tiktok_ad_id IS NULL AND config IS NOT NULL
            AND (   config #>> '{ad,videoCreativeId}' = $2::text
                 OR config #>> '{ad,coverCreativeId}' = $2::text
                 OR COALESCE(config #> '{ad,imageCreativeIds}', '[]'::jsonb) @> to_jsonb($2::int))
          ORDER BY id LIMIT 6`,
        [userId, id],
      );
      return rows;
    },
  };
}
