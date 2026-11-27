/** Regras da Campanha one-click usadas pelo servidor e pela tela (isomórfico: sem Node nem DOM). */
export const TEMPLATE_NAME_MIN = 2;
export const TEMPLATE_NAME_MAX = 60;
export const MAX_TEMPLATES = 50; // por dono: a lista é uma grade de cartões, não um arquivo

/**
 * Nome sugerido para a cópia de uma configuração: "X (cópia)", "X (cópia 2)"… Nunca repete um nome que já existe (sem diferenciar maiúsculas, como o
 * servidor) e nunca passa do limite de 60 caracteres (o nome original é encurtado para caber o sufixo).
 */
export function copyName(name, taken) {
  const used = new Set(taken.map((n) => String(n).toLowerCase()));
  for (let n = 1; n < 1000; n += 1) {
    const suffix = n === 1 ? ' (cópia)' : ` (cópia ${n})`;
    const candidate = `${String(name).slice(0, TEMPLATE_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${String(name).slice(0, TEMPLATE_NAME_MAX - 9).trimEnd()} (cópia)`;
}
