import { toIso } from '../../db/helpers.js';

/** Todas as consultas são escopadas por user_id: um usuário nunca acessa campanhas de outro. */

function publishStatus(row) {
  if (row.tiktok_ad_id) return 'published';
  if (row.tiktok_campaign_id || row.tiktok_adgroup_id) return 'partial';
  return 'none';
}

function toCampaign(row, { withConfig = false } = {}) {
  if (!row) return null;
  const campaign = {
    id: row.id,
    name: row.name,
    objective: row.objective,
    dailyBudget: row.daily_budget,
    status: row.status,
    advertiserId: row.advertiser_id ?? null,
    wizard: row.config !== null && row.config !== undefined,
    publish: {
      status: publishStatus(row),
      campaignId: row.tiktok_campaign_id ?? null,
      adGroupId: row.tiktok_adgroup_id ?? null,
      adId: row.tiktok_ad_id ?? null,
      error: row.publish_error ?? null,
      publishedAt: toIso(row.published_at),
    },
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
  if (withConfig) campaign.config = row.config ?? null; // jsonb já chega como objeto
  return campaign;
}

export function createCampaignsRepository(db) {
  const selectOne = async (userId, id) => {
    const { rows } = await db.query('SELECT * FROM campaigns WHERE id = $1 AND user_id = $2', [id, userId]);
    return rows[0] ?? null;
  };
  const insert = async (userId, { name, objective, dailyBudget, status, config, advertiserId }) => {
    const { rows } = await db.query(
      `INSERT INTO campaigns (user_id, name, objective, daily_budget, status, config, advertiser_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
      [userId, name, objective, dailyBudget, status, config === null ? null : JSON.stringify(config), advertiserId],
    );
    return rows[0];
  };

  return {
    async create(userId, { name, objective, dailyBudget, status }) {
      return toCampaign(await insert(userId, { name, objective, dailyBudget, status, config: null, advertiserId: null }));
    },
    /** Campanha do assistente: a configuração completa fica em JSONB; o restante é resumo para a listagem. */
    async createWizard(userId, { name, objective, dailyBudget, config, advertiserId }) {
      const row = await insert(userId, { name, objective, dailyBudget, status: 'draft', config, advertiserId: advertiserId ?? null });
      return toCampaign(row, { withConfig: true });
    },
    async list(userId) {
      const { rows } = await db.query('SELECT * FROM campaigns WHERE user_id = $1 ORDER BY created_at DESC, id DESC', [userId]);
      return rows.map((row) => toCampaign(row));
    },
    async get(userId, id) {
      return toCampaign(await selectOne(userId, id), { withConfig: true });
    },
    async update(userId, id, { name, objective, dailyBudget, status }) {
      const { rows } = await db.query(
        `UPDATE campaigns SET name = $1, objective = $2, daily_budget = $3, status = $4, updated_at = now()
          WHERE id = $5 AND user_id = $6 RETURNING *`,
        [name, objective, dailyBudget, status, id, userId],
      );
      return toCampaign(rows[0], { withConfig: true });
    },
    async updateWizard(userId, id, { name, objective, dailyBudget, config, advertiserId }) {
      const { rows } = await db.query(
        `UPDATE campaigns SET name = $1, objective = $2, daily_budget = $3, config = $4::jsonb, advertiser_id = $5, updated_at = now()
          WHERE id = $6 AND user_id = $7 RETURNING *`,
        [name, objective, dailyBudget, JSON.stringify(config), advertiserId ?? null, id, userId],
      );
      return toCampaign(rows[0], { withConfig: true });
    },
    /** Registra o andamento da publicação (IDs criados no TikTok, erro e status local). */
    async saveProgress(userId, id, { campaignId = null, adGroupId = null, adId = null, error = null, publishedAt = null, status }) {
      const { rows } = await db.query(
        `UPDATE campaigns
            SET tiktok_campaign_id = $1, tiktok_adgroup_id = $2, tiktok_ad_id = $3, publish_error = $4, published_at = $5,
                status = $6, updated_at = now()
          WHERE id = $7 AND user_id = $8 RETURNING *`,
        [campaignId, adGroupId, adId, error, publishedAt ? new Date(publishedAt) : null, status, id, userId],
      );
      return toCampaign(rows[0], { withConfig: true });
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
