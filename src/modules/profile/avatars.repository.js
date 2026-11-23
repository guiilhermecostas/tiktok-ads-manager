import { toIso } from '../../db/helpers.js';

/** Fotos de perfil (uma por usuário), na tabela `user_avatars`. Tudo parametrizado. */
export function createAvatarsRepository(db) {
  return {
    /** Grava (ou substitui) a foto. Devolve o instante da gravação (vira a "versão" da foto na tela). */
    async save(userId, data) {
      const { rows } = await db.query(
        `INSERT INTO user_avatars (user_id, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
         RETURNING updated_at`,
        [userId, data],
      );
      return toIso(rows[0].updated_at);
    },
    async get(userId) {
      const { rows } = await db.query('SELECT mime, data, updated_at FROM user_avatars WHERE user_id = $1', [userId]);
      return rows[0] ? { mime: rows[0].mime, data: rows[0].data, updatedAt: toIso(rows[0].updated_at) } : null;
    },
    async remove(userId) {
      const { rowCount } = await db.query('DELETE FROM user_avatars WHERE user_id = $1', [userId]);
      return rowCount > 0;
    },
    /**
     * A foto de `targetId` pode ser vista por quem trabalha no espaço de `viewerWorkspaceOwnerId`? Sim se o alvo é o próprio
     * dono do espaço ou um colaborador dele (cada um enxerga o dono e os colegas de equipe, nunca outras contas).
     */
    async sharesWorkspace(viewerWorkspaceOwnerId, targetId) {
      const { rows } = await db.query(
        'SELECT 1 WHERE COALESCE((SELECT owner_id FROM workspace_members WHERE user_id = $2), $2) = $1',
        [viewerWorkspaceOwnerId, targetId],
      );
      return rows.length > 0;
    },
  };
}
