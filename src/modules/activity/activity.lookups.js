/**
 * Buscas só de LEITURA que o registro de atividades usa para pôr nomes nas ações (antes de excluir, depois de publicar…). Cada uma é escopada pelo
 * dono do espaço: nunca devolve nome de algo que é de outra pessoa. Se não achar, devolve nulo/vazio (a ação é registrada sem o nome).
 */
export function createActivityLookups({ oneClick, campaigns, creatives, businessCenters, proxies, files, team }) {
  return {
    campaign: (ownerId, id) => campaigns.get(ownerId, id),
    template: (ownerId, id) => oneClick.get(ownerId, id),
    creatives: async (ownerId, ids) => {
      if (!ids.length) return [];
      const byId = new Map((await creatives.getManyInternal(ownerId, ids)).map((row) => [row.id, { id: row.id, name: row.name }]));
      return ids.map((id) => byId.get(id)).filter(Boolean); // na mesma ordem em que a pessoa escolheu (o banco não garante ordem)
    },
    folder: (ownerId, id) => (Number.isInteger(id) ? creatives.getFolder(ownerId, id) : null),
    businessCenter: async (ownerId, id) => {
      const record = await businessCenters.get(id);
      return record && record.ownerId === ownerId ? { name: record.name } : null;
    },
    advertiser: (advertiserId, userId) => businessCenters.findAdvertiser(advertiserId, userId),
    proxy: (ownerId, id) => proxies.get(ownerId, id),
    file: async (ownerId, id) => (await files.list(ownerId)).find((f) => f.id === id) ?? null,
    invite: (ownerId, id) => team.getInvite(ownerId, id),
    member: async (ownerId, id) => (await team.listMembers(ownerId)).find((m) => m.id === id) ?? null,
  };
}
