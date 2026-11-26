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
    folderId: row.folder_id ?? null, // pasta (oferta) em que o criativo está; nulo = sem pasta
    aiGenerated: row.ai_generated === true, // contém trecho gerado por IA (hook): lembrar da divulgação de conteúdo de IA do TikTok
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
    /** Quantos criativos o dono enviou entre `from` e `to` (por tipo) e os nomes dos 5 mais recentes: usado pelo assistente do Início. */
    async countBetween(userId, from, to) {
      const { rows } = await db.query(
        `SELECT kind, COUNT(*)::int AS total FROM creatives WHERE user_id = $1 AND source = 'upload' AND created_at >= $2 AND created_at < $3 GROUP BY kind`,
        [userId, from.toISOString(), to.toISOString()],
      );
      const latest = await db.query(
        `SELECT name FROM creatives WHERE user_id = $1 AND source = 'upload' AND created_at >= $2 AND created_at < $3 ORDER BY created_at DESC, id DESC LIMIT 5`,
        [userId, from.toISOString(), to.toISOString()],
      );
      const count = (kind) => rows.find((r) => r.kind === kind)?.total ?? 0;
      return { total: count('image') + count('video'), images: count('image'), videos: count('video'), latest: latest.rows.map((r) => r.name) };
    },
    /** `folderId`: número = só essa pasta; 'none' = só os sem pasta; ausente = todos. */
    async list(userId, { kind, q, folderId, limit = 60, offset = 0 } = {}) {
      const where = ['c.user_id = $1'];
      const params = [userId];
      if (folderId === 'none') where.push('c.folder_id IS NULL');
      else if (folderId !== undefined && folderId !== null) {
        params.push(folderId);
        where.push(`c.folder_id = $${params.length}`);
      }
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

    async createUpload(userId, { name, kind, originalFilename, mimeType, sizeBytes, sha256, md5, storageKey, aiGenerated = false, folderId = null }) {
      // A pasta só vale se for DESTE usuário (a própria instrução confere: nunca grava a pasta de outra pessoa).
      const { rows } = await db.query(
        `INSERT INTO creatives (user_id, name, kind, source, original_filename, mime_type, size_bytes, sha256, md5, storage_key, ai_generated, folder_id)
         VALUES ($1, $2, $3, 'upload', $4, $5, $6, $7, $8, $9, $10, (SELECT id FROM creative_folders WHERE id = $11 AND user_id = $1)) RETURNING id`,
        [userId, name, kind, originalFilename, mimeType, sizeBytes, sha256, md5, storageKey, aiGenerated, folderId],
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

    // ---------- pastas ----------
    /** Pastas do usuário com quantos criativos há em cada uma, mais os totais (todos e sem pasta). */
    async folders(userId) {
      const { rows } = await db.query(
        `SELECT f.id, f.name, f.created_at, COUNT(c.id)::int AS total
           FROM creative_folders f LEFT JOIN creatives c ON c.folder_id = f.id AND c.user_id = f.user_id
          WHERE f.user_id = $1 GROUP BY f.id ORDER BY lower(f.name), f.id`,
        [userId],
      );
      const counts = (await db.query('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE folder_id IS NULL)::int AS unfiled FROM creatives WHERE user_id = $1', [userId])).rows[0];
      return { folders: rows.map((r) => ({ id: r.id, name: r.name, count: r.total, createdAt: toIso(r.created_at) })), total: counts.total, unfiledCount: counts.unfiled };
    },
    async getFolder(userId, id) {
      const { rows } = await db.query('SELECT id, name FROM creative_folders WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ?? null;
    },
    async countFolders(userId) {
      const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM creative_folders WHERE user_id = $1', [userId]);
      return rows[0].n;
    },
    async createFolder(userId, name) {
      const { rows } = await db.query('INSERT INTO creative_folders (user_id, name) VALUES ($1, $2) RETURNING id', [userId, name]);
      return rows[0].id;
    },
    async renameFolder(userId, id, name) {
      const { rowCount } = await db.query('UPDATE creative_folders SET name = $3, updated_at = now() WHERE user_id = $1 AND id = $2', [userId, id, name]);
      return rowCount > 0;
    },
    /** Apaga a pasta; os criativos dela ficam sem pasta (devolve quantos eram, ou null se a pasta não existe). */
    async deleteFolder(userId, id) {
      return db.transaction(async (tx) => {
        const { rows } = await tx.query('SELECT COUNT(*)::int AS n FROM creatives WHERE user_id = $1 AND folder_id = $2', [userId, id]);
        const { rowCount } = await tx.query('DELETE FROM creative_folders WHERE user_id = $1 AND id = $2', [userId, id]);
        return rowCount > 0 ? rows[0].n : null;
      });
    },
    /**
     * Move criativos para uma pasta (ou, com `folderId` nulo, para "sem pasta"), TUDO OU NADA em uma instrução: se algum ID não for do
     * usuário (ou a pasta não for dele), nada muda e devolve 0.
     */
    async moveToFolder(userId, ids, folderId) {
      const { rowCount } = await db.query(
        `UPDATE creatives SET folder_id = $3, updated_at = now()
          WHERE user_id = $1 AND id = ANY($2::int[])
            AND (SELECT COUNT(*) FROM creatives WHERE user_id = $1 AND id = ANY($2::int[])) = cardinality($2::int[])
            AND ($3::int IS NULL OR EXISTS (SELECT 1 FROM creative_folders WHERE id = $3 AND user_id = $1))`,
        [userId, ids, folderId],
      );
      return rowCount;
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

    // ---- Versão limpa enviada ao TikTok, por (campanha, criativo, conta de anúncio) ----
    async findCampaignAsset(campaignId, creativeId, advertiserId) {
      const { rows } = await db.query(
        'SELECT tiktok_id FROM campaign_creative_assets WHERE campaign_id = $1 AND creative_id = $2 AND advertiser_id = $3',
        [campaignId, creativeId, advertiserId],
      );
      return rows[0]?.tiktok_id ?? null;
    },
    async saveCampaignAsset({ campaignId, creativeId, advertiserId, tiktokId, variantSha256 }) {
      await db.query(
        `INSERT INTO campaign_creative_assets (campaign_id, creative_id, advertiser_id, tiktok_id, variant_sha256) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (campaign_id, creative_id, advertiser_id) DO UPDATE SET tiktok_id = EXCLUDED.tiktok_id, variant_sha256 = EXCLUDED.variant_sha256`,
        [campaignId, creativeId, advertiserId, tiktokId, variantSha256],
      );
    },

    // ---- Criativos que JÁ existiam no TikTok (referência por ID), por conta de anúncio ----
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

    /** Campanhas sem NENHUMA publicação concluída (rascunho/parcial) do usuário que usam este criativo. */
    async findDraftCampaignsUsing(userId, id) {
      const { rows } = await db.query(
        `SELECT id, name FROM campaigns
          WHERE user_id = $1 AND config IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM campaign_publications p WHERE p.campaign_id = campaigns.id AND p.tiktok_ad_id IS NOT NULL)
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
