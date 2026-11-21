import { createHash, randomBytes } from 'node:crypto';
import { toIso } from '../../db/helpers.js';

/**
 * Tentativas de conexão por link de autorização do TikTok.
 *  - `state` (256 bits, aleatório) só existe no link; no banco fica o SHA-256 dele.
 *  - Uso ÚNICO: `claim` troca pending -> processing em uma instrução atômica; um segundo uso (ou uso após expirar) não encontra nada.
 *  - `attemptId` é o identificador que o dono usa para acompanhar o resultado (nunca revela o state).
 */
const hashState = (state) => createHash('sha256').update(state).digest('hex');

function toAttempt(row) {
  return {
    attemptId: row.attempt_id,
    userId: row.user_id,
    name: row.name,
    status: row.status,
    connectionId: row.connection_id ?? null,
    message: row.message ?? null,
    expiresAt: toIso(row.expires_at),
    expired: new Date(row.expires_at).getTime() <= Date.now(),
  };
}

export function createOauthAttemptsRepository(db) {
  return {
    async create(userId, { name, ttlMs }) {
      const attemptId = randomBytes(16).toString('hex');
      const state = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + ttlMs);
      await db.query('INSERT INTO tiktok_oauth_attempts (attempt_id, state_hash, user_id, name, expires_at) VALUES ($1, $2, $3, $4, $5)', [
        attemptId, hashState(state), userId, name, expiresAt,
      ]);
      return { attemptId, state, expiresAt: expiresAt.toISOString() };
    },

    /** Quantas tentativas em aberto o usuário tem (limita a geração de links). */
    async countPending(userId) {
      const { rows } = await db.query("SELECT COUNT(*)::int AS c FROM tiktok_oauth_attempts WHERE user_id = $1 AND status = 'pending' AND expires_at > now()", [userId]);
      return rows[0].c;
    },

    /** Reivindica o state (uso único). Retorna a tentativa ou null (desconhecido, já usado ou expirado). */
    async claim(state) {
      if (typeof state !== 'string' || state.length < 20 || state.length > 100) return null;
      const { rows } = await db.query(
        `UPDATE tiktok_oauth_attempts SET status = 'processing'
          WHERE state_hash = $1 AND status = 'pending' AND expires_at > now() RETURNING *`,
        [hashState(state)],
      );
      return rows[0] ? toAttempt(rows[0]) : null;
    },

    async finish(attemptId, { status, connectionId = null, message = null }) {
      await db.query('UPDATE tiktok_oauth_attempts SET status = $1, connection_id = $2, message = $3 WHERE attempt_id = $4', [status, connectionId, message, attemptId]);
    },

    /** Só o dono enxerga a tentativa. */
    async findForUser(userId, attemptId) {
      if (typeof attemptId !== 'string' || !/^[a-f0-9]{32}$/.test(attemptId)) return null;
      const { rows } = await db.query('SELECT * FROM tiktok_oauth_attempts WHERE user_id = $1 AND attempt_id = $2', [userId, attemptId]);
      return rows[0] ? toAttempt(rows[0]) : null;
    },

    /** Cancela um link ainda não usado (o state deixa de valer na hora). */
    async cancel(userId, attemptId) {
      if (typeof attemptId !== 'string' || !/^[a-f0-9]{32}$/.test(attemptId)) return false;
      const { rowCount } = await db.query("DELETE FROM tiktok_oauth_attempts WHERE user_id = $1 AND attempt_id = $2 AND status = 'pending'", [userId, attemptId]);
      return rowCount > 0;
    },

    async purgeOld() {
      await db.query("DELETE FROM tiktok_oauth_attempts WHERE created_at < now() - interval '1 day'");
    },
  };
}
