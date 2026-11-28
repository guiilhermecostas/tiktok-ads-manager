import { toIso } from '../../db/helpers.js';

/**
 * Todas as consultas são escopadas por user_id: um usuário nunca acessa campanhas de outro.
 *
 * Modelo: a CAMPANHA guarda a configuração (rascunho). Cada publicação no TikTok é uma linha de `campaign_publications`,
 * uma por (campanha, conta de anúncio), com os IDs criados no TikTok, o último erro e os ajustes de IDs daquela conta.
 */

/** Estado de UMA publicação: concluída (anúncio criado), parcial (algum nível criado) ou falha (nada criado). */
function publicationStatus(row) {
  if (row.tiktok_ad_id) return 'published';
  if (row.tiktok_campaign_id || row.tiktok_adgroup_id) return 'partial';
  return 'failed';
}

function toPublication(row) {
  return {
    advertiserId: row.advertiser_id,
    status: publicationStatus(row),
    tiktokCampaignId: row.tiktok_campaign_id ?? null,
    tiktokAdGroupId: row.tiktok_adgroup_id ?? null,
    tiktokAdId: row.tiktok_ad_id ?? null,
    overrides: row.overrides ?? null,
    error: row.error ?? null,
    publishedAt: toIso(row.published_at),
  };
}

/**
 * Resumo de TODAS as publicações da campanha.
 *  - status: 'partial' se alguma ficou pela metade; 'published' se ao menos uma concluiu; senão 'none' (inclui só falhas).
 *  - locks: o que já existe no TikTok e, por isso, não pode mais mudar na configuração (a mesma configuração precisa valer
 *    para todas as contas): campanha criada trava Objetivo/Campanha; grupo criado trava o Grupo; anúncio concluído trava tudo.
 */
function publishInfo({ published = 0, partial = 0, failed = 0, hasCampaign = false, hasAdGroup = false, hasAd = false, error = null, publishedAt = null }) {
  return {
    status: partial > 0 ? 'partial' : published > 0 ? 'published' : 'none',
    published,
    partial,
    failed,
    locks: { campaign: hasCampaign, adGroup: hasAdGroup, ad: hasAd },
    error,
    publishedAt: toIso(publishedAt),
  };
}

function infoFromRows(rows) {
  const statuses = rows.map(publicationStatus);
  const errors = rows.filter((r) => r.error).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  const dates = rows.filter((r) => r.published_at).map((r) => new Date(r.published_at).getTime());
  return publishInfo({
    published: statuses.filter((s) => s === 'published').length,
    partial: statuses.filter((s) => s === 'partial').length,
    failed: statuses.filter((s) => s === 'failed').length,
    hasCampaign: rows.some((r) => r.tiktok_campaign_id),
    hasAdGroup: rows.some((r) => r.tiktok_adgroup_id),
    hasAd: rows.some((r) => r.tiktok_ad_id),
    error: errors[0]?.error ?? null,
    publishedAt: dates.length ? new Date(Math.max(...dates)) : null,
  });
}

