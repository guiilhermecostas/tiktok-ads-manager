import { canAccess } from '/shared/permissions.js';

/** Estado global mínimo da sessão atual. `workspace`: { isOwner, ownerName, areas } (colaborador trabalha no espaço de outra conta). */
export const state = {
  user: null,
  workspace: null,
  csrfToken: null,
};

export function setSession(payload) {
  state.user = payload?.user ?? null;
  state.workspace = payload?.workspace ?? null;
  state.csrfToken = payload?.csrfToken ?? null;
}

/** A pessoa logada pode usar ao menos UMA destas áreas? (o dono da conta tem todas; é só conveniência de tela: o servidor é quem manda) */
export const can = (...areas) => Boolean(state.workspace) && canAccess(state.workspace.areas, ...areas);

/** Dono do espaço (não é colaborador): pode gerenciar a equipe. */
export const isWorkspaceOwner = () => state.workspace?.isOwner === true;
