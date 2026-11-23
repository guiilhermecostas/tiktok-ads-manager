/**
 * Áreas do sistema que o dono de uma conta pode liberar para um colaborador. Fonte ÚNICA usada pelo servidor (permissões,
 * validação) e pelas telas (menu, convite). "Acesso total" = todas as áreas. Gerenciar colaboradores e a administração do
 * sistema NUNCA são liberados: ficam só com o dono (e o admin).
 *
 * Para criar uma área nova: acrescente-a aqui, proteja as rotas com `requireArea` e crie uma migração que amplie a restrição
 * CHECK das colunas `areas` (workspace_members e workspace_invites).
 */
export const AREAS = Object.freeze([
  { id: 'creatives', label: 'Criativos', description: 'Enviar, renomear e excluir vídeos e imagens.' },
  { id: 'campaigns', label: 'Campanhas', description: 'Criar, editar e publicar campanhas.' },
  { id: 'reports', label: 'Relatórios', description: 'Ver gasto, cliques e conversões.' },
  { id: 'accounts', label: 'Contas TikTok', description: 'Business Centers, contas, proxy e arquivos.' },
]);

export const ALL_AREAS = Object.freeze(AREAS.map((a) => a.id));

export const isArea = (value) => typeof value === 'string' && ALL_AREAS.includes(value);

/** Quantos colaboradores (ativos + convites pendentes) cada conta pode ter. */
export const MAX_TEAM_SIZE = 30;

/**
 * Lista de áreas válida (sem repetição, na ordem do sistema) ou null se vier algo inválido/vazio.
 * Não aceita nome de área desconhecido: nada é ignorado em silêncio.
 */
export function normalizeAreas(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > ALL_AREAS.length) return null;
  if (!value.every(isArea)) return null;
  const set = new Set(value);
  return ALL_AREAS.filter((id) => set.has(id));
}

export const hasFullAccess = (areas) => ALL_AREAS.every((id) => areas.includes(id));

/**
 * Regra de acesso: o dono tem tudo; o colaborador precisa de ao menos UMA das áreas exigidas.
 * (Ex.: ver contas de anúncio serve a quem publica campanhas, a quem vê relatórios e a quem gerencia as contas.)
 */
export const canAccess = (areas, ...needed) => needed.length === 0 || needed.some((id) => areas.includes(id));
