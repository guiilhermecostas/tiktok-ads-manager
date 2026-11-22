import { toIso } from '../../db/helpers.js';
import { decrypt, encrypt } from '../../lib/crypto.js';

/** Visão do repositório: NUNCA inclui o token. */
function toRecord(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name ?? null,
    bcId: row.bc_id ?? null,
    viaProxy: row.via_proxy === true,
    authType: row.auth_type,
    name: row.name,
    shared: row.shared === true,
    status: row.status,
    lastError: row.last_error ?? null,
    lastSyncedAt: toIso(row.last_synced_at),
    advertiserCount: row.advertiser_count ?? 0,
    createdAt: toIso(row.created_at),
  };
}

const SELECT_PUBLIC = `
  SELECT bc.id, bc.owner_id, u.name AS owner_name, bc.bc_id, bc.auth_type, bc.name, bc.shared, bc.status, bc.last_error,
         bc.last_synced_at, bc.created_at,
         (SELECT COUNT(*)::int FROM tiktok_advertisers a WHERE a.business_center_id = bc.id) AS advertiser_count,
         EXISTS (SELECT 1 FROM proxies p WHERE p.user_id = bc.owner_id AND p.active) AS via_proxy
    FROM tiktok_business_centers bc JOIN users u ON u.id = bc.owner_id`;

/**
 * Substitui as contas de anúncio de uma BC em UMA instrução (unnest): com banco remoto, centenas de
 * INSERTs individuais custariam centenas de idas e voltas à rede.
 */
async function writeAdvertisers(tx, bcRowId, advertisers) {
  await tx.query('DELETE FROM tiktok_advertisers WHERE business_center_id = $1', [bcRowId]);
  if (!advertisers.length) return;
  await tx.query(
    `INSERT INTO tiktok_advertisers (business_center_id, advertiser_id, name, currency, timezone)
     SELECT $1, t.advertiser_id, t.name, t.currency, t.timezone
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS t(advertiser_id, name, currency, timezone)
     ON CONFLICT (business_center_id, advertiser_id)
     DO UPDATE SET name = EXCLUDED.name, currency = EXCLUDED.currency, timezone = EXCLUDED.timezone`,
    [bcRowId, advertisers.map((a) => a.id), advertisers.map((a) => a.name), advertisers.map((a) => a.currency ?? null), advertisers.map((a) => a.timezone ?? null)],
  );
}

const MARK_OK = `UPDATE tiktok_business_centers SET status = 'active', last_error = NULL, last_synced_at = now() WHERE id = $1`;

/**
 * Business Centers pertencem a um usuário (owner_id). Uma BC é visível para o dono e,
 * se `shared`, para toda a equipe aprovada. O token fica criptografado e só o servidor o lê.
 */
