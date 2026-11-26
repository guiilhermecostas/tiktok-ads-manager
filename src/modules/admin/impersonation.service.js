import { badRequest, forbidden, notFound } from '../../lib/http-error.js';

/** O acesso do admin à conta de outra pessoa dura no máximo 1 hora (depois disso a pessoa precisa entrar de novo como admin). */
export const IMPERSONATION_TTL_MS = 60 * 60 * 1000;

const STATUS_NAMES = { pending: 'pendente', rejected: 'rejeitada', blocked: 'bloqueada' };

/**
 * Acesso do admin à conta de um usuário ("ver como"):
 *  - só admin aprovado (a rota já exige), só contas COMUNS e APROVADAS (nunca outro admin, nunca a própria);
 *  - abre uma sessão NOVA da pessoa marcada com o admin, de prazo curto e somente leitura (a aplicação barra qualquer alteração);
 *  - tudo fica no registro de auditoria (início e fim).
 */
export function createImpersonationService({ users, sessions, audit }) {
  return {
    /** Abre a sessão como `targetId`. Devolve `{ session }` (token, csrfToken, expiresAt). */
    async start(admin, targetId, { ip } = {}) {
      const target = await users.findById(targetId);
      if (!target) throw notFound('Usuário não encontrado.');
      if (target.id === admin.id) throw badRequest('Você já está na sua conta.');
      if (target.role === 'admin') throw forbidden('Não é possível entrar na conta de outro administrador.');
      if (target.status !== 'approved') throw badRequest(`Só é possível entrar em contas aprovadas (esta está ${STATUS_NAMES[target.status] ?? target.status}).`);
      const session = await sessions.create(target.id, { impersonatorId: admin.id, ttl: IMPERSONATION_TTL_MS });
      await audit.record({ adminId: admin.id, targetId: target.id, action: 'impersonation_start', detail: `Entrou na conta de ${target.name} (${target.email})`, ip });
      return { session };
    },

    /**
     * Encerra o acesso (`adminId` = o admin que abriu; `targetId` = a conta vista). Com `reopen`, devolve uma sessão nova do admin
     * (`{ session }`); se ele já não for admin aprovado, devolve `{ session: null }` e ele precisa entrar de novo.
     */
    async stop({ adminId, targetId }, { ip, reopen = true } = {}) {
      await audit.record({ adminId, targetId, action: 'impersonation_end', detail: 'Saiu da conta', ip });
      if (!reopen) return { session: null };
      const admin = await users.findById(adminId);
      if (!admin || admin.role !== 'admin' || admin.status !== 'approved') return { session: null };
      return { session: await sessions.create(admin.id) };
    },
  };
}
