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

    /** Retorna { session, user } (user = linha completa de `users`) ou null se inválida/expirada. */
    async resolve(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
      const { rows } = await db.query(
        `SELECT s.token_hash, s.csrf_token, s.expires_at, u.*
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1`,
        [hashToken(token)],
      );
      const row = rows[0];
      if (!row) return null;
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await db.query('DELETE FROM sessions WHERE token_hash = $1', [row.token_hash]);
        return null;
      }
      const { token_hash: tokenHash, csrf_token: csrfToken, expires_at: expiresAt, ...user } = row;
      return { session: { tokenHash, csrfToken, expiresAt: new Date(expiresAt).getTime() }, user };
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
