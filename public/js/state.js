/** Estado global mínimo da sessão atual. */
export const state = {
  user: null,
  csrfToken: null,
};

export function setSession(payload) {
  state.user = payload?.user ?? null;
  state.csrfToken = payload?.csrfToken ?? null;
}
