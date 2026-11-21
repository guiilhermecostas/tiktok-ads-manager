/** Parser mínimo de cabeçalho Cookie (evita dependência extra). */
export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const key = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      /* ignora cookie malformado */
    }
  }
  return out;
}
