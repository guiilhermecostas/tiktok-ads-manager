import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Limpador FALSO para os testes que usam arquivos de mídia de mentira (bytes que só passam na checagem de tipo):
 * entrega uma cópia com 16 bytes aleatórios no fim, ou seja, um arquivo ÚNICO a cada chamada, no mesmo contrato do real
 * (`clean()` -> { filePath, ext, size, md5, sha256, discard }). A limpeza de verdade é testada com mídia real
 * em creative-cleaner.test.js e creative-cleaning-publish.test.js.
 */
export const STUB_EXTRA_BYTES = 16;

export function createStubCleaner() {
  const calls = [];
  return {
    available: true,
    calls,
    async clean({ inputPath, kind, ext, name = '' }) {
      const outputExt = kind === 'video' ? 'mp4' : ext;
      const filePath = path.join(os.tmpdir(), `stub-clean-${randomBytes(8).toString('hex')}.${outputExt}`);
      const data = Buffer.concat([await fsp.readFile(inputPath), randomBytes(STUB_EXTRA_BYTES)]);
      await fsp.writeFile(filePath, data);
      calls.push({ inputPath, kind, ext, name });
      return {
        filePath,
        ext: outputExt,
        size: data.length,
        md5: createHash('md5').update(data).digest('hex'),
        sha256: createHash('sha256').update(data).digest('hex'),
        discard: () => fsp.rm(filePath, { force: true }),
      };
    },
    stats: () => ({ active: 0, waiting: 0 }),
  };
}