export function createBusinessCentersRepository(db, { encryptionKey }) {
  return {
    /** Todas as BCs (supervisão do admin). */
    async listAll() {
      const { rows } = await db.query(`${SELECT_PUBLIC} ORDER BY bc.created_at DESC, bc.id DESC`);
      return rows.map(toRecord);
    },
    /** BCs que o usuário pode usar: as próprias + as compartilhadas. */
    async listVisible(userId) {
      const { rows } = await db.query(
        `${SELECT_PUBLIC} WHERE bc.owner_id = $1 OR bc.shared ORDER BY (bc.owner_id = $1) DESC, bc.created_at DESC, bc.id DESC`,
        [userId],
      );
      return rows.map(toRecord);
    },
    async get(id) {
      const { rows } = await db.query(`${SELECT_PUBLIC} WHERE bc.id = $1`, [id]);
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async existsForOwner(ownerId, bcId) {
      const { rows } = await db.query('SELECT 1 FROM tiktok_business_centers WHERE owner_id = $1 AND bc_id = $2', [ownerId, bcId]);
      return rows.length > 0;
    },

    /** Cria a BC e suas contas de anúncio de forma atômica. */
    async create({ ownerId, bcId = null, name, accessToken, shared = false, advertisers, authType = 'token' }) {
      return db.transaction(async (tx) => {
        const { rows } = await tx.query(
          'INSERT INTO tiktok_business_centers (owner_id, bc_id, name, access_token, shared, auth_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [ownerId, bcId, name, encrypt(accessToken, encryptionKey), shared, authType],
        );
        const id = rows[0].id;
        await writeAdvertisers(tx, id, advertisers);
        await tx.query(MARK_OK, [id]);
        return id;
      });
    },
    /** Conexão por link (OAuth) do usuário que já cobre alguma destas contas de anúncio (reautorização = mesma conexão). */
    async findOauthByAdvertisers(ownerId, advertiserIds) {
      if (!advertiserIds.length) return null;
      const { rows } = await db.query(
        `SELECT bc.id FROM tiktok_business_centers bc JOIN tiktok_advertisers a ON a.business_center_id = bc.id
          WHERE bc.owner_id = $1 AND bc.auth_type = 'oauth' AND a.advertiser_id = ANY($2::text[]) ORDER BY bc.id LIMIT 1`,
        [ownerId, advertiserIds],
      );
      return rows[0]?.id ?? null;
    },
    async rename(id, name) {
      await db.query('UPDATE tiktok_business_centers SET name = $1 WHERE id = $2', [name, id]);
    },
    async setShared(id, shared) {
      await db.query('UPDATE tiktok_business_centers SET shared = $1 WHERE id = $2', [shared, id]);
    },
    /** Troca o token (rotação) e atualiza as contas de anúncio na mesma transação. */
    async replaceToken(id, accessToken, advertisers) {
      await db.transaction(async (tx) => {
        await tx.query('UPDATE tiktok_business_centers SET access_token = $1 WHERE id = $2', [encrypt(accessToken, encryptionKey), id]);
        await writeAdvertisers(tx, id, advertisers);
        await tx.query(MARK_OK, [id]);
      });
    },
    async replaceAdvertisers(id, advertisers) {
      await db.transaction(async (tx) => {
        await writeAdvertisers(tx, id, advertisers);
        await tx.query(MARK_OK, [id]);
      });
    },
    async markError(id, message) {
      await db.query("UPDATE tiktok_business_centers SET status = 'error', last_error = $1 WHERE id = $2", [String(message).slice(0, 300), id]);
    },
    async remove(id) {
      const { rowCount } = await db.query('DELETE FROM tiktok_business_centers WHERE id = $1', [id]);
      return rowCount > 0;
    },

    /**
     * Token descriptografado + dono: uso EXCLUSIVO do servidor, nunca enviado ao cliente. O dono decide por qual proxy
     * as chamadas com este token saem.
     */
    async getAccess(id) {
      const { rows } = await db.query('SELECT owner_id, access_token FROM tiktok_business_centers WHERE id = $1', [id]);
      return rows[0] ? { ownerId: rows[0].owner_id, token: decrypt(rows[0].access_token, encryptionKey) } : null;
    },

    /** Contas de anúncio das BCs visíveis para o usuário. */
    async advertisers(userId) {
      const { rows } = await db.query(
        `SELECT a.advertiser_id, a.name, a.currency, a.timezone, bc.id AS bc_row_id, bc.name AS bc_name, bc.status AS bc_status,
                bc.bc_id AS bc_external_id, bc.auth_type AS bc_auth_type, bc.shared AS bc_shared, (bc.owner_id = $1) AS bc_owned,
                EXISTS (SELECT 1 FROM proxies p WHERE p.user_id = bc.owner_id AND p.active) AS bc_via_proxy
           FROM tiktok_advertisers a JOIN tiktok_business_centers bc ON bc.id = a.business_center_id
          WHERE bc.owner_id = $1 OR bc.shared
          ORDER BY lower(bc.name), lower(a.name)`,
        [userId],
      );
      return rows.map((r) => ({
        id: r.advertiser_id,
        name: r.name,
        currency: r.currency,
        timezone: r.timezone,
        businessCenterId: r.bc_row_id,
        businessCenterName: r.bc_name,
        businessCenterStatus: r.bc_status,
        businessCenterBcId: r.bc_external_id ?? null, // ID da BC no TikTok (conexão por link não tem)
        businessCenterAuthType: r.bc_auth_type,
        businessCenterShared: r.bc_shared === true,
        businessCenterOwned: r.bc_owned === true,
        businessCenterViaProxy: r.bc_via_proxy === true,
      }));
    },
    /** Se a mesma conta existir em mais de uma BC visível, prefere a do próprio usuário. */
    async findAdvertiser(advertiserId, userId) {
      const { rows } = await db.query(
        `SELECT a.advertiser_id, a.name, a.currency, a.timezone, bc.id AS bc_row_id
           FROM tiktok_advertisers a JOIN tiktok_business_centers bc ON bc.id = a.business_center_id
          WHERE a.advertiser_id = $1 AND bc.status = 'active' AND (bc.owner_id = $2 OR bc.shared)
          ORDER BY (bc.owner_id = $2) DESC, bc.id LIMIT 1`,
        [advertiserId, userId],
      );
      const row = rows[0];
      return row ? { id: row.advertiser_id, name: row.name, currency: row.currency, timezone: row.timezone, businessCenterId: row.bc_row_id } : null;
    },
  };
}
