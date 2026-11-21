import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { HttpError } from '../src/lib/http-error.js';
import { CLEAN_WINDOW_SECONDS, createCreativeCleaner } from '../src/modules/creatives/creative-cleaner.js';
import { FPS, HEIGHT, WIDTH, compareFrames, ffmpegPath, makeImage, makeVideo, md5Of, probe, rawFrame, sha256Of, tempDir } from './real-media.js';

const silent = { info() {}, error() {}, warn() {} };
const MB = 1024 * 1024;

/** Frame `n` (25 fps): t = n / 25. As janelas de 0,1 s cobrem os quadros 0-2 (t < 0,1) e os 48-49 (t >= 1,9). */
const FIRST_WINDOW = [0, 1, 2];
const LAST_WINDOW = [48, 49];
const OUTSIDE = [3, 4, 25, 46, 47];

describe('limpeza de criativos (FFmpeg real)', () => {
  let work;
  let tmp;
  let cleaner;
  before(() => {
    work = tempDir('clean-src-');
    tmp = tempDir('clean-tmp-');
    cleaner = createCreativeCleaner({ ffmpegPath, tmpDir: tmp, concurrency: 2, log: silent });
  });
  after(() => {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const leftovers = () => fs.readdirSync(tmp);
  const clean = (file, over = {}) => cleaner.clean({ inputPath: file, kind: 'video', ext: 'mp4', originalSha256: sha256Of(file), maxOutputBytes: 50 * MB, name: path.basename(file), ...over });

  describe('vídeo', () => {
    let original;
    let result;
    before(async () => {
      original = makeVideo(work, { name: 'original.mp4' });
      result = await clean(original);
    });
    after(() => result.discard());

    it('gera um arquivo NOVO (hash diferente) e o original não é tocado', async () => {
      const hashBefore = sha256Of(original);
      assert.notEqual(result.sha256, hashBefore);
      assert.equal(result.ext, 'mp4');
      assert.equal(sha256Of(result.filePath), result.sha256, 'o hash informado é o do arquivo');
      assert.equal(md5Of(result.filePath), result.md5, 'o MD5 (assinatura do TikTok) é o do arquivo limpo');
      assert.equal(fs.statSync(result.filePath).size, result.size);
      assert.equal(sha256Of(original), hashBefore, 'o original continua intacto');
    });

    it('remove os metadados: título, comentário, marca do codificador e o texto do x264', () => {
      const originalBytes = fs.readFileSync(original).toString('latin1');
      assert.ok(originalBytes.includes('SEGREDO') && originalBytes.includes('privado'), 'o original TEM os metadados');
      const bytes = fs.readFileSync(result.filePath).toString('latin1');
      for (const marker of ['SEGREDO', 'privado', 'x264', 'Lavf', 'Lavc', 'libx264']) assert.ok(!bytes.includes(marker), `sobrou "${marker}" no arquivo limpo`);
      assert.doesNotMatch(probe(result.filePath), /title|comment|encoder/i);
    });

    it('mantém o que importa: H.264, mesma resolução e fps, áudio e duração', () => {
      const info = probe(result.filePath);
      assert.match(info, new RegExp(`Video: h264.*${WIDTH}x${HEIGHT}`));
      assert.match(info, new RegExp(`${FPS} fps`));
      assert.match(info, /Audio: aac/);
      const duration = /Duration: 00:00:(\d+\.\d+)/.exec(info);
      assert.ok(Math.abs(Number(duration[1]) - 2) < 0.15, `duração ${duration[1]}`);
    });

    it('altera os 4 cantos nos PRIMEIROS 0,1 s com cores próximas (e nada fora dos cantos)', () => {
      assert.equal(CLEAN_WINDOW_SECONDS, 0.1);
      for (const n of FIRST_WINDOW) {
        const d = compareFrames(rawFrame(original, { index: n }), rawFrame(result.filePath, { index: n }));
        assert.ok(d.cornerChangedShare > 0.8, `quadro ${n}: só ${Math.round(d.cornerChangedShare * 100)}% dos pixels dos cantos mudaram`);
        assert.ok(d.cornerMean > 2, `quadro ${n}: diferença média ${d.cornerMean.toFixed(2)}`);
        assert.ok(d.cornerMax <= 20, `quadro ${n}: cor longe da original (${d.cornerMax})`);
        assert.ok(d.restMean < 0.5 && d.farMax === 0, `quadro ${n}: o resto da imagem mudou (média ${d.restMean.toFixed(2)}, longe dos cantos ${d.farMax})`);
      }
    });

    it('altera os 4 cantos nos ÚLTIMOS 0,1 s', () => {
      for (const n of LAST_WINDOW) {
        const d = compareFrames(rawFrame(original, { index: n }), rawFrame(result.filePath, { index: n }));
        assert.ok(d.cornerChangedShare > 0.8 && d.cornerMean > 2, `quadro ${n}: cantos não alterados (${d.cornerMean.toFixed(2)})`);
        assert.ok(d.cornerMax <= 20 && d.restMean < 0.5 && d.farMax === 0, `quadro ${n}`);
      }
    });

    it('fora das duas janelas o vídeo NÃO recebe alteração de propósito (fronteiras exatas)', () => {
      for (const n of OUTSIDE) {
        const d = compareFrames(rawFrame(original, { index: n }), rawFrame(result.filePath, { index: n }));
        assert.ok(d.cornerMean < 0.5 && d.restMean < 0.5, `quadro ${n} foi alterado (cantos ${d.cornerMean.toFixed(2)})`);
      }
    });
  });

  it('cada execução gera uma versão DIFERENTE (hash e pixels dos cantos), nunca igual à anterior', async () => {
    const original = makeVideo(work, { name: 'unico.mp4' });
    const [a, b, c] = [await clean(original), await clean(original), await clean(original)];
    try {
      assert.equal(new Set([a.sha256, b.sha256, c.sha256]).size, 3, 'hashes todos diferentes');
      assert.equal(new Set([a.md5, b.md5, c.md5]).size, 3);
      const pixelsDiffer = compareFrames(rawFrame(a.filePath), rawFrame(b.filePath));
      assert.ok(pixelsDiffer.cornerMean > 0.5, `os cantos de duas versões são iguais (${pixelsDiffer.cornerMean.toFixed(2)})`);
    } finally {
      await Promise.all([a.discard(), b.discard(), c.discard()]);
    }
  });

  it('vídeo sem áudio e vídeo .mov (contêiner QuickTime) também são refeitos e saem como .mp4', async () => {
    const mute = makeVideo(work, { name: 'mudo.mp4', audio: false });
    const mov = makeVideo(work, { name: 'camera.mov', container: 'mov' });
    const [a, b] = [await clean(mute), await clean(mov, { ext: 'mov' })];
    try {
      assert.doesNotMatch(probe(a.filePath), /Audio:/);
      assert.match(probe(b.filePath), /Video: h264/);
      assert.equal(b.ext, 'mp4');
      assert.ok(compareFrames(rawFrame(mov, { index: 0 }), rawFrame(b.filePath, { index: 0 })).cornerMean > 2);
    } finally {
      await Promise.all([a.discard(), b.discard()]);
    }
  });

  it('discard() apaga o arquivo gerado e nada sobra na pasta temporária', async () => {
    const result = await clean(makeVideo(work, { name: 'descartar.mp4' }));
    assert.ok(fs.existsSync(result.filePath));
    await result.discard();
    assert.ok(!fs.existsSync(result.filePath));
    assert.deepEqual(leftovers(), []);
  });

  describe('imagem', () => {
    it('PNG: só os 4 cantos mudam (resto IDÊNTICO), com cores próximas, sem metadados e com hash novo', async () => {
      const original = makeImage(work, { name: 'foto.png' });
      const result = await clean(original, { kind: 'image', ext: 'png' });
      try {
        assert.equal(result.ext, 'png');
        assert.notEqual(result.sha256, sha256Of(original));
        const size = { pixelFormat: 'rgb24', width: 200, height: 120 };
        const d = compareFrames(rawFrame(original, size), rawFrame(result.filePath, size));
        assert.equal(d.restMax, 0, 'PNG é sem perdas: nada fora dos cantos pode mudar');
        assert.ok(d.cornerChangedShare > 0.9, `${Math.round(d.cornerChangedShare * 100)}% dos pixels dos cantos`);
        assert.ok(d.cornerMax <= 7 && d.cornerMean >= 2, `variação ${d.cornerMax} (máx.) / ${d.cornerMean.toFixed(2)} (média)`);
        assert.ok(!fs.readFileSync(result.filePath).toString('latin1').includes('SEGREDO'));
      } finally {
        await result.discard();
      }
    });

    it('JPEG: metadados removidos, hash novo, mesmas dimensões e cantos alterados', async () => {
      const original = makeImage(work, { name: 'foto.jpg' });
      assert.ok(fs.readFileSync(original).toString('latin1').includes('SEGREDO'), 'o original TEM o comentário');
      const result = await clean(original, { kind: 'image', ext: 'jpg' });
      try {
        const bytes = fs.readFileSync(result.filePath);
        assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], 'continua sendo JPEG');
        for (const marker of ['SEGREDO', 'Lavc', 'Lavf', 'Exif']) assert.ok(!bytes.toString('latin1').includes(marker), marker);
        assert.notEqual(result.sha256, sha256Of(original));
        const size = { pixelFormat: 'rgb24', width: 200, height: 120 };
        const d = compareFrames(rawFrame(original, size), rawFrame(result.filePath, size));
        assert.ok(d.cornerMean > 1.5 && d.restMean < 1.5, `cantos ${d.cornerMean.toFixed(2)} / resto ${d.restMean.toFixed(2)}`);
      } finally {
        await result.discard();
      }
    });

    it('duas versões da mesma imagem nunca são iguais', async () => {
      const original = makeImage(work, { name: 'dupla.png' });
      const [a, b] = [await clean(original, { kind: 'image', ext: 'png' }), await clean(original, { kind: 'image', ext: 'png' })];
      try {
        assert.notEqual(a.sha256, b.sha256);
      } finally {
        await Promise.all([a.discard(), b.discard()]);
      }
    });
  });

  describe('segurança: arquivo malicioso, falhas e limites', () => {
    const rejects = (promise, { status, code }) => assert.rejects(promise, (e) => e instanceof HttpError && e.status === status && e.code === code, `esperava ${status}/${code}`);

    it('lista de reprodução/concat apontando para outros arquivos, disfarçada de .mp4, é recusada (nada é lido)', async () => {
      const evil = path.join(work, 'concat.mp4');
      fs.writeFileSync(evil, "ffconcat version 1.0\nfile '/etc/hosts'\n");
      await rejects(clean(evil, { originalSha256: null }), { status: 422, code: 'creative_clean_failed' });
      const hls = path.join(work, 'hls.mp4');
      fs.writeFileSync(hls, '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\nfile:///etc/hosts\n');
      await rejects(clean(hls, { originalSha256: null }), { status: 422, code: 'creative_clean_failed' });
      assert.deepEqual(leftovers(), [], 'nada foi gerado');
    });

    it('arquivo corrompido (cabeçalho de MP4/PNG/JPEG com lixo) vira 422 com mensagem clara, sem vazar detalhes do FFmpeg', async () => {
      const bad = path.join(work, 'corrompido.mp4');
      fs.writeFileSync(bad, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(200, 7)]));
      await assert.rejects(clean(bad, { originalSha256: null, name: 'meu vídeo' }), (e) => e.status === 422 && e.code === 'creative_clean_failed' && e.message.includes('meu vídeo') && !/ffmpeg|libav|moov/i.test(e.message));
      for (const [name, kind, ext, head] of [['lixo.png', 'image', 'png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]], ['lixo.jpg', 'image', 'jpg', [0xff, 0xd8, 0xff]]]) {
        const file = path.join(work, name);
        fs.writeFileSync(file, Buffer.concat([Buffer.from(head), Buffer.alloc(100, 9)]));
        await rejects(clean(file, { kind, ext, originalSha256: null }), { status: 422, code: 'creative_clean_failed' });
      }
      assert.deepEqual(leftovers(), []);
    });

    it('nome de arquivo com espaços e símbolos de shell é tratado como texto (sem shell)', async () => {
      const file = path.join(work, 'meu vídeo; $(whoami) `id` & > x.mp4');
      fs.copyFileSync(makeVideo(work, { name: 'base.mp4' }), file);
      const result = await clean(file);
      await result.discard();
    });

    it('sem FFmpeg (caminho nulo ou inexistente): 503 claro, e o original segue intacto', async () => {
      const file = makeVideo(work, { name: 'sem-ffmpeg.mp4' });
      const hashBefore = sha256Of(file);
      for (const bin of [null, path.join(work, 'nao-existe')]) {
        const missing = createCreativeCleaner({ ffmpegPath: bin, tmpDir: tmp, log: silent });
        await rejects(missing.clean({ inputPath: file, kind: 'video', ext: 'mp4', maxOutputBytes: MB }), { status: 503, code: 'creative_cleaner_unavailable' });
      }
      assert.equal(sha256Of(file), hashBefore);
    });

    it('tempo máximo: o processo é encerrado e nada sobra', async () => {
      const slow = createCreativeCleaner({ ffmpegPath, tmpDir: tmp, timeoutMs: 1, log: silent });
      await rejects(slow.clean({ inputPath: makeVideo(work, { name: 'lento.mp4' }), kind: 'video', ext: 'mp4', maxOutputBytes: 50 * MB }), { status: 422, code: 'creative_clean_failed' });
      assert.deepEqual(leftovers(), []);
      assert.deepEqual(slow.stats(), { active: 0, waiting: 0 }, 'a vaga foi liberada');
    });

    it('tamanho máximo da saída: arquivo maior que o limite é recusado e apagado', async () => {
      await rejects(clean(makeVideo(work, { name: 'grande.mp4' }), { maxOutputBytes: 200 }), { status: 422, code: 'creative_clean_failed' });
      assert.deepEqual(leftovers(), []);
    });

    it('respeita o limite de limpezas simultâneas (a CPU do servidor é compartilhada) e libera a fila ao terminar', async () => {
      const file = makeVideo(work, { name: 'fila.mp4' });
      const one = createCreativeCleaner({ ffmpegPath, tmpDir: tmp, concurrency: 1, log: silent });
      let peak = 0;
      let queued = 0;
      const watcher = setInterval(() => {
        const { active, waiting } = one.stats();
        peak = Math.max(peak, active);
        queued = Math.max(queued, waiting);
      }, 5);
      try {
        const results = await Promise.all([1, 2, 3, 4].map(() => one.clean({ inputPath: file, kind: 'video', ext: 'mp4', maxOutputBytes: 50 * MB })));
        await Promise.all(results.map((r) => r.discard()));
        assert.equal(new Set(results.map((r) => r.sha256)).size, 4);
      } finally {
        clearInterval(watcher);
      }
      assert.equal(peak, 1, 'nunca mais de uma limpeza por vez');
      assert.ok(queued >= 2, 'as outras esperaram na fila');
      assert.deepEqual(one.stats(), { active: 0, waiting: 0 });
    });

    it('uma falha não trava a fila: a próxima limpeza roda normalmente', async () => {
      const one = createCreativeCleaner({ ffmpegPath, tmpDir: tmp, concurrency: 1, log: silent });
      const bad = path.join(work, 'falha-fila.png');
      fs.writeFileSync(bad, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)]));
      const results = await Promise.allSettled([
        one.clean({ inputPath: bad, kind: 'image', ext: 'png', maxOutputBytes: MB }),
        one.clean({ inputPath: makeImage(work, { name: 'boa.png' }), kind: 'image', ext: 'png', maxOutputBytes: MB }),
      ]);
      assert.equal(results[0].status, 'rejected');
      assert.equal(results[1].status, 'fulfilled');
      await results[1].value.discard();
    });
  });
});

describe('autoverificação do FFmpeg na inicialização', () => {
  it('informa a versão quando o FFmpeg executa e erro claro (sem lançar) quando não existe ou não roda', async () => {
    const dir = tempDir('selfcheck-');
    try {
      const good = await createCreativeCleaner({ ffmpegPath, tmpDir: dir, log: silent }).selfCheck();
      assert.equal(good.ok, true);
      assert.match(good.version, /^\d/);
      const none = await createCreativeCleaner({ ffmpegPath: null, tmpDir: dir, log: silent }).selfCheck();
      assert.equal(none.ok, false);
      assert.match(none.error, /FFmpeg/);
      const missing = await createCreativeCleaner({ ffmpegPath: path.join(dir, 'nao-existe'), tmpDir: dir, log: silent }).selfCheck();
      assert.deepEqual([missing.ok, /não executou/.test(missing.error)], [false, true]);
      const notBinary = path.join(dir, 'falso');
      fs.writeFileSync(notBinary, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
      assert.equal((await createCreativeCleaner({ ffmpegPath: notBinary, tmpDir: dir, log: silent }).selfCheck()).ok, false, 'binário que sai com erro');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
