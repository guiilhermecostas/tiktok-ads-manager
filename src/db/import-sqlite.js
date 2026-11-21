import { DatabaseSync } from 'node:sqlite';

/**
 * Importação ÚNICA dos dados do banco antigo (SQLite, versão de esquema 2) para o PostgreSQL atual.
 * - Preserva os IDs (e acerta as sequências para os próximos IDs continuarem de onde pararam).
 * - NÃO copia sessões: todos precisam entrar de novo (os tokens de sessão são recriados).
 * - Só roda em banco de destino SEM usuários, e tudo acontece em uma única transação (ou entra tudo, ou nada).
 */
const EXPECTED_SQLITE_VERSION = 2;

const readAll = (src, sql) => src.prepare(sql).all();
const text = (v) => (v === null || v === undefined ? null : String(v));

export async function importFromSqlite({ sqlitePath, db, dryRun = false }) {
  const src = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const version = src.prepare('PRAGMA user_version').get().user_version;
    if (version !== EXPECTED_SQLITE_VERSION) {
      throw new Error(`O banco SQLite está na versão de esquema ${version} (esperada: ${EXPECTED_SQLITE_VERSION}). Abra-o uma vez com a versão anterior do sistema para atualizá-lo.`);
    }

    const data = {
      users: readAll(src, 'SELECT * FROM users ORDER BY id'),
      campaigns: readAll(src, 'SELECT * FROM campaigns ORDER BY id'),
      businessCenters: readAll(src, 'SELECT * FROM tiktok_business_centers ORDER BY id'),
      advertisers: readAll(src, 'SELECT * FROM tiktok_advertisers'),
    };
    const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));

    const { rows } = await db.query('SELECT COUNT(*)::int AS total FROM users');
    if (rows[0].total > 0) throw new Error('O banco de destino já tem usuários. A importação só roda em um banco vazio (para não misturar dados).');
    if (dryRun) return { counts, imported: false };

    await db.transaction(async (tx) => {
      for (const u of data.users) {
        // reviewed_by entra depois (referência a outro usuário que pode ainda não existir).
        await tx.query(
          `INSERT INTO users (id, email, name, company, password_hash, role, status, created_at, reviewed_at)
           OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)`,
          [u.id, u.email, u.name, text(u.company), u.password_hash, u.role, u.status, text(u.created_at), text(u.reviewed_at)],
        );
      }
      for (const u of data.users.filter((x) => x.reviewed_by !== null)) {
        await tx.query('UPDATE users SET reviewed_by = $1 WHERE id = $2', [u.reviewed_by, u.id]);
      }
      for (const c of data.campaigns) {
        await tx.query(
          `INSERT INTO campaigns (id, user_id, name, objective, daily_budget, status, config, created_at, updated_at)
           OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9::timestamptz)`,
          [c.id, c.user_id, c.name, c.objective, c.daily_budget, c.status, text(c.config), text(c.created_at), text(c.updated_at)],
        );
        // O banco antigo guardava UMA publicação por campanha nas próprias colunas: no modelo novo vira uma linha por conta.
        const advertiserId = text(c.advertiser_id);
        const hadPublication = [c.tiktok_campaign_id, c.tiktok_adgroup_id, c.tiktok_ad_id, c.publish_error].some((v) => text(v) !== null);
        if (advertiserId && /^\d{1,24}$/.test(advertiserId) && hadPublication) {
          await tx.query(
            `INSERT INTO campaign_publications (campaign_id, advertiser_id, tiktok_campaign_id, tiktok_adgroup_id, tiktok_ad_id, error, published_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz)`,
            [c.id, advertiserId, text(c.tiktok_campaign_id), text(c.tiktok_adgroup_id), text(c.tiktok_ad_id), text(c.publish_error), text(c.published_at), text(c.created_at), text(c.updated_at)],
          );
        }
      }
      for (const bc of data.businessCenters) {
        await tx.query(
          `INSERT INTO tiktok_business_centers (id, owner_id, bc_id, name, access_token, shared, status, last_error, last_synced_at, created_at)
           OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz)`,
          [bc.id, bc.owner_id, bc.bc_id, bc.name, bc.access_token, bc.shared === 1, bc.status, text(bc.last_error), text(bc.last_synced_at), text(bc.created_at)],
        );
      }
      for (const a of data.advertisers) {
        await tx.query(
          'INSERT INTO tiktok_advertisers (business_center_id, advertiser_id, name, currency, timezone) VALUES ($1, $2, $3, $4, $5)',
          [a.business_center_id, a.advertiser_id, a.name, text(a.currency), text(a.timezone)],
        );
      }
      // Os próximos IDs gerados pelo banco continuam depois do maior ID importado.
      for (const table of ['users', 'campaigns', 'tiktok_business_centers']) {
        await tx.query(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1), (SELECT COUNT(*) > 0 FROM ${table}))`,
        );
      }
    });
    return { counts, imported: true };
  } finally {
    src.close();
  }
}
