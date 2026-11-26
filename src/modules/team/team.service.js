import { createHash, randomBytes } from 'node:crypto';
import { MAX_TEAM_SIZE } from '../../../shared/permissions.js';
import { hashPassword } from '../../lib/password.js';
import { HttpError, badRequest, notFound } from '../../lib/http-error.js';
import { inviteEmail } from '../mail/templates.js';

export const INVITE_TTL_DAYS = 7;
const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
const INVALID_INVITE = 'Convite inválido ou expirado. Peça um novo convite a quem convidou você.';

/** O token só existe no e-mail; o banco guarda apenas o hash (um vazamento do banco não entrega convites utilizáveis). */
export const hashInviteToken = (token) => createHash('sha256').update(token).digest('hex');
export const newInviteToken = () => randomBytes(32).toString('base64url'); // 43 caracteres

/**
 * Colaboradores: o dono convida pessoas por e-mail e escolhe as áreas. Cada colaborador entra com a PRÓPRIA senha
 * (ninguém compartilha login) e trabalha dentro do espaço do dono. `actor` é sempre o dono logado: { id, name, email }.
 */
export function createTeamService({ repo, mailer, sessions, activity = null, config, log = console }) {
  const link = (token) => `${config.mail.appUrl}/invite#${token}`;

  async function sendInvite(owner, invite, token) {
    const { subject, html, text } = inviteEmail({ ownerName: owner.name, inviteeName: invite.name, areas: invite.areas, link: link(token), expiresInDays: INVITE_TTL_DAYS });
    await mailer.send({ to: invite.email, subject, html, text, idempotencyKey: `invite-${invite.id}-${hashInviteToken(token).slice(0, 16)}` });
  }

  return {
    async overview(actor) {
      const [members, invites] = await Promise.all([repo.listMembers(actor.id), repo.listInvites(actor.id)]);
      return { emailEnabled: mailer.enabled, maxTeamSize: MAX_TEAM_SIZE, inviteTtlDays: INVITE_TTL_DAYS, members, invites };
    },

    /**
     * Cria o convite e envia o e-mail. Convidar de novo o mesmo e-mail substitui o convite anterior (o link antigo deixa de valer).
     * Se o e-mail falhar, o convite continua salvo (`emailSent: false`) e o dono usa "Reenviar".
     */
    async invite(actor, { email, name, areas }) {
      if (!mailer.enabled) throw new HttpError(503, 'O envio de e-mails não está configurado neste servidor.', 'email_not_configured');
      if (email === String(actor.email).toLowerCase() || email === config.adminEmail) throw badRequest('Use o e-mail da pessoa que vai receber o acesso (não o seu).');
      if (await repo.hasMemberWithEmail(actor.id, email)) throw new HttpError(409, 'Esta pessoa já é colaboradora.', 'conflict');
      const hasPending = (await repo.listInvites(actor.id)).some((i) => i.email.toLowerCase() === email);
      if (!hasPending && (await repo.countTeam(actor.id)) >= MAX_TEAM_SIZE) throw badRequest(`Limite de ${MAX_TEAM_SIZE} colaboradores e convites atingido.`);

      const token = newInviteToken();
      const invite = await repo.upsertInvite(actor.id, { email, name, areas, tokenHash: hashInviteToken(token), expiresAt: Date.now() + INVITE_TTL_MS });
      try {
        await sendInvite(actor, invite, token);
        return { invite, emailSent: true };
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        log.error(`[colaboradores] convite ${invite.id} salvo, mas o e-mail não foi enviado (${err.code}).`);
        return { invite, emailSent: false };
      }
    },

    /** Novo link (o anterior deixa de valer) e novo e-mail, com validade renovada. */
    async resend(actor, id) {
      if (!mailer.enabled) throw new HttpError(503, 'O envio de e-mails não está configurado neste servidor.', 'email_not_configured');
      const token = newInviteToken();
      const invite = await repo.replaceInviteToken(actor.id, id, { tokenHash: hashInviteToken(token), expiresAt: Date.now() + INVITE_TTL_MS });
      if (!invite) throw notFound('Convite não encontrado.');
      await sendInvite(actor, invite, token); // falha de envio vira 502; o dono tenta de novo
      return { invite, emailSent: true };
    },

    async cancelInvite(actor, id) {
      if (!(await repo.deleteInvite(actor.id, id))) throw notFound('Convite não encontrado.');
    },

    async updateMember(actor, id, areas) {
      const member = await repo.updateMemberAreas(actor.id, id, areas);
      if (!member) throw notFound('Colaborador não encontrado.');
      return member;
    },

    /** Remove o acesso: a conta do colaborador é apagada e as sessões dele caem na hora. */
    async removeMember(actor, id) {
      if (!(await repo.removeMember(actor.id, id))) throw notFound('Colaborador não encontrado.');
    },

    // ---------- lado do convidado (público, protegido pelo token do e-mail) ----------
    /** Dados mostrados na tela de aceite. Inexistente, expirado, já usado ou dono bloqueado: a MESMA resposta (404). */
    async lookupInvite(token) {
      const invite = await repo.findValidInvite(hashInviteToken(token));
      if (!invite || invite.ownerStatus !== 'approved') throw notFound(INVALID_INVITE);
      return { ownerName: invite.ownerName, name: invite.name, email: invite.email, areas: invite.areas, expiresAt: invite.expiresAt };
    },

    /** Cria a conta do colaborador com a senha dele e já abre a sessão. O convite é de uso único. */
    async acceptInvite(token, { name, password }) {
      const tokenHash = hashInviteToken(token);
      const invite = await repo.findValidInvite(tokenHash);
      if (!invite || invite.ownerStatus !== 'approved') throw notFound(INVALID_INVITE);
      const result = await repo.acceptInvite(tokenHash, { name: name ?? invite.name, passwordHash: await hashPassword(password) });
      if (result.status === 'invalid') throw notFound(INVALID_INVITE);
      if (result.status === 'email_taken') throw new HttpError(409, 'Este e-mail já tem uma conta no sistema. Entre com ela ou peça outro convite com outro e-mail.', 'email_taken');
      const session = await sessions.create(result.userId);
      // Entrou para a equipe: fica no registro de atividades do dono (nunca atrapalha o aceite se não conseguir registrar).
      await activity?.record({ workspaceId: result.ownerId, actor: { id: result.userId, name: name ?? invite.name }, action: 'team.member_join', targetName: name ?? invite.name, details: { email: invite.email } });
      return { session };
    },
  };
}
