/** Estado global mínimo da sessão atual. */
export const state = {
  user: null,
  csrfToken: null,
  // Quando definido, é chamado antes de sair da tela por um link (retorna false para cancelar).
  leaveGuard: null,
};

export function setSession(payload) {
  state.user = payload?.user ?? null;
  state.csrfToken = payload?.csrfToken ?? null;
}
