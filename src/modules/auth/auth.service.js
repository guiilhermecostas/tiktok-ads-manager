import { randomBytes } from 'node:crypto';
import { getDummyHash, hashPassword, verifyPassword } from '../../lib/password.js';
import { isUniqueViolation } from '../../db/helpers.js';
import { HttpError } from '../../lib/http-error.js';

const INVALID_CREDENTIALS = 'E-mail ou senha incorretos.';

export function createAuthService({ users, sessions, config }) {
  return {
    /**
     * Cadastro público. Toda conta nasce "pending" e só passa a navegar após aprovação do admin.
     * O e-mail do admin e e-mails já cadastrados recebem a MESMA resposta (sem enumeração de contas).
     */
    async register({ email, name, company, password }) {
      if (email === config.adminEmail || (await users.findByEmail(email))) {
        // Mantém o custo de CPU equivalente ao de um cadastro real.
        await hashPassword(password);
        return;
      }
      const passwordHash = await hashPassword(password);
      try {
        await users.create({ email, name, company, passwordHash, role: 'user', status: 'pending' });
      } catch (err) {
        // Corrida entre dois cadastros simultâneos do mesmo e-mail (UNIQUE).
        if (!isUniqueViolation(err)) throw err;
      }
    },

    async login({ email, password }) {
      const user = await users.findByEmail(email);
      const valid = await verifyPassword(password, user ? user.password_hash : await getDummyHash());
      if (!user || !valid) throw new HttpError(401, INVALID_CREDENTIALS, 'invalid_credentials');
      return { user, session: await sessions.create(user.id) };
    },

    /**
     * Garante a conta de administrador definida em ADMIN_EMAIL.
     * - Senha vem de ADMIN_PASSWORD; sem ela, uma senha aleatória é gerada e exibida uma única vez.
     * - Reexecutar com outra ADMIN_PASSWORD redefine a senha (recuperação) e encerra as sessões.
     */
    async ensureAdmin(log = console) {
      const existing = await users.findByEmail(config.adminEmail);
      let password = config.adminPassword;

      if (password && password.length < 10) {
        throw new Error('ADMIN_PASSWORD deve ter pelo menos 10 caracteres.');
      }

      if (!existing) {
        let generated = false;
        if (!password) {
          password = randomBytes(12).toString('base64url');
          generated = true;
        }
        await users.create({
          email: config.adminEmail,
          name: 'Administrador',
          company: null,
          passwordHash: await hashPassword(password),
          role: 'admin',
          status: 'approved',
        });
        log.info(`[admin] Conta de administrador criada: ${config.adminEmail}`);
        if (generated) log.info(`[admin] Senha gerada (exibida uma única vez): ${password}`);
        return;
      }

      const needsPromotion = existing.role !== 'admin' || existing.status !== 'approved';
      const passwordChanged = password && !(await verifyPassword(password, existing.password_hash));
      if (needsPromotion || passwordChanged) {
        const hash = passwordChanged ? await hashPassword(password) : existing.password_hash;
        await users.promoteToAdmin(existing.id, hash);
        await sessions.destroyAllForUser(existing.id);
        log.info('[admin] Conta de administrador sincronizada com o ambiente.');
      }
    },
  };
}
