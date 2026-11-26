import { toIso } from '../../db/helpers.js';

/**
 * Acesso a dados das assinaturas (planos, gasto guardado, fechamentos, pagamentos, bloqueios e cotações). Consultas parametrizadas ($1, $2…).
 * Valores em dinheiro saem SEMPRE como centavos inteiros (BIGINT chega como texto e vira Number: longe do limite seguro).
 */
const cents = (v) => Number(v);
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

const toPlan = (r) => ({ id: r.id, userId: r.user_id, monthlyFeeCents: r.monthly_fee_cents, percentBp: r.percent_bp, effectiveMonth: r.effective_month_text, note: r.note, createdAt: toIso(r.created_at) });
const PLAN_SQL = `SELECT id, user_id, monthly_fee_cents, percent_bp, to_char(effective_month, 'YYYY-MM-DD') AS effective_month_text, note, created_at FROM billing_plans`;

export function createBillingRepository(db) {
  return {
    // ---------- planos ----------
    /** Cria o plano de um mês ou substitui o que já existia naquele mês. */
    async setPlan({ userId, monthlyFeeCents, percentBp, effectiveMonth, note = null, createdBy }) {
      await db.query(
        `INSERT INTO billing_plans (user_id, monthly_fee_cents, percent_bp, effective_month, note, created_by) VALUES ($1, $2, $3, $4::date, $5, $6)
         ON CONFLICT (user_id, effective_month)
         DO UPDATE SET monthly_fee_cents = EXCLUDED.monthly_fee_cents, percent_bp = EXCLUDED.percent_bp, note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = now()`,
        [userId, monthlyFeeCents, percentBp, effectiveMonth, note, createdBy],
      );
    },
    /** Todos os planos da pessoa, do mais antigo ao mais novo. */
    async listPlans(userId) {
      const { rows } = await db.query(`${PLAN_SQL} WHERE user_id = $1 ORDER BY effective_month`, [userId]);
      return rows.map(toPlan);
    },
    /** Pessoas que têm ao menos um plano. */
    async usersWithPlans() {
      const { rows } = await db.query('SELECT DISTINCT user_id FROM billing_plans ORDER BY user_id');
      return rows.map((r) => r.user_id);
    },

    // ---------- gasto guardado ----------
    /**
     * Grava as horas de UMA conta para o dono. O valor de uma hora SÓ SOBE (GREATEST): o TikTok ajusta os números, mas apagar anúncios depois
     * não pode diminuir o que já foi gasto. `rows`: [{ hourStart: Date, spend }]. Devolve quantas linhas foram enviadas.
     */
    async recordSpend(ownerId, advertiserId, currency, rows) {
      const valid = rows.filter((r) => r.hourStart instanceof Date && Number.isFinite(r.spend) && r.spend >= 0);
      if (!valid.length) return 0;
      await db.query(
        `INSERT INTO spend_ledger (owner_id, advertiser_id, hour_start, currency, spend)
         SELECT $1, $2, t.hour_start, $3, t.spend FROM unnest($4::timestamptz[], $5::numeric[]) AS t(hour_start, spend)
         ON CONFLICT (owner_id, advertiser_id, hour_start)
         DO UPDATE SET spend = GREATEST(spend_ledger.spend, EXCLUDED.spend), currency = EXCLUDED.currency, updated_at = now()`,
        [ownerId, advertiserId, currency ?? 'UNKNOWN', valid.map((r) => r.hourStart.toISOString()), valid.map((r) => Number(r.spend.toFixed(4)))],
      );
      return valid.length;
    },
    /** Gasto por mês (UTC) e moeda, entre `from` (inclusive) e `to` (exclusivo): [{ month: 'YYYY-MM-01', currency, spend }] (spend na moeda da conta). */
    async spendByMonth(ownerId, from, to) {
      const { rows } = await db.query(
        `SELECT to_char(date_trunc('month', hour_start AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS month, currency, SUM(spend)::float8 AS spend
           FROM spend_ledger WHERE owner_id = $1 AND hour_start >= $2 AND hour_start < $3 GROUP BY 1, 2 ORDER BY 1, 2`,
        [ownerId, from.toISOString(), to.toISOString()],
      );
      return rows.map((r) => ({ month: r.month, currency: r.currency, spend: r.spend }));
    },

    /** Gasto de toda a vida de uma pessoa, por moeda (o livro permanente não some quando a BC é removida). */
    async spendTotals(ownerId) {
      const { rows } = await db.query('SELECT currency, SUM(spend)::float8 AS spend FROM spend_ledger WHERE owner_id = $1 GROUP BY currency ORDER BY currency', [ownerId]);
      return rows.map((r) => ({ currency: r.currency, spend: r.spend }));
    },

    // ---------- fechamentos ----------
    async listStatements(userId) {
      const { rows } = await db.query(
        `SELECT to_char(period, 'YYYY-MM-DD') AS period, monthly_fee_cents, percent_bp, spend_cents, percent_fee_cents, total_cents, unconverted, created_at
           FROM billing_statements WHERE user_id = $1 ORDER BY period`,
        [userId],
      );
      return rows.map((r) => ({
        period: r.period, monthlyFeeCents: r.monthly_fee_cents, percentBp: r.percent_bp, spendCents: cents(r.spend_cents),
        percentFeeCents: cents(r.percent_fee_cents), totalCents: cents(r.total_cents), unconverted: Array.isArray(r.unconverted) ? r.unconverted : [], closedAt: toIso(r.created_at),
      }));
    },
    /** Fecha o mês UMA vez (se já houver fechamento, não muda nada). Devolve true se criou. */
    async insertStatement({ userId, period, monthlyFeeCents, percentBp, spendCents, percentFeeCents, totalCents, unconverted }) {
      const { rowCount } = await db.query(
        `INSERT INTO billing_statements (user_id, period, monthly_fee_cents, percent_bp, spend_cents, percent_fee_cents, total_cents, unconverted)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8::jsonb) ON CONFLICT (user_id, period) DO NOTHING`,
        [userId, period, monthlyFeeCents, percentBp, spendCents, percentFeeCents, totalCents, JSON.stringify(unconverted)],
      );
      return rowCount > 0;
    },

    // ---------- pagamentos ----------
    async addPayment({ userId, amountCents, paidAt = null, note = null, registeredBy }) {
      const { rows } = await db.query(
        'INSERT INTO billing_payments (user_id, amount_cents, paid_at, note, registered_by) VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5) RETURNING id',
        [userId, amountCents, paidAt, note, registeredBy],
      );
      return rows[0].id;
    },
    async listPayments(userId) {
      const { rows } = await db.query(
        `SELECT p.id, p.amount_cents, to_char(p.paid_at, 'YYYY-MM-DD') AS paid_at, p.note, p.created_at, u.name AS registered_by_name
           FROM billing_payments p LEFT JOIN users u ON u.id = p.registered_by WHERE p.user_id = $1 ORDER BY p.paid_at DESC, p.id DESC`,
        [userId],
      );
      return rows.map((r) => ({ id: r.id, amountCents: cents(r.amount_cents), paidAt: day(r.paid_at), note: r.note, registeredByName: r.registered_by_name, createdAt: toIso(r.created_at) }));
    },

    // ---------- bloqueios ----------
    /** Cria os bloqueios (um por identificador). Os que já estavam ativos são mantidos. */
    async createLocks(ownerId, items, debtCents) {
      if (!items.length) return 0;
      const { rowCount } = await db.query(
        `INSERT INTO billing_locks (owner_id, kind, value, debt_cents)
         SELECT $1, t.kind, t.value, $4 FROM unnest($2::text[], $3::text[]) AS t(kind, value) ON CONFLICT DO NOTHING`,
        [ownerId, items.map((i) => i.kind), items.map((i) => i.value), debtCents],
      );
      return rowCount;
    },
    /** Bloqueios ATIVOS que batem com alguma destas BCs ou contas: [{ id, ownerId, kind, value }]. */
    async findActiveMatching({ bcIds, advertiserIds }) {
      const { rows } = await db.query(
        `SELECT id, owner_id, kind, value FROM billing_locks
          WHERE released_at IS NULL AND ((kind = 'bc' AND value = ANY($1::text[])) OR (kind = 'advertiser' AND value = ANY($2::text[])))
          ORDER BY id`,
        [bcIds, advertiserIds],
      );
      return rows.map((r) => ({ id: r.id, ownerId: r.owner_id, kind: r.kind, value: r.value }));
    },
    async release(ids, { by = null, reason }) {
      if (!ids.length) return 0;
      const { rowCount } = await db.query(
        'UPDATE billing_locks SET released_at = now(), released_by = $2, release_reason = $3 WHERE id = ANY($1::int[]) AND released_at IS NULL',
        [ids, by, reason],
      );
      return rowCount;
    },
    async getLock(id) {
      const { rows } = await db.query('SELECT id, owner_id, kind, value, released_at FROM billing_locks WHERE id = $1', [id]);
      return rows[0] ? { id: rows[0].id, ownerId: rows[0].owner_id, kind: rows[0].kind, value: rows[0].value, released: rows[0].released_at !== null } : null;
    },
    async listActiveLocks() {
      const { rows } = await db.query(
        `SELECT l.id, l.owner_id, l.kind, l.value, l.debt_cents, l.created_at, u.name AS owner_name, u.email AS owner_email
           FROM billing_locks l JOIN users u ON u.id = l.owner_id WHERE l.released_at IS NULL ORDER BY l.created_at DESC, l.id DESC`,
      );
      return rows.map((r) => ({ id: r.id, ownerId: r.owner_id, ownerName: r.owner_name, ownerEmail: r.owner_email, kind: r.kind, value: r.value, debtCentsAtLock: cents(r.debt_cents), createdAt: toIso(r.created_at) }));
    },
    async countActiveLocksByOwner() {
      const { rows } = await db.query('SELECT owner_id, COUNT(*)::int AS total FROM billing_locks WHERE released_at IS NULL GROUP BY owner_id');
      return new Map(rows.map((r) => [r.owner_id, r.total]));
    },

    // ---------- cotações ----------
    async listRates() {
      const { rows } = await db.query('SELECT currency, usd_per_unit::float8 AS usd_per_unit, updated_at FROM billing_rates ORDER BY currency');
      return rows.map((r) => ({ currency: r.currency, usdPerUnit: r.usd_per_unit, updatedAt: toIso(r.updated_at) }));
    },
    async setRate(currency, usdPerUnit, updatedBy) {
      await db.query(
        `INSERT INTO billing_rates (currency, usd_per_unit, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (currency) DO UPDATE SET usd_per_unit = EXCLUDED.usd_per_unit, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [currency, usdPerUnit, updatedBy],
      );
    },
  };
}
