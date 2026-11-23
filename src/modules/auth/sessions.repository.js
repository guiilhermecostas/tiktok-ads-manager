import { createHash, randomBytes } from 'node:crypto';

/** O token em texto puro só existe no cookie; no banco guardamos apenas o hash SHA-256. */
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function createSessionsRepository(db, { ttlMs }) {
  return {
    async create(userId) {
      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(24).toString('base64url');
      const expiresAt = Date.now() + ttlMs;
      await db.query('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)', [
        hashToken(token),
        userId,
        csrfToken,
        new Date(expiresAt),
      ]);
      return { token, csrfToken, expiresAt };
    },

    /**
     * Retorna { session, user, member } ou null se a sessão for inválida/expirada. `user` é a linha completa de `users`;
     * `member` é null para donos de conta e, para colaboradores, { ownerId, ownerName, ownerStatus, areas } (relido a cada
     * requisição: remover o colaborador ou mudar as áreas dele vale na hora).
     */
    async resolve(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
      const { rows } = await db.query(
        `SELECT s.token_hash, s.csrf_token, s.expires_at, u.*,
                m.owner_id AS ws_owner_id, m.areas AS ws_areas, o.name AS ws_owner_name, o.status AS ws_owner_status,
                (SELECT updated_at FROM user_avatars WHERE user_id = u.id) AS avatar_updated_at
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN workspace_members m ON m.user_id = u.id
           LEFT JOIN users o ON o.id = m.owner_id
          WHERE s.token_hash = $1`,
        [hashToken(token)],
      );
      const row = rows[0];
      if (!row) return null;
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await db.query('DELETE FROM sessions WHERE token_hash = $1', [row.token_hash]);
        return null;
      }
      const {
        token_hash: tokenHash, csrf_token: csrfToken, expires_at: expiresAt,
        ws_owner_id: ownerId, ws_areas: areas, ws_owner_name: ownerName, ws_owner_status: ownerStatus,
        ...user
      } = row;
      const member = ownerId ? { ownerId, ownerName, ownerStatus, areas: areas ?? [] } : null;
      return { session: { tokenHash, csrfToken, expiresAt: new Date(expiresAt).getTime() }, user, member };
    },

    async destroy(token) {
      await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    },
    async destroyAllForUser(userId) {
      await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    },
    async purgeExpired() {
      await db.query('DELETE FROM sessions WHERE expires_at <= now()');
    },
  };
}
