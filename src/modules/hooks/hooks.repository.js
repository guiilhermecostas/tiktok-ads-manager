import { toIso } from '../../db/helpers.js';

/** Visão pública de um pedido de hook (nunca expõe storage_key nem o código da tarefa na Kling). */
function toHook(row) {
  return {
    id: row.id,
    style: row.style,
    idea: row.idea ?? null,
    durationMs: row.duration_ms,
    status: row.status,
    errorMessage: row.error_message ?? null,
    hasFile: row.storage_key !== null && row.storage_key !== undefined,
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    applying: row.apply_status === 'running',
    applyError: row.apply_status === 'failed' ? (row.apply_error ?? 'Não foi possível aplicar o hook.') : null,
    creativeId: row.creative_id ?? null,
    createdAt: toIso(row.created_at),
    submittedAt: toIso(row.submitted_at),
    readyAt: toIso(row.ready_at),
  };
}

const ACTIVE = "('queued', 'generating', 'processing')";

/** Pedidos de hook. Toda consulta de LEITURA é escopada por user_id; as internas (`...Internal`) são só do processador do servidor. */
export function createHooksRepository(db) {
  return {
    async create(userId, { style, idea, durationMs }) {
      const { rows } = await db.query('INSERT INTO creative_hooks (user_id, style, idea, duration_ms) VALUES ($1, $2, $3, $4) RETURNING id', [userId, style, idea || null, durationMs]);
      return rows[0].id;
    },

    async list(userId, limit = 30) {
      const { rows } = await db.query('SELECT * FROM creative_hooks WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [userId, limit]);
      return rows.map(toHook);
    },
    async get(userId, id) {
      const { rows } = await db.query('SELECT * FROM creative_hooks WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ? toHook(rows[0]) : null;
    },
    /** Linha completa (com storage_key): uso interno do servidor. */
    async getInternal(userId, id) {
      const { rows } = await db.query('SELECT * FROM creative_hooks WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ?? null;
    },

    /** Quantos pedidos o usuário fez nas últimas 24 h, e quantos estão em andamento (limites de custo). */
    async usage(userId) {
      const { rows } = await db.query(
        `SELECT COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h,
                COUNT(*) FILTER (WHERE status IN ${ACTIVE})::int AS active
           FROM creative_hooks WHERE user_id = $1`,
        [userId],
      );
      return { last24h: rows[0].last_24h, active: rows[0].active };
    },
    async globalLast24h() {
      const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM creative_hooks WHERE created_at > now() - interval '24 hours'");
      return rows[0].n;
    },

    // ---------- processador (servidor) ----------
    async queued(limit) {
      const { rows } = await db.query("SELECT * FROM creative_hooks WHERE status = 'queued' ORDER BY id LIMIT $1", [limit]);
      return rows;
    },
    async generating() {
      const { rows } = await db.query("SELECT * FROM creative_hooks WHERE status = 'generating' ORDER BY id");
      return rows;
    },
    async countInFlight() {
      const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM creative_hooks WHERE status IN ('generating', 'processing')");
      return rows[0].n;
    },
    async markGenerating(id, taskId) {
      await db.query("UPDATE creative_hooks SET status = 'generating', kling_task_id = $2, submitted_at = now(), updated_at = now(), attempts = attempts + 1 WHERE id = $1", [id, taskId]);
    },
    async retryLater(id) {
      await db.query('UPDATE creative_hooks SET attempts = attempts + 1, updated_at = now() WHERE id = $1', [id]);
    },
    async markProcessing(id) {
      await db.query("UPDATE creative_hooks SET status = 'processing', updated_at = now() WHERE id = $1 AND status = 'generating'", [id]);
    },
    async markReady(id, { storageKey, sizeBytes }) {
      await db.query("UPDATE creative_hooks SET status = 'ready', storage_key = $2, size_bytes = $3, error_code = NULL, error_message = NULL, ready_at = now(), updated_at = now() WHERE id = $1", [id, storageKey, sizeBytes]);
    },
    async markFailed(id, { code, message }) {
      await db.query("UPDATE creative_hooks SET status = 'failed', error_code = $2, error_message = $3, updated_at = now() WHERE id = $1", [id, String(code).slice(0, 40), String(message).slice(0, 300)]);
    },
    /**
     * Depois de uma queda do servidor: o que estava processando volta a "gerando" (a tarefa na Kling continua existindo). As aplicações
     * (junção ao vídeo) NÃO são mexidas aqui: o serviço as retoma (`runningApplies`).
     */
    async recoverStuck() {
      await db.query("UPDATE creative_hooks SET status = 'generating', updated_at = now() WHERE status = 'processing' AND kling_task_id IS NOT NULL");
      await db.query("UPDATE creative_hooks SET status = 'failed', error_code = 'interrupted', error_message = 'O processamento foi interrompido. Gere o hook de novo.', updated_at = now() WHERE status = 'processing'");
    },

    // ---------- aplicar a um vídeo ----------
    /**
     * Marca "aplicando" só se estiver pronto e sem outra aplicação em andamento (evita clique duplo). Guarda o vídeo escolhido e o nome do
     * resultado: se o servidor reiniciar no meio, a junção é retomada com os mesmos dados.
     */
    async beginApply(userId, id, { creativeId = null, name }) {
      const { rowCount } = await db.query(
        `UPDATE creative_hooks SET apply_status = 'running', apply_error = NULL, apply_creative_id = $3, apply_with_video = $5, apply_name = $4, apply_attempts = 0, updated_at = now()
          WHERE user_id = $1 AND id = $2 AND status = 'ready' AND apply_status IS DISTINCT FROM 'running'`,
        [userId, id, creativeId, name, creativeId !== null],
      );
      return rowCount > 0;
    },
    async finishApply(id, { creativeId = null, error = null }) {
      await db.query(
        `UPDATE creative_hooks SET apply_status = $2, apply_error = $3, creative_id = COALESCE($4, creative_id), apply_creative_id = NULL, apply_with_video = false, apply_name = NULL, updated_at = now() WHERE id = $1`,
        [id, error ? 'failed' : null, error ? String(error).slice(0, 300) : null, creativeId],
      );
    },
    /** Aplicações que estavam em andamento (usadas ao subir o servidor para retomá-las). */
    async runningApplies() {
      const { rows } = await db.query("SELECT * FROM creative_hooks WHERE apply_status = 'running' AND status = 'ready' ORDER BY id");
      return rows;
    },
    /** Conta mais uma retomada e devolve o total (limita um problema que derruba o servidor sempre no mesmo ponto). */
    async bumpApplyAttempt(id) {
      const { rows } = await db.query('UPDATE creative_hooks SET apply_attempts = apply_attempts + 1, updated_at = now() WHERE id = $1 RETURNING apply_attempts', [id]);
      return rows[0]?.apply_attempts ?? 0;
    },

    async remove(userId, id) {
      const { rows } = await db.query('DELETE FROM creative_hooks WHERE user_id = $1 AND id = $2 RETURNING storage_key', [userId, id]);
      return rows[0] ?? null;
    },
    /** Apaga os pedidos mais antigos que `days` dias (e devolve os arquivos a apagar do disco). */
    async purgeOlderThan(days) {
      const { rows } = await db.query("DELETE FROM creative_hooks WHERE created_at < now() - make_interval(days => $1::int) AND status IN ('ready', 'failed') RETURNING storage_key", [days]);
      return rows.map((r) => r.storage_key).filter(Boolean);
    },
  };
}
