/**
 * Lê só o CABEÇALHO de uma imagem JPEG ou PNG para saber o tipo e o tamanho em pixels (sem decodificar a imagem).
 * Usado onde a regra depende da forma da imagem (ex.: foto de identidade precisa ser quadrada). Qualquer coisa fora do
 * esperado devolve `null`: o chamador trata como "não é uma imagem aceita".
 * @param {Buffer} buffer
 * @returns {{ type: 'jpeg'|'png', width: number, height: number } | null}
 */
export function imageInfo(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a && buffer.toString('latin1', 12, 16) === 'IHDR') {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return width > 0 && height > 0 ? { type: 'png', width, height } : null;
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return jpegInfo(buffer);
  return null;
}

/** Percorre os segmentos do JPEG até o primeiro "Start Of Frame" (que guarda altura e largura). */
function jpegInfo(buffer) {
  let i = 2;
  while (i + 4 <= buffer.length) {
    if (buffer[i] !== 0xff) return null; // fora do formato
    const marker = buffer[i + 1];
    if (marker === 0xff) { // bytes de enchimento
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // marcadores sem tamanho
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // fim da imagem / dados comprimidos sem ter achado o quadro
    const length = buffer.readUInt16BE(i + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (i + 9 > buffer.length) return null;
      const height = buffer.readUInt16BE(i + 5);
      const width = buffer.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { type: 'jpeg', width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}
