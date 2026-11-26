/**
 * "Escopo" financeiro de uma pessoa: só as conexões e contas de anúncio DELA (o dinheiro nunca é compartilhado com a equipe por estas telas).
 * Usado pelo saldo e pelo gasto/histórico, para os dois sempre enxergarem exatamente o mesmo conjunto.
 */

/** IDs das Business Centers de uma conexão: a única da conexão por token ou todas as que a conexão por link cobre. */
export const bcIdsOf = (connection) => (connection.bcId ? [connection.bcId] : connection.ownerBcIds);

/** Business Center em que a conta está: a que o TikTok informou ou, sem informação, a da conexão por token (null se não houver). */
export const bcOfAccount = (account, connection) => account.ownerBcId ?? connection.bcId ?? null;

/** Conexões e contas do PRÓPRIO usuário (lidas do banco, rápido). */
export async function loadOwnScope(connections, actor) {
  const own = (await connections.listVisible(actor.id)).filter((c) => c.ownerId === actor.id);
  const known = (await connections.advertisers(actor.id)).filter((a) => a.businessCenterOwned);
  return { own, known };
}
