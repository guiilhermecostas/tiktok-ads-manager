import { toIso } from '../../db/helpers.js';

/** Acesso a dados de usuários. Todas as consultas são parametrizadas ($1, $2…). */

const PUBLIC_COLUMNS = 'id, email, name, company, role, status, created_at, reviewed_at';

export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    company: row.company,
    role: row.role,
    status: row.status,
    createdAt: toIso(row.created_at),
    reviewedAt: toIso(row.reviewed_at),
    // "versão" da foto de perfil (instante da última troca, em ms) para a tela buscar a imagem certa; null = sem foto
    avatarVersion: row.avatar_updated_at ? Date.parse(toIso(row.avatar_updated_at)) : null,
  };
}

export function createUsersRepository(db) {
  return {
    async create({ email, name, company, passwordHash, role = 'user', status = 'pending' }) {
      const { rows } = await db.query(
        `INSERT INTO users (email, name, company, password_hash, role, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [email, name, company ?? null, passwordHash, role, status],
      );
      return rows[0].id;
    },
    async findByEmail(email) {
      const { rows } = await db.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
      return rows[0] ?? null;
    },
    async findById(id) {
      const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
      return rows[0] ?? null;
    },
    async list(status) {
      const { rows } = status
        ? await db.query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE status = $1 ORDER BY created_at DESC, id DESC`, [status])
        : await db.query(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY created_at DESC, id DESC`);
      return rows.map(toPublicUser);
    },
    async updateName(id, name) {
      await db.query('UPDATE users SET name = $1 WHERE id = $2', [name, id]);
    },
    async updateStatus(id, status, reviewerId) {
      await db.query('UPDATE users SET status = $1, reviewed_at = now(), reviewed_by = $2 WHERE id = $3', [status, reviewerId, id]);
    },
    async promoteToAdmin(id, passwordHash) {
      await db.query("UPDATE users SET role = 'admin', status = 'approved', password_hash = $1 WHERE id = $2", [passwordHash, id]);
    },
    async counts() {
      const result = { pending: 0, approved: 0, rejected: 0, blocked: 0 };
      const { rows } = await db.query('SELECT status, COUNT(*)::int AS total FROM users GROUP BY status');
      for (const row of rows) result[row.status] = row.total;
      return result;
    },
  };
}
