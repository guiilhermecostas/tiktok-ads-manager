/**
 * Gasto por hora das contas de anúncio (tabela `tiktok_hourly_spend`). Só o servidor lê e grava; as consultas de leitura
 * sempre partem do usuário e enxergam apenas as conexões dele e as compartilhadas com a equipe (mesma regra das demais telas).
 */
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export function createHourlyRepository(db) {
  return {
    /**
     * Grava/atualiza as horas de UMA conta (upsert em lote). A linha da hora atual é reescrita a cada coleta; o valor mais novo vence.
     * `rows`: [{ hourStart: Date, spend, impressions, clicks, conversions }]. Devolve quantas linhas foram gravadas.
     */
    async upsertHours(bcRowId, advertiserId, currency, rows) {
      if (!rows.length) return 0;
      await db.query(
        `INSERT INTO tiktok_hourly_spend (business_center_id, advertiser_id, hour_start, currency, spend, impressions, clicks, conversions, fetched_at)
         SELECT $1, $2, t.hour_start, $3, t.spend, t.impressions, t.clicks, t.conversions, now()
           FROM unnest($4::timestamptz[], $5::numeric[], $6::bigint[], $7::bigint[], $8::numeric[]) AS t(hour_start, spend, impressions, clicks, conversions)
         ON CONFLICT (business_center_id, advertiser_id, hour_start)
         DO UPDATE SET currency = EXCLUDED.currency, spend = EXCLUDED.spend, impressions = EXCLUDED.impressions,
                       clicks = EXCLUDED.clicks, conversions = EXCLUDED.conversions, fetched_at = now()`,
        [
          bcRowId,
          advertiserId,
          currency,
          rows.map((r) => r.hourStart.toISOString()),
          rows.map((r) => Math.max(0, r.spend)),
          rows.map((r) => Math.max(0, Math.round(r.impressions))),
          rows.map((r) => Math.max(0, Math.round(r.clicks))),
          rows.map((r) => Math.max(0, r.conversions)),
        ],
      );
      return rows.length;
    },

    /** Contas da conexão que já têm alguma hora guardada (as outras recebem uma carga inicial de alguns dias). */
    async advertisersWithData(bcRowId) {
      const { rows } = await db.query('SELECT DISTINCT advertiser_id FROM tiktok_hourly_spend WHERE business_center_id = $1', [bcRowId]);
      return new Set(rows.map((r) => r.advertiser_id));
    },

    /** Apaga o que for mais antigo que `days` dias (o histórico não cresce para sempre). */
    async purgeOlderThan(days) {
      const { rowCount } = await db.query(`DELETE FROM tiktok_hourly_spend WHERE hour_start < now() - make_interval(days => $1::int)`, [days]);
      return rowCount;
    },

    /**
     * Série por hora (UTC) das contas visíveis ao usuário desde `since`, somada por moeda. Se a mesma conta existir em duas
     * conexões visíveis (a própria e uma compartilhada), vale a do próprio usuário: nunca soma duas vezes.
     * Devolve { rows: [{ currency, hour, spend, impressions, clicks, conversions }], firstHour, lastFetchedAt }.
     */
    async series(userId, { since, advertiserId = null }) {
      const scope = `
        WITH visible AS (
          SELECT DISTINCT ON (h.advertiser_id, h.hour_start) h.*
            FROM tiktok_hourly_spend h JOIN tiktok_business_centers bc ON bc.id = h.business_center_id
           WHERE (bc.owner_id = $1 OR bc.shared) AND h.hour_start >= $2 AND ($3::text IS NULL OR h.advertiser_id = $3)
           ORDER BY h.advertiser_id, h.hour_start, (bc.owner_id = $1) DESC, h.business_center_id
        )`;
      const params = [userId, since.toISOString(), advertiserId];
      const { rows } = await db.query(
        `${scope}
         SELECT COALESCE(currency, 'UNKNOWN') AS currency, date_trunc('hour', hour_start) AS hour,
                SUM(spend) AS spend, SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(conversions) AS conversions
           FROM visible GROUP BY 1, 2 ORDER BY 2, 1`,
        params,
      );
      const { rows: meta } = await db.query(`${scope} SELECT MIN(hour_start) AS first_hour, MAX(fetched_at) AS last_fetched FROM visible`, params);
      return {
        rows: rows.map((r) => ({ currency: r.currency, hour: new Date(r.hour), spend: num(r.spend), impressions: num(r.impressions), clicks: num(r.clicks), conversions: num(r.conversions) })),
        firstHour: meta[0]?.first_hour ? new Date(meta[0].first_hour) : null,
        lastFetchedAt: meta[0]?.last_fetched ? new Date(meta[0].last_fetched) : null,
      };
    },
  };
}
