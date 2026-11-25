import { toIso } from '../../db/helpers.js';

const COLUMNS = 'id, connection_id, bc_id, advertiser_id, advertiser_name, direction, amount, currency, operation_id, status, transaction_ids, error_message, created_at, finished_at';

const toTransfer = (row) => ({
  id: row.id,
  connectionId: row.connection_id,
  bcId: row.bc_id,
  advertiserId: row.advertiser_id,
  advertiserName: row.advertiser_name,
  direction: row.direction,
  amount: Number(row.amount),
  currency: row.currency,
  operationId: row.operation_id,
  status: row.status,
  transactionIds: row.transaction_ids ? row.transaction_ids.split(',') : [],
  error: row.error_message,
  createdAt: toIso(row.created_at),
  finishedAt: row.finished_at ? toIso(row.finished_at) : null,
});

/**
 * Registro das transferências de saldo (BC ↔ conta de anúncio). Toda consulta é escopada por `user_id` (o dono do dinheiro): cada pessoa vê
 * só o próprio histórico. A chave única (user_id, operation_id) é o que impede mover o dinheiro duas vezes com a mesma operação.
 */
export function createBalanceTransfersRepository(db) {
  return {
    /** Cria o registro "pending" ANTES de falar com o TikTok. Lança o erro de chave única se a operação já existe. */
    async begin(userId, { connectionId, bcId, advertiserId, advertiserName, direction, amount, currency, operationId }) {
      const { rows } = await db.query(
        `INSERT INTO balance_transfers (user_id, connection_id, bc_id, advertiser_id, advertiser_name, direction, amount, currency, operation_id)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING ${COLUMNS}`,
        [userId, connectionId, bcId, advertiserId, advertiserName ? advertiserName.slice(0, 120) : null, direction, amount, currency, operationId],
      );
      return toTransfer(rows[0]);
    },

    /** Fecha o registro com o resultado (só se ainda estiver "pending": nunca reescreve uma transferência já concluída). */
    async finish(userId, id, { status, transactionIds = [], error = null }) {
      const { rows } = await db.query(
        `UPDATE balance_transfers
            SET status = $3, transaction_ids = $4, error_message = $5, finished_at = now()
          WHERE user_id = $1 AND id = $2 AND status = 'pending'
      RETURNING ${COLUMNS}`,
        [userId, id, status, transactionIds.length ? transactionIds.join(',').slice(0, 300) : null, error ? String(error).slice(0, 300) : null],
      );
      return rows[0] ? toTransfer(rows[0]) : null;
    },

    async findByOperation(userId, operationId) {
      const { rows } = await db.query(`SELECT ${COLUMNS} FROM balance_transfers WHERE user_id = $1 AND operation_id = $2`, [userId, operationId]);
      return rows[0] ? toTransfer(rows[0]) : null;
    },

    async listRecent(userId, limit = 20) {
      const { rows } = await db.query(`SELECT ${COLUMNS} FROM balance_transfers WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [userId, Math.min(Math.max(limit, 1), 50)]);
      return rows.map(toTransfer);
    },
  };
}