function toCampaign(row, { withConfig = false, publications } = {}) {
  if (!row) return null;
  const campaign = {
    id: row.id,
    name: row.name,
    objective: row.objective,
    dailyBudget: row.daily_budget,
    status: row.status,
    wizard: row.config !== null && row.config !== undefined,
    publish: publications ? infoFromRows(publications) : publishInfo({
      published: row.pub_published ?? 0,
      partial: row.pub_partial ?? 0,
      failed: row.pub_failed ?? 0,
      hasCampaign: row.pub_has_campaign === true,
      hasAdGroup: row.pub_has_adgroup === true,
      hasAd: row.pub_has_ad === true,
      error: row.pub_error ?? null,
      publishedAt: row.pub_published_at ?? null,
    }),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
  if (withConfig) {
    campaign.config = row.config ?? null; // jsonb já chega como objeto
    campaign.publications = (publications ?? []).map(toPublication);
  }
  return campaign;
}

/** Agrega as publicações de cada campanha em uma única consulta (a listagem não faz uma consulta por linha). */
const LIST_SQL = `
  SELECT c.*,
         COALESCE(p.published, 0) AS pub_published, COALESCE(p.partial, 0) AS pub_partial, COALESCE(p.failed, 0) AS pub_failed,
         COALESCE(p.has_campaign, false) AS pub_has_campaign, COALESCE(p.has_adgroup, false) AS pub_has_adgroup, COALESCE(p.has_ad, false) AS pub_has_ad,
         p.last_error AS pub_error, p.last_published_at AS pub_published_at
    FROM campaigns c
    LEFT JOIN (
      SELECT campaign_id,
             COUNT(*) FILTER (WHERE tiktok_ad_id IS NOT NULL)::int AS published,
             COUNT(*) FILTER (WHERE tiktok_ad_id IS NULL AND (tiktok_campaign_id IS NOT NULL OR tiktok_adgroup_id IS NOT NULL))::int AS partial,
             COUNT(*) FILTER (WHERE tiktok_ad_id IS NULL AND tiktok_campaign_id IS NULL AND tiktok_adgroup_id IS NULL)::int AS failed,
             BOOL_OR(tiktok_campaign_id IS NOT NULL) AS has_campaign,
             BOOL_OR(tiktok_adgroup_id IS NOT NULL) AS has_adgroup,
             BOOL_OR(tiktok_ad_id IS NOT NULL) AS has_ad,
             (ARRAY_AGG(error ORDER BY updated_at DESC) FILTER (WHERE error IS NOT NULL))[1] AS last_error,
             MAX(published_at) AS last_published_at
        FROM campaign_publications GROUP BY campaign_id
    ) p ON p.campaign_id = c.id
   WHERE c.user_id = $1
   ORDER BY c.created_at DESC, c.id DESC`;

export function createCampaignsRepository(db) {
  const selectOne = async (userId, id) => {
    const { rows } = await db.query('SELECT * FROM campaigns WHERE id = $1 AND user_id = $2', [id, userId]);
    return rows[0] ?? null;
  };
  const publicationRows = async (campaignId) => {
    const { rows } = await db.query('SELECT * FROM campaign_publications WHERE campaign_id = $1 ORDER BY created_at, id', [campaignId]);
    return rows;
  };
  const insert = async (userId, { name, objective, dailyBudget, status, config }) => {
    const { rows } = await db.query(
      `INSERT INTO campaigns (user_id, name, objective, daily_budget, status, config)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
      [userId, name, objective, dailyBudget, status, config === null ? null : JSON.stringify(config)],
    );
    return rows[0];
  };
  /** Campanha com a configuração e todas as publicações (o dono já foi conferido em `row`). */
  const full = async (row) => (row ? toCampaign(row, { withConfig: true, publications: await publicationRows(row.id) }) : null);

  return {
    async create(userId, { name, objective, dailyBudget, status }) {
      return toCampaign(await insert(userId, { name, objective, dailyBudget, status, config: null }));
    },
    /** Campanha do assistente: a configuração completa fica em JSONB; o restante é resumo para a listagem. */
    async createWizard(userId, { name, objective, dailyBudget, config }) {
      return full(await insert(userId, { name, objective, dailyBudget, status: 'draft', config }));
    },
    async list(userId) {
      const { rows } = await db.query(LIST_SQL, [userId]);
      return rows.map((row) => toCampaign(row));
    },
    async get(userId, id) {
      return full(await selectOne(userId, id));
    },
    async update(userId, id, { name, objective, dailyBudget, status }) {
      const { rows } = await db.query(
        `UPDATE campaigns SET name = $1, objective = $2, daily_budget = $3, status = $4, updated_at = now()
          WHERE id = $5 AND user_id = $6 RETURNING *`,
        [name, objective, dailyBudget, status, id, userId],
      );
      return full(rows[0]);
    },
    async updateWizard(userId, id, { name, objective, dailyBudget, config }) {
      const { rows } = await db.query(
        `UPDATE campaigns SET name = $1, objective = $2, daily_budget = $3, config = $4::jsonb, updated_at = now()
          WHERE id = $5 AND user_id = $6 RETURNING *`,
        [name, objective, dailyBudget, JSON.stringify(config), id, userId],
      );
      return full(rows[0]);
    },

    /** Publicação desta campanha em uma conta (ou null). Só existe para campanhas do usuário. */
    async getPublication(userId, id, advertiserId) {
      const { rows } = await db.query(
        `SELECT p.* FROM campaign_publications p JOIN campaigns c ON c.id = p.campaign_id
          WHERE c.id = $1 AND c.user_id = $2 AND p.advertiser_id = $3`,
        [id, userId, advertiserId],
      );
      return rows[0] ? toPublication(rows[0]) : null;
    },
    /**
     * Registra o andamento da publicação em UMA conta (cria a linha na primeira vez). O INSERT só acontece se a campanha
     * for do usuário: mesmo que o chamador erre, não dá para gravar na campanha de outro.
     */
    async saveProgress(userId, id, advertiserId, { overrides = null, tiktokCampaignId = null, tiktokAdGroupId = null, tiktokAdId = null, error = null, publishedAt = null }) {
      const { rows } = await db.query(
        `INSERT INTO campaign_publications (campaign_id, advertiser_id, overrides, tiktok_campaign_id, tiktok_adgroup_id, tiktok_ad_id, error, published_at)
         SELECT c.id, $3, $4::jsonb, $5, $6, $7, $8, $9 FROM campaigns c WHERE c.id = $1 AND c.user_id = $2
         ON CONFLICT (campaign_id, advertiser_id) DO UPDATE
           SET overrides = EXCLUDED.overrides, tiktok_campaign_id = EXCLUDED.tiktok_campaign_id, tiktok_adgroup_id = EXCLUDED.tiktok_adgroup_id,
               tiktok_ad_id = EXCLUDED.tiktok_ad_id, error = EXCLUDED.error, published_at = EXCLUDED.published_at, updated_at = now()
         RETURNING *`,
        [id, userId, advertiserId, overrides === null ? null : JSON.stringify(overrides), tiktokCampaignId, tiktokAdGroupId, tiktokAdId, error, publishedAt ? new Date(publishedAt) : null],
      );
      return rows[0] ? toPublication(rows[0]) : null;
    },
    /**
     * Campanha que uma tentativa ANTERIOR deste usuário criou no TikTok nesta conta e que ficou sem grupo de anúncios (a publicação parou no meio), de OUTRO rascunho com o mesmo nome.
     * Serve para uma nova tentativa (ex.: a mesma configuração one-click rodada de novo) reaproveitar a campanha em vez de esbarrar em "Campaign name already exists".
     * Devolve { publicationId, tiktokCampaignId, config } ou null. Só enxerga publicações do próprio usuário.
     */
    async findOrphanCampaign(userId, advertiserId, { name, excludeId }) {
      const { rows } = await db.query(
        `SELECT p.id AS publication_id, p.tiktok_campaign_id, c.config
           FROM campaign_publications p JOIN campaigns c ON c.id = p.campaign_id
          WHERE c.user_id = $1 AND p.advertiser_id = $2 AND p.campaign_id <> $3 AND lower(c.name) = lower($4)
            AND p.tiktok_campaign_id IS NOT NULL AND p.tiktok_adgroup_id IS NULL AND p.published_at IS NULL
          ORDER BY p.updated_at DESC, p.id DESC LIMIT 1`,
        [userId, advertiserId, excludeId, name],
      );
      return rows[0] ? { publicationId: rows[0].publication_id, tiktokCampaignId: rows[0].tiktok_campaign_id, config: rows[0].config } : null;
    },
    /** Solta a campanha do TikTok de uma publicação (ela foi reaproveitada por outra): a linha antiga não a reivindica de novo. */
    async releaseOrphanCampaign(userId, publicationId) {
      await db.query(
        `UPDATE campaign_publications p SET tiktok_campaign_id = NULL, error = 'A campanha criada aqui foi reaproveitada por uma publicação mais nova.', updated_at = now()
           FROM campaigns c WHERE p.id = $1 AND c.id = p.campaign_id AND c.user_id = $2`,
        [publicationId, userId],
      );
    },
    /** Status local da campanha (passa a "pausada" quando alguma publicação conclui: é assim que nasce no TikTok). */
    async setStatus(userId, id, status) {
      const { rows } = await db.query('UPDATE campaigns SET status = $1, updated_at = now() WHERE id = $2 AND user_id = $3 RETURNING *', [status, id, userId]);
      return full(rows[0]);
    },

    async remove(userId, id) {
      const { rowCount } = await db.query('DELETE FROM campaigns WHERE id = $1 AND user_id = $2', [id, userId]);
      return rowCount > 0;
    },
    async summary(userId) {
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE status = 'paused')::int AS paused,
                COUNT(*) FILTER (WHERE status = 'draft')::int AS draft,
                COALESCE(SUM(daily_budget) FILTER (WHERE status = 'active'), 0)::bigint AS "activeBudget"
           FROM campaigns WHERE user_id = $1`,
        [userId],
      );
      return { ...rows[0], activeBudget: Number(rows[0].activeBudget) };
    },
  };
}
