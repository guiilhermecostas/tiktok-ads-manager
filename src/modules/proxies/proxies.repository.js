import { toIso } from '../../db/helpers.js';
import { decrypt, encrypt } from '../../lib/crypto.js';

/**
 * Proxies do usuário. Todas as consultas são escopadas por user_id (nunca se acessa a proxy de outro usuário).
 * Usuário e senha ficam juntos, criptografados, em `auth_enc` ({ username, password }); as visões "públicas" nunca trazem a senha.
 */

function readAuth(row, key) {
  if (!row.auth_enc) return { username: null, password: null };
  const { username = null, password = null } = JSON.parse(decrypt(row.auth_enc, key));
  return { username, password };
}

function toProxy(row, key, { withSecrets = false } = {}) {
  const { username, password } = readAuth(row, key);
  const proxy = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    host: row.host,
    port: row.port,
    username,
    hasPassword: Boolean(password),
    active: row.active === true,
    lastTest: row.last_test_at
      ? { at: toIso(row.last_test_at), ok: row.last_test_ok === true, ip: row.last_test_ip ?? null, country: row.last_test_country ?? null, error: row.last_test_error ?? null }
      : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
  return withSecrets ? { ...proxy, password } : proxy;
}

const sealAuth = (auth, key) => (auth && (auth.username || auth.password) ? encrypt(JSON.stringify({ username: auth.username ?? null, password: auth.password ?? null }), key) : null);

export function createProxiesRepository(db, { encryptionKey }) {
  const one = async (userId, id) => (await db.query('SELECT * FROM proxies WHERE id = $1 AND user_id = $2', [id, userId])).rows[0] ?? null;

  return {
    async list(userId) {
      const { rows } = await db.query('SELECT * FROM proxies WHERE user_id = $1 ORDER BY active DESC, lower(name), id', [userId]);
      return rows.map((row) => toProxy(row, encryptionKey));
    },
    async count(userId) {
      return (await db.query('SELECT COUNT(*)::int AS c FROM proxies WHERE user_id = $1', [userId])).rows[0].c;
    },
    async get(userId, id) {
      const row = await one(userId, id);
      return row ? toProxy(row, encryptionKey) : null;
    },
    /** Uso EXCLUSIVO do servidor (monta a conexão): inclui a senha em texto. */
    async getWithSecrets(userId, id) {
      const row = await one(userId, id);
      return row ? toProxy(row, encryptionKey, { withSecrets: true }) : null;
    },
    async getActiveWithSecrets(userId) {
      const { rows } = await db.query('SELECT * FROM proxies WHERE user_id = $1 AND active', [userId]);
      return rows[0] ? toProxy(rows[0], encryptionKey, { withSecrets: true }) : null;
    },

    async create(userId, { name, kind, host, port, auth }) {
      const { rows } = await db.query(
        'INSERT INTO proxies (user_id, name, kind, host, port, auth_enc) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [userId, name, kind, host, port, sealAuth(auth, encryptionKey)],
      );
      return toProxy(rows[0], encryptionKey);
    },

    /**
     * Atualiza os dados. `auth`: undefined mantém o que está salvo; null remove; objeto substitui.
     * Mudou o endereço ou as credenciais: o resultado do último teste deixa de valer e é apagado.
     */
    async update(userId, id, { name, kind, host, port, auth }) {
      const current = await one(userId, id);
      if (!current) return null;
      const authEnc = auth === undefined ? current.auth_enc : sealAuth(auth, encryptionKey);
      const connectionChanged = current.kind !== kind || current.host !== host || current.port !== port || authEnc !== current.auth_enc;
      const { rows } = await db.query(
        `UPDATE proxies SET name = $1, kind = $2, host = $3, port = $4, auth_enc = $5, updated_at = now(),
                last_test_at = CASE WHEN $6 THEN NULL ELSE last_test_at END, last_test_ok = CASE WHEN $6 THEN NULL ELSE last_test_ok END,
                last_test_ip = CASE WHEN $6 THEN NULL ELSE last_test_ip END, last_test_country = CASE WHEN $6 THEN NULL ELSE last_test_country END,
                last_test_error = CASE WHEN $6 THEN NULL ELSE last_test_error END
          WHERE id = $7 AND user_id = $8 RETURNING *`,
        [name, kind, host, port, authEnc, connectionChanged, id, userId],
      );
      return toProxy(rows[0], encryptionKey);
    },

    async remove(userId, id) {
      const { rowCount } = await db.query('DELETE FROM proxies WHERE id = $1 AND user_id = $2', [id, userId]);
      return rowCount > 0;
    },

    /** Ativa esta proxy e desativa a que estava ativa, de forma atômica (o índice único impede duas ativas). */
    async activate(userId, id) {
      return db.transaction(async (tx) => {
        if (!(await tx.query('SELECT 1 FROM proxies WHERE id = $1 AND user_id = $2', [id, userId])).rows.length) return null;
        await tx.query('UPDATE proxies SET active = false, updated_at = now() WHERE user_id = $1 AND active AND id <> $2', [userId, id]);
        const { rows } = await tx.query('UPDATE proxies SET active = true, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *', [id, userId]);
        return toProxy(rows[0], encryptionKey);
      });
    },
    async deactivate(userId, id) {
      const { rows } = await db.query('UPDATE proxies SET active = false, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *', [id, userId]);
      return rows[0] ? toProxy(rows[0], encryptionKey) : null;
    },

    async saveTest(userId, id, { ok, ip = null, country = null, error = null }) {
      const { rows } = await db.query(
        `UPDATE proxies SET last_test_at = now(), last_test_ok = $1, last_test_ip = $2, last_test_country = $3, last_test_error = $4
          WHERE id = $5 AND user_id = $6 RETURNING *`,
        [ok, ip, country, error ? String(error).slice(0, 300) : null, id, userId],
      );
      return rows[0] ? toProxy(rows[0], encryptionKey) : null;
    },
  };
}
