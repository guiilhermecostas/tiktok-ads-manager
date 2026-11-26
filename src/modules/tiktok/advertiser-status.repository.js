import { toIso } from '../../db/helpers.js';

/**
 * Situação das contas de anúncio observada a cada coleta (`advertiser_status` = a mais recente; `advertiser_status_events` = cada mudança).
 * Só o servidor grava; a leitura sempre parte do dono. Consultas parametrizadas.
 */
export function createAdvertiserStatusRepository(db) {
  return {
    /**
     * Grava o que foi lido nesta coleta e registra um evento para cada MUDANÇA (inclusive a primeira vez que a conta é vista, com `previous` nulo).
     * `accounts`: [{ id, name, status }]; `at`: o instante da leitura (o relógio do servidor). Devolve quantos eventos foram criados.
     */
    async record(ownerId, accounts, at = new Date()) {
      if (!accounts.length) return 0;
      return db.transaction(async (tx) => {
        const { rows } = await tx.query('SELECT advertiser_id, status FROM advertiser_status WHERE owner_id = $1 AND advertiser_id = ANY($2::text[])', [ownerId, accounts.map((a) => a.id)]);
        const before = new Map(rows.map((r) => [r.advertiser_id, r.status]));
        const changed = accounts.filter((a) => before.get(a.id) !== a.status);
        if (changed.length) {
          await tx.query(
            `INSERT INTO advertiser_status_events (owner_id, advertiser_id, name, previous_status, status, observed_at)
             SELECT $1, t.id, t.name, NULLIF(t.previous, ''), t.status, $6::timestamptz FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS t(id, name, previous, status)`,
            [ownerId, changed.map((a) => a.id), changed.map((a) => a.name), changed.map((a) => before.get(a.id) ?? ''), changed.map((a) => a.status), at.toISOString()],
          );
        }
        await tx.query(
          `INSERT INTO advertiser_status (owner_id, advertiser_id, name, status, since, checked_at)
           SELECT $1, t.id, t.name, t.status, $5::timestamptz, $5::timestamptz FROM unnest($2::text[], $3::text[], $4::text[]) AS t(id, name, status)
           ON CONFLICT (owner_id, advertiser_id)
           DO UPDATE SET name = EXCLUDED.name, checked_at = EXCLUDED.checked_at,
                         since = CASE WHEN advertiser_status.status = EXCLUDED.status THEN advertiser_status.since ELSE EXCLUDED.since END,
                         status = EXCLUDED.status`,
          [ownerId, accounts.map((a) => a.id), accounts.map((a) => a.name), accounts.map((a) => a.status), at.toISOString()],
        );
        return changed.length;
      });
    },

    /** Mudanças vistas entre `from` e `to`: [{ advertiserId, name, previousStatus, status, at }], da mais recente para a mais antiga. */
    async eventsBetween(ownerId, from, to) {
      const { rows } = await db.query(
        `SELECT advertiser_id, name, previous_status, status, observed_at FROM advertiser_status_events
          WHERE owner_id = $1 AND observed_at >= $2 AND observed_at < $3 ORDER BY observed_at DESC, id DESC LIMIT 500`,
        [ownerId, from.toISOString(), to.toISOString()],
      );
      return rows.map((r) => ({ advertiserId: r.advertiser_id, name: r.name, previousStatus: r.previous_status, status: r.status, at: toIso(r.observed_at) }));
    },

    /** Contas que NESTE momento não estão "STATUS_ENABLE": [{ advertiserId, name, status, since }]. */
    async currentlyNotEnabled(ownerId) {
      const { rows } = await db.query(
        "SELECT advertiser_id, name, status, since FROM advertiser_status WHERE owner_id = $1 AND status <> 'STATUS_ENABLE' ORDER BY since DESC",
        [ownerId],
      );
      return rows.map((r) => ({ advertiserId: r.advertiser_id, name: r.name, status: r.status, since: toIso(r.since) }));
    },

    /** Quando o monitoramento começou para esta pessoa (a primeira observação), ou null. */
    async monitoredSince(ownerId) {
      const { rows } = await db.query('SELECT MIN(observed_at) AS first FROM advertiser_status_events WHERE owner_id = $1', [ownerId]);
      return rows[0]?.first ? toIso(rows[0].first) : null;
    },
    async totalMonitored(ownerId) {
      const { rows } = await db.query('SELECT COUNT(*)::int AS total FROM advertiser_status WHERE owner_id = $1', [ownerId]);
      return rows[0].total;
    },
  };
}
