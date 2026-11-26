import { toIso } from '../../db/helpers.js';

export const AUDIT_ACTIONS = ['impersonation_start', 'impersonation_end', 'status_change', 'notification_send', 'notification_change', 'billing_plan', 'billing_payment', 'billing_lock_release', 'billing_rate'];

/** Registro de auditoria das ações do admin. Só acrescenta linhas (nunca altera nem apaga). Consultas parametrizadas. */
export function createAuditRepository(db) {
  return {
    async record({ adminId, targetId = null, action, detail = null, ip = null }) {
      if (!AUDIT_ACTIONS.includes(action)) throw new Error(`Ação de auditoria desconhecida: ${action}`);
      await db.query('INSERT INTO admin_audit_log (admin_id, target_id, action, detail, ip) VALUES ($1, $2, $3, $4, $5)', [
        adminId,
        targetId,
        action,
        detail === null ? null : String(detail).slice(0, 200),
        ip === null ? null : String(ip).slice(0, 64),
      ]);
    },

    async listRecent(limit = 50) {
      const { rows } = await db.query(
        `SELECT a.id, a.action, a.detail, a.created_at, adm.name AS admin_name, tgt.name AS target_name, tgt.email AS target_email
           FROM admin_audit_log a
           LEFT JOIN users adm ON adm.id = a.admin_id
           LEFT JOIN users tgt ON tgt.id = a.target_id
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT $1`,
        [Math.min(Math.max(Number(limit) || 50, 1), 200)],
      );
      return rows.map((r) => ({
        id: r.id,
        action: r.action,
        detail: r.detail,
        adminName: r.admin_name,
        targetName: r.target_name,
        targetEmail: r.target_email,
        createdAt: toIso(r.created_at),
      }));
    },
  };
}
