/**
 * Lê o corpo inteiro de uma requisição (ou qualquer fluxo) na memória, parando e recusando ao passar do limite.
 * Só para corpos PEQUENOS (anexos, fotos de perfil/identidade): vídeos e criativos grandes são gravados em disco, em outro lugar.
 * @param {AsyncIterable<Buffer>} stream
 * @param {number} maxBytes
 * @param {() => Error} tooLarge cria o erro devolvido quando o limite é passado
 * @returns {Promise<Buffer>}
 */
export async function readBody(stream, maxBytes, tooLarge) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
