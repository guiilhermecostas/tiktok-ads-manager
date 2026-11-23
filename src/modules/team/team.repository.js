import { toIso } from '../../db/helpers.js';

const toMember = (row) => ({
  id: row.id, userId: row.user_id, name: row.name, email: row.email, areas: row.areas, createdAt: toIso(row.created_at),
  avatarVersion: row.avatar_updated_at ? Date.parse(toIso(row.avatar_updated_at)) : null, // foto do colaborador: /api/avatars/:userId?v=…
});
const toInvite = (row) => ({ id: row.id, name: row.name, email: row.email, areas: row.areas, expiresAt: toIso(row.expires_at), createdAt: toIso(row.created_at) });

/**
 * Colaboradores e convites de um dono de conta. Tudo é filtrado por `owner_id`: um dono nunca enxerga nem altera os
 * colaboradores de outro. O token do convite nunca é guardado (só o hash SHA-256).
 */
export function createTeamRepository(db) {
  const MEMBER_SELECT = 'SELECT m.id, m.user_id, m.areas, m.created_at, u.name, u.email, (SELECT updated_at FROM user_avatars WHERE user_id = u.id) AS avatar_updated_at FROM workspace_members m JOIN users u ON u.id = m.user_id';
  return {
    async listMembers(ownerId) {
      const { rows } = await db.query(`${MEMBER_SELECT} WHERE m.owner_id = $1 ORDER BY lower(u.name), m.id`, [ownerId]);
      return rows.map(toMember);
    },
    async listInvites(ownerId) {
      const { rows } = await db.query('SELECT id, email, name, areas, expires_at, created_at FROM workspace_invites WHERE owner_id = $1 ORDER BY created_at DESC, id DESC', [ownerId]);
      return rows.map(toInvite);
    },
    /** Colaboradores ativos + convites pendentes (conta para o limite de tamanho da equipe). */
    async countTeam(ownerId) {
      const { rows } = await db.query(
        'SELECT (SELECT COUNT(*) FROM workspace_members WHERE owner_id = $1)::int + (SELECT COUNT(*) FROM workspace_invites WHERE owner_id = $1)::int AS total',
        [ownerId],
      );
      return rows[0].total;
    },
    async hasMemberWithEmail(ownerId, email) {
      const { rows } = await db.query('SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.owner_id = $1 AND lower(u.email) = lower($2)', [ownerId, email]);
      return rows.length > 0;
    },

    /** Cria o convite ou, se já houver um pendente para este e-mail, o substitui (o link antigo deixa de valer). */
    async upsertInvite(ownerId, { email, name, areas, tokenHash, expiresAt }) {
      const { rows } = await db.query(
        `INSERT INTO workspace_invites (owner_id, email, name, areas, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (owner_id, lower(email))
         DO UPDATE SET name = EXCLUDED.name, areas = EXCLUDED.areas, token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, created_at = now()
         RETURNING id, email, name, areas, expires_at, created_at`,
        [ownerId, email, name, areas, tokenHash, new Date(expiresAt)],
      );
      return toInvite(rows[0]);
    },
    async getInvite(ownerId, id) {
      const { rows } = await db.query('SELECT id, email, name, areas, expires_at, created_at FROM workspace_invites WHERE id = $1 AND owner_id = $2', [id, ownerId]);
      return rows[0] ? toInvite(rows[0]) : null;
    },
    async replaceInviteToken(ownerId, id, { tokenHash, expiresAt }) {
      const { rows } = await db.query(
        'UPDATE workspace_invites SET token_hash = $3, expires_at = $4, created_at = now() WHERE id = $1 AND owner_id = $2 RETURNING id, email, name, areas, expires_at, created_at',
        [id, ownerId, tokenHash, new Date(expiresAt)],
      );
      return rows[0] ? toInvite(rows[0]) : null;
    },
    async deleteInvite(ownerId, id) {
      const { rowCount } = await db.query('DELETE FROM workspace_invites WHERE id = $1 AND owner_id = $2', [id, ownerId]);
      return rowCount > 0;
    },

    async updateMemberAreas(ownerId, id, areas) {
      const { rowCount } = await db.query('UPDATE workspace_members SET areas = $3 WHERE id = $1 AND owner_id = $2', [id, ownerId, areas]);
      if (!rowCount) return null;
      const { rows } = await db.query(`${MEMBER_SELECT} WHERE m.id = $1`, [id]);
      return toMember(rows[0]);
    },
    /** Remove o colaborador: apaga a conta dele (a cascata leva o vínculo e as sessões abertas). */
    async removeMember(ownerId, id) {
      const { rowCount } = await db.query('DELETE FROM users WHERE id = (SELECT user_id FROM workspace_members WHERE id = $1 AND owner_id = $2)', [id, ownerId]);
      return rowCount > 0;
    },

    /** Convite válido (existe e não expirou) a partir do hash do token, com o nome do dono. */
    async findValidInvite(tokenHash) {
      const { rows } = await db.query(
        `SELECT i.id, i.email, i.name, i.areas, i.expires_at, i.created_at, o.name AS owner_name, o.status AS owner_status
           FROM workspace_invites i JOIN users o ON o.id = i.owner_id
          WHERE i.token_hash = $1 AND i.expires_at > now()`,
        [tokenHash],
      );
      return rows[0] ? { ...toInvite(rows[0]), ownerName: rows[0].owner_name, ownerStatus: rows[0].owner_status } : null;
    },

    /**
     * Aceita o convite de forma ATÔMICA e de uso único: apaga o convite, cria a conta do colaborador (já aprovada) e o vínculo,
     * tudo na mesma transação. Devolve { status: 'ok', userId, ownerId } | { status: 'invalid' } | { status: 'email_taken' }.
     */
    async acceptInvite(tokenHash, { name, passwordHash }) {
      const ROLLBACK = Symbol('rollback');
      let outcome;
      try {
        await db.transaction(async (tx) => {
          const { rows } = await tx.query(
            `DELETE FROM workspace_invites i USING users o
              WHERE i.token_hash = $1 AND i.expires_at > now() AND o.id = i.owner_id AND o.status = 'approved'
          RETURNING i.owner_id, i.email, i.areas`,
            [tokenHash],
          );
          const invite = rows[0];
          if (!invite) {
            outcome = { status: 'invalid' };
            throw ROLLBACK;
          }
          const taken = await tx.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [invite.email]);
          if (taken.rows.length) {
            outcome = { status: 'email_taken' };
            throw ROLLBACK; // o convite continua valendo: nada foi consumido
          }
          const user = await tx.query(
            "INSERT INTO users (email, name, company, password_hash, role, status) VALUES ($1, $2, NULL, $3, 'user', 'approved') RETURNING id",
            [invite.email, name, passwordHash],
          );
          await tx.query('INSERT INTO workspace_members (owner_id, user_id, areas) VALUES ($1, $2, $3)', [invite.owner_id, user.rows[0].id, invite.areas]);
          outcome = { status: 'ok', userId: user.rows[0].id, ownerId: invite.owner_id };
        });
      } catch (err) {
        if (err !== ROLLBACK) throw err;
      }
      return outcome;
    },
  };
}
