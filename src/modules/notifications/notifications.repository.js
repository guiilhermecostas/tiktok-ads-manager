import { toIso } from '../../db/helpers.js';

/**
 * Notificações (tabelas `notifications` e `notification_reads`). A visibilidade de uma notificação para uma pessoa é UMA regra só (VISIBLE):
 * ativa, dentro da validade e destinada a todos ou a ela. Toda consulta da pessoa parte do id dela; nada vem do cliente. Parametrizado ($1…).
 */
const VISIBLE = `n.active AND (n.expires_at IS NULL OR n.expires_at > now()) AND (n.audience = 'all' OR n.target_user_id = $1)`;

const toItem = (r) => ({ id: r.id, title: r.title, body: r.body, level: r.level, link: r.link, createdAt: toIso(r.created_at), read: Boolean(r.is_read) });

export function createNotificationsRepository(db) {
  return {
    async create({ title, body, level, audience, targetUserId = null, link = null, expiresAt = null, createdBy }) {
      const { rows } = await db.query(
        `INSERT INTO notifications (title, body, level, audience, target_user_id, link, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [title, body, level, audience, targetUserId, link, expiresAt, createdBy],
      );
      return rows[0].id;
    },

    /** O que a pessoa vê no sino: as mais recentes primeiro. */
    async listForUser(userId, limit) {
      const { rows } = await db.query(
        `SELECT n.id, n.title, n.body, n.level, n.link, n.created_at, (r.user_id IS NOT NULL) AS is_read
           FROM notifications n LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $1
          WHERE ${VISIBLE}
          ORDER BY n.created_at DESC, n.id DESC LIMIT $2`,
        [userId, limit],
      );
      return rows.map(toItem);
    },

    async unreadCount(userId) {
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS total FROM notifications n
          WHERE ${VISIBLE} AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = $1)`,
        [userId],
      );
      return rows[0].total;
    },

    /** Marca como lidas SÓ as que a pessoa pode ver (um id de outra pessoa é ignorado). `ids` nulo = todas. Devolve quantas foram marcadas. */
    async markRead(userId, ids = null) {
      const { rowCount } = await db.query(
        `INSERT INTO notification_reads (notification_id, user_id)
         SELECT n.id, $1 FROM notifications n
          WHERE ${VISIBLE} AND ($2::int[] IS NULL OR n.id = ANY($2::int[]))
         ON CONFLICT DO NOTHING`,
        [userId, ids],
      );
      return rowCount;
    },

    // ---------- administração ----------
    async get(id) {
      const { rows } = await db.query('SELECT * FROM notifications WHERE id = $1', [id]);
      return rows[0] ?? null;
    },

    /** Lista do admin: tudo o que foi enviado, com quem leu. `recipients`: quantas pessoas recebem (todos = contas aprovadas). */
    async adminList(limit = 100) {
      const { rows } = await db.query(
        `SELECT n.id, n.title, n.body, n.level, n.link, n.audience, n.target_user_id, n.active, n.expires_at, n.created_at,
                t.name AS target_name, t.email AS target_email, c.name AS created_by_name,
                (SELECT COUNT(*)::int FROM notification_reads r WHERE r.notification_id = n.id) AS read_count,
                CASE WHEN n.audience = 'all' THEN (SELECT COUNT(*)::int FROM users WHERE status = 'approved') ELSE 1 END AS recipients
           FROM notifications n LEFT JOIN users t ON t.id = n.target_user_id LEFT JOIN users c ON c.id = n.created_by
          ORDER BY n.created_at DESC, n.id DESC LIMIT $1`,
        [Math.min(Math.max(Number(limit) || 100, 1), 200)],
      );
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        level: r.level,
        link: r.link,
        audience: r.audience,
        targetUserId: r.target_user_id,
        targetName: r.target_name,
        targetEmail: r.target_email,
        active: r.active,
        expiresAt: toIso(r.expires_at),
        createdAt: toIso(r.created_at),
        createdByName: r.created_by_name,
        readCount: r.read_count,
        recipients: r.recipients,
      }));
    },

    async setActive(id, active) {
      const { rowCount } = await db.query('UPDATE notifications SET active = $1 WHERE id = $2', [active, id]);
      return rowCount > 0;
    },

    async remove(id) {
      const { rowCount } = await db.query('DELETE FROM notifications WHERE id = $1', [id]);
      return rowCount > 0;
    },
  };
}
