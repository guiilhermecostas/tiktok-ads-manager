import { ALL_AREAS } from '../../../shared/permissions.js';
import { toPublicUser } from '../users/users.repository.js';

/**
 * O que o navegador recebe sobre a sessão: a PESSOA logada e o espaço onde ela trabalha.
 *  - dono de conta: acesso a todas as áreas;
 *  - colaborador: só as áreas liberadas, e o nome do dono. Se o dono for bloqueado, o colaborador também aparece como bloqueado.
 */
export function presentSession(user, member) {
  const ownerInactive = member && member.ownerStatus !== 'approved' && user.status === 'approved';
  const person = toPublicUser(ownerInactive ? { ...user, status: 'blocked' } : user);
  const workspace = member ? { isOwner: false, ownerName: member.ownerName, areas: member.areas } : { isOwner: true, ownerName: null, areas: [...ALL_AREAS] };
  return { user: person, workspace };
}
