import { ALL_AREAS, canAccess } from '../../shared/permissions.js';
import { forbidden } from '../lib/http-error.js';

/**
 * Espaço de trabalho da requisição. Todos os dados do sistema (Business Centers, criativos, campanhas, proxies) pertencem a
 * UM dono; um colaborador trabalha dentro do espaço do dono, só nas áreas liberadas.
 *  - req.user      : a PESSOA logada (quem aparece no menu e nos dados da conta).
 *  - req.actor     : de quem são os dados que ela enxerga (o próprio usuário, ou o dono do espaço). É ele que os módulos recebem.
 *  - req.workspace : { isOwner, ownerId, ownerName, areas }.
 * O colaborador NUNCA vira admin: mesmo no espaço de um admin, o ator dele é um usuário comum.
 */
export function resolveWorkspace(req, _res, next) {
  const member = req.member;
  if (!member) {
    req.workspace = { isOwner: true, ownerId: req.user.id, ownerName: req.user.name, areas: ALL_AREAS };
    req.actor = req.user;
  } else {
    req.workspace = { isOwner: false, ownerId: member.ownerId, ownerName: member.ownerName, areas: member.areas };
    req.actor = { id: member.ownerId, role: 'user', status: 'approved' };
  }
  next();
}

/** Exige ao menos UMA das áreas (o dono sempre passa). */
export const requireArea = (...needed) => (req, _res, next) =>
  canAccess(req.workspace.areas, ...needed) ? next() : next(forbidden('Você não tem permissão para acessar esta área.', 'area_forbidden'));

/** Só o dono do espaço (colaborador nunca gerencia colaboradores). */
export function requireOwner(req, _res, next) {
  return req.workspace.isOwner ? next() : next(forbidden('Somente o titular da conta pode gerenciar colaboradores.', 'owner_only'));
}

/** Áreas diferentes para leitura (GET/HEAD) e para alteração: ex.: ver criativos serve a quem publica; enviar/excluir, só a quem gerencia. */
export const requireAreaByMethod = ({ read, write }) => (req, res, next) =>
  requireArea(...(req.method === 'GET' || req.method === 'HEAD' ? read : write))(req, res, next);
