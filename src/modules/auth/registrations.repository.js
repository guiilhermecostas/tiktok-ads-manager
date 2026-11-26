import { createHash } from 'node:crypto';
import { DEFAULT_PLAN, monthOf } from '../../../shared/billing.js';

/** SHA-256 em hexadecimal (o ticket e o código só existem em texto puro no navegador e no e-mail; no banco fica o hash). */
export const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex');
export const MAX_CODE_ATTEMPTS = 5;

/**
 * Cadastros aguardando a confirmação do e-mail (`registration_codes`). Consultas parametrizadas. A conta só nasce em `complete`, que cria o usuário
 * (PENDENTE de aprovação, como sempre) e o plano padrão (US$ 0 + 10% do gasto) numa transação única, e apaga o cadastro em andamento.
 */
export function createRegistrationsRepository(db) {
  return {
    async create({ ticketHash, email, name, company, passwordHash, codeHash, expiresAt }) {
      await db.query(
        `INSERT INTO registration_codes (ticket_hash, email, name, company, password_hash, code_hash, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ticketHash, email, name, company ?? null, passwordHash, codeHash, expiresAt],
      );
    },

    /** O cadastro vigente do ticket (ou null se não existe ou venceu). Nunca devolve o hash da senha. */
    async find(ticketHash, now) {
      const { rows } = await db.query(
        'SELECT ticket_hash, email, name, attempts, sends, last_sent_at, expires_at FROM registration_codes WHERE ticket_hash = $1 AND expires_at > $2',
        [ticketHash, now.toISOString()],
      );
      return rows[0] ? { ticketHash: rows[0].ticket_hash, email: rows[0].email, name: rows[0].name, attempts: rows[0].attempts, sends: rows[0].sends, lastSentAt: new Date(rows[0].last_sent_at), expiresAt: new Date(rows[0].expires_at) } : null;
    },

    /**
     * Conta UMA tentativa de código de forma atômica e devolve o hash esperado. Só passa enquanto houver tentativas (várias requisições ao mesmo tempo
     * não conseguem passar do limite) e antes do vencimento. `null` = sem cadastro, vencido ou sem tentativas.
     */
    async takeAttempt(ticketHash, now) {
      const { rows } = await db.query(
        `UPDATE registration_codes SET attempts = attempts + 1 WHERE ticket_hash = $1 AND expires_at > $2 AND attempts < $3
         RETURNING code_hash, attempts, email`,
        [ticketHash, now.toISOString(), MAX_CODE_ATTEMPTS],
      );
      return rows[0] ? { codeHash: rows[0].code_hash, attempts: rows[0].attempts, email: rows[0].email } : null;
    },

    /** Novo código (reenvio): zera as tentativas, estende a validade e conta o envio. Devolve false se o cadastro já não existe. */
    async renewCode(ticketHash, { codeHash, expiresAt, now }) {
      const { rowCount } = await db.query(
        `UPDATE registration_codes SET code_hash = $2, attempts = 0, sends = sends + 1, last_sent_at = $3, expires_at = $4 WHERE ticket_hash = $1 AND expires_at > $3`,
        [ticketHash, codeHash, now.toISOString(), expiresAt],
      );
      return rowCount > 0;
    },

    async remove(ticketHash) {
      await db.query('DELETE FROM registration_codes WHERE ticket_hash = $1', [ticketHash]);
    },

    async purgeExpired(now) {
      const { rowCount } = await db.query('DELETE FROM registration_codes WHERE expires_at <= $1', [now.toISOString()]);
      return rowCount;
    },

    /**
     * Cria a conta a partir do cadastro confirmado: usuário PENDENTE (role 'user', nunca vem do cliente) + plano padrão do mês, e apaga o cadastro em
     * andamento, tudo numa transação. Devolve o id do usuário. Se o e-mail já virou conta, o UNIQUE do banco recusa (o chamador trata).
     */
    async complete(ticketHash, now) {
      return db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO users (email, name, company, password_hash, role, status)
           SELECT email, name, company, password_hash, 'user', 'pending' FROM registration_codes WHERE ticket_hash = $1 RETURNING id`,
          [ticketHash],
        );
        if (!rows[0]) return null;
        const userId = rows[0].id;
        await tx.query(
          'INSERT INTO billing_plans (user_id, monthly_fee_cents, percent_bp, effective_month, note, created_by) VALUES ($1, $2, $3, $4::date, $5, NULL)',
          [userId, DEFAULT_PLAN.monthlyFeeCents, DEFAULT_PLAN.percentBp, monthOf(now), DEFAULT_PLAN.note],
        );
        await tx.query('DELETE FROM registration_codes WHERE ticket_hash = $1', [ticketHash]);
        return userId;
      });
    },
  };
}
