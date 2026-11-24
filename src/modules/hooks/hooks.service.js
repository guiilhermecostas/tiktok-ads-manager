import fs from 'node:fs/promises';
import { HOOK_DURATIONS_MS, MAX_HOOKS_PER_REQUEST, hookStyleLabel, isHookStyle } from '../../../shared/hook-styles.js';
import { HttpError, badRequest, notFound } from '../../lib/http-error.js';
import { sniffCreativeType } from '../creatives/creative-types.js';
import { buildHookPrompt, cleanIdea } from './hook-prompts.js';

const POLL_EVERY_MS = 4000;
const MAX_WAIT_MS = 15 * 60 * 1000; // a Kling costuma levar 1 a 3 minutos; passou disso, desistimos
const MAX_SUBMIT_ATTEMPTS = 8; // Kling ocupada/inacessível: tenta de novo, mas não para sempre
const MAX_ACTIVE_PER_USER = 6;
const MAX_APPLY_RESUMES = 2; // retomadas da junção depois de reinícios; passou disso, falha (algo derruba o servidor sempre no mesmo ponto)
const KEEP_DAYS = 14; // hooks não usados somem depois disso
const PURGE_EVERY_MS = 60 * 60 * 1000;
const HOOK_MAX_BYTES = 30 * 1024 * 1024;
const GENERATED_SECONDS = 3; // mínimo aceito pela Kling (o servidor corta para 2 a 3 s)
const FAILED_BY_KLING = 'A Kling não conseguiu gerar este hook. Tente outro estilo ou outra ideia.';

const isTransient = (err) => err instanceof HttpError && (err.code === 'kling_busy' || err.code === 'kling_unreachable');
const asMessage = (err, fallback) => (err instanceof HttpError ? err.message : fallback);

/**
 * Hook com IA: gera (Kling) um começo de 2 a 3 segundos, fora do padrão, e o aplica ao início de um vídeo da biblioteca.
 *  - A geração é uma tarefa em segundo plano com estados (na fila → gerando → ajustando → pronto) guardados no banco: sobrevive a reinício.
 *  - Custo protegido: limite por usuário e geral a cada 24 h, poucos pedidos ativos e poucas tarefas ao mesmo tempo.
 *  - O resultado é sempre um criativo NOVO, marcado como "gerado por IA"; o vídeo original não é alterado.
 *  - Nada aqui mexe no vídeo original da pessoa: o hook é um trecho novo, escolhido por ela, colocado antes do vídeo.
 */
export function createHooksService({ repo, kling, video, storage, creatives, config, log = console, now = () => new Date(), intervalMs = POLL_EVERY_MS }) {
  const settings = config.kling;
  let ticking = false;
  let timer = null;
  let purgeTimer = null;
  const pending = new Set(); // aplicações em andamento (os testes esperam por elas)

  const failJob = (row, code, message) => repo.markFailed(row.id, { code, message });

  /** Baixa, corta/padroniza e guarda o vídeo que a Kling terminou de gerar. */
  async function finalize(row, task) {
    const downloaded = storage.tempPath();
    const processed = video.tempFile('mp4');
    try {
      await repo.markProcessing(row.id);
      await kling.download(task.videoUrl, downloaded);
      const head = Buffer.alloc(16);
      const handle = await fs.open(downloaded, 'r');
      try {
        await handle.read(head, 0, 16, 0);
      } finally {
        await handle.close();
      }
      const kind = sniffCreativeType(head);
      if (kind?.kind !== 'video') throw new HttpError(502, 'O arquivo devolvido pela Kling não é um vídeo.', 'kling_bad_response');
      const { size } = await video.prepareHook({ inputPath: downloaded, outputPath: processed, durationMs: row.duration_ms, maxBytes: HOOK_MAX_BYTES });
      const storageKey = await storage.commit(processed, row.user_id, 'mp4');
      await repo.markReady(row.id, { storageKey, sizeBytes: size });
    } catch (err) {
      log.error('[hook] falha ao finalizar:', err.code ?? 'erro');
      await failJob(row, err.code ?? 'hook_failed', asMessage(err, 'Não foi possível preparar o hook. Gere de novo.'));
    } finally {
      await Promise.all([fs.rm(downloaded, { force: true }), fs.rm(processed, { force: true })]).catch(() => {});
    }
  }

  async function pollGenerating() {
    for (const row of await repo.generating()) {
      if (now().getTime() - new Date(row.submitted_at).getTime() > MAX_WAIT_MS) {
        await failJob(row, 'timeout', 'A Kling demorou demais para responder. Gere o hook de novo.');
        continue;
      }
      let task;
      try {
        task = await kling.getTask(row.kling_task_id);
      } catch (err) {
        // Só a chave recusada encerra a tarefa; qualquer outro erro de consulta é tratado como momentâneo (a tarefa já foi paga):
        // tenta no próximo ciclo, e o prazo máximo acima encerra o que nunca responder.
        if (err.code === 'kling_auth') await failJob(row, err.code, asMessage(err, FAILED_BY_KLING));
        continue;
      }
      if (task.status === 'failed') await failJob(row, 'kling_failed', FAILED_BY_KLING);
      else if (task.status === 'succeeded') {
        if (!task.videoUrl) await failJob(row, 'kling_bad_response', 'A Kling terminou, mas não devolveu o vídeo. Gere de novo.');
        else await finalize(row, task);
      }
    }
  }

  async function submitQueued() {
    const slots = settings.concurrency - (await repo.countInFlight());
    if (slots <= 0) return;
    const rows = await repo.queued(slots);
    for (const [index, row] of rows.entries()) {
      const prompt = buildHookPrompt(row.style, row.idea ?? '');
      if (!prompt) {
        await failJob(row, 'invalid_style', 'Estilo de hook inválido.');
        continue;
      }
      try {
        const { taskId } = await kling.createHook({ prompt, seconds: GENERATED_SECONDS, externalId: `hook-${row.id}` });
        await repo.markGenerating(row.id, taskId);
      } catch (err) {
        if (isTransient(err) && row.attempts + 1 < MAX_SUBMIT_ATTEMPTS) {
          await repo.retryLater(row.id);
          break; // Kling ocupada: não insiste com os demais agora
        }
        const message = asMessage(err, FAILED_BY_KLING);
        await failJob(row, err.code ?? 'kling_error', isTransient(err) ? 'A Kling está ocupada. Tente de novo em alguns minutos.' : message);
        if (err instanceof HttpError && (err.code === 'kling_auth' || err.code === 'kling_credits')) {
          for (const rest of rows.slice(index + 1)) await failJob(rest, err.code, message); // mesmo motivo para todos: nem tenta
          break;
        }
      }
    }
  }

  async function purgeOld() {
    try {
      for (const key of await repo.purgeOlderThan(KEEP_DAYS)) await storage.remove(key).catch(() => {});
    } catch (err) {
      log.error('[hook] falha na limpeza:', err.code ?? err.message);
    }
  }

  /** O vídeo da biblioteca escolhido (ou null = só guardar o hook). Erros 404/400 se não for do usuário, não for vídeo ou for só referência do TikTok. */
  async function resolveMain(actor, creativeId) {
    if (creativeId === null) return null;
    const creative = await creatives.get(actor, creativeId); // 404 se não for do usuário
    if (creative.kind !== 'video') throw badRequest('Escolha um vídeo da biblioteca (hook só se junta a vídeo).');
    const file = await creatives.openFile(actor, creativeId); // 404 se for só referência do TikTok (sem arquivo)
    return { path: file.filePath, name: creative.name, folderId: creative.folderId ?? null };
  }

  /** Faz a junção em segundo plano (FFmpeg): cria o criativo novo e registra o resultado. Nunca lança: o erro vira mensagem no pedido. */
  function launchApply(row, { creativeId, resultName }) {
    const actor = { id: row.user_id };
    const job = (async () => {
      let output = null;
      try {
        const main = await resolveMain(actor, creativeId); // na retomada, o vídeo pode ter sido apagado nesse meio tempo
        let created;
        if (main) {
          output = video.tempFile('mp4');
          await video.combine({ hookPath: storage.pathFor(row.storage_key), mainPath: main.path, outputPath: output, maxBytes: creatives.limits.maxVideoBytes });
          created = await creatives.adoptGenerated(actor, { name: resultName, sourcePath: output, filename: `hook-${row.id}.mp4`, folderId: main.folderId }); // fica na mesma pasta do vídeo original
        } else {
          created = await creatives.adoptGenerated(actor, { name: resultName, sourcePath: storage.pathFor(row.storage_key), filename: `hook-${row.id}.mp4` });
        }
        await repo.finishApply(row.id, { creativeId: created.id });
      } catch (err) {
        log.error('[hook] falha ao aplicar:', err.code ?? 'erro');
        await repo.finishApply(row.id, { error: asMessage(err, 'Não foi possível aplicar o hook. Tente de novo.') }).catch(() => {});
      } finally {
        if (output) await fs.rm(output, { force: true }).catch(() => {});
      }
    })();
    pending.add(job);
    job.finally(() => pending.delete(job));
  }

  const service = {
    enabled: settings.enabled,

    /** Estado do recurso para a tela: ligado? quantos hooks já foram pedidos hoje? */
    async info(actor) {
      const usage = await repo.usage(actor.id);
      return { enabled: settings.enabled, dailyLimit: settings.dailyLimit, usedLast24h: usage.last24h, active: usage.active, maxPerRequest: MAX_HOOKS_PER_REQUEST, durationsMs: HOOK_DURATIONS_MS };
    },

    list: (actor) => repo.list(actor.id),

    /** Cria de 1 a 3 pedidos (um hook cada). Respeita os limites de custo. */
    async create(actor, { style, idea = '', durationMs, count = 1 }) {
      if (!settings.enabled) throw new HttpError(503, 'O Hook com IA ainda não foi ligado neste servidor (falta a chave da Kling). Avise o administrador.', 'hooks_not_configured');
      if (!isHookStyle(style)) throw badRequest('Estilo de hook inválido.');
      if (!HOOK_DURATIONS_MS.includes(durationMs)) throw badRequest('Duração inválida (2, 2,5 ou 3 segundos).');
      if (!Number.isInteger(count) || count < 1 || count > MAX_HOOKS_PER_REQUEST) throw badRequest(`Peça de 1 a ${MAX_HOOKS_PER_REQUEST} opções por vez.`);
      const usage = await repo.usage(actor.id);
      if (usage.active + count > MAX_ACTIVE_PER_USER) throw new HttpError(429, 'Você já tem vários hooks sendo gerados. Aguarde terminarem antes de pedir mais.', 'hooks_too_many_active');
      if (usage.last24h + count > settings.dailyLimit) throw new HttpError(429, `Limite diário de hooks atingido (${settings.dailyLimit} a cada 24 horas). Tente mais tarde.`, 'hooks_daily_limit');
      if ((await repo.globalLast24h()) + count > settings.globalDailyLimit) throw new HttpError(429, 'O limite diário de hooks do sistema foi atingido. Tente mais tarde.', 'hooks_global_limit');
      const ideaText = cleanIdea(idea);
      const ids = [];
      for (let i = 0; i < count; i += 1) ids.push(await repo.create(actor.id, { style, idea: ideaText, durationMs }));
      setImmediate(() => service.tick().catch(() => {})); // começa já, sem esperar o próximo ciclo
      return Promise.all(ids.map((id) => repo.get(actor.id, id)));
    },

    /** Um ciclo do processador: acompanha o que está gerando e envia o que está na fila. Nunca roda duas vezes ao mesmo tempo. */
    async tick() {
      if (ticking || !settings.enabled) return;
      ticking = true;
      try {
        await pollGenerating();
        await submitQueued();
      } catch (err) {
        log.error('[hook] falha no ciclo:', err.code ?? err.message);
      } finally {
        ticking = false;
      }
    },

    /** Arquivo do hook pronto (pré-visualização) para o dono. */
    async openFile(actor, id) {
      const row = await repo.getInternal(actor.id, id);
      if (!row?.storage_key) throw notFound('Hook não encontrado.');
      return { filePath: storage.pathFor(row.storage_key), id: row.id };
    },

    /**
     * Aplica o hook: com `creativeId`, cria um vídeo NOVO (hook + esse vídeo) na biblioteca; sem ele, guarda só o hook como criativo.
     * O trabalho roda em segundo plano NO SERVIDOR (fechar a janela, o site ou o navegador não o interrompe) e o pedido fica guardado no
     * banco: se o servidor reiniciar no meio, a junção é retomada sozinha. A tela acompanha pelo campo `applying` e, ao terminar, `creativeId`.
     */
    async apply(actor, id, { creativeId = null, name = null }) {
      const row = await repo.getInternal(actor.id, id);
      if (!row) throw notFound('Hook não encontrado.');
      if (row.status !== 'ready') throw new HttpError(409, 'Este hook ainda não está pronto.', 'hook_not_ready');
      const main = await resolveMain(actor, creativeId); // 404/400 se o vídeo não for do usuário, não for vídeo ou não tiver arquivo
      const resultName = (name ?? (main ? `${main.name} + Hook IA` : `Hook IA – ${hookStyleLabel(row.style)}`)).slice(0, 100);
      if (!(await repo.beginApply(actor.id, id, { creativeId, name: resultName }))) throw new HttpError(409, 'Este hook já está sendo aplicado.', 'hook_apply_running');
      launchApply(row, { creativeId, resultName });
      return repo.get(actor.id, id);
    },

    /**
     * Ao subir o servidor: retoma as junções que estavam em andamento (o servidor reiniciou no meio). Cada pedido guardado volta a rodar; um
     * pedido antigo sem os dados guardados, ou que já foi retomado demais, falha com mensagem clara. Roda mesmo sem a chave da Kling.
     */
    async resumeApplies() {
      for (const row of await repo.runningApplies()) {
        const attempts = await repo.bumpApplyAttempt(row.id);
        if (!row.apply_name || attempts > MAX_APPLY_RESUMES) {
          await repo.finishApply(row.id, { error: 'A junção foi interrompida. Tente de novo.' });
          continue;
        }
        if (row.apply_with_video && row.apply_creative_id === null) { // o vídeo escolhido foi apagado enquanto o servidor estava fora
          await repo.finishApply(row.id, { error: 'O vídeo escolhido foi apagado. Escolha outro vídeo e aplique de novo.' });
          continue;
        }
        launchApply(row, { creativeId: row.apply_creative_id ?? null, resultName: row.apply_name });
      }
    },

    async remove(actor, id) {
      const removed = await repo.remove(actor.id, id);
      if (!removed) throw notFound('Hook não encontrado.');
      if (removed.storage_key) await storage.remove(removed.storage_key).catch((err) => log.error('[hook] não foi possível apagar o arquivo:', err.code ?? err.message));
    },

    /** Para os testes: espera as aplicações em andamento terminarem. */
    async idle() {
      await Promise.allSettled([...pending]);
    },

    /** Liga o processador (a cada poucos segundos) e a limpeza periódica. Só o servidor chama; sem a chave da Kling não faz nada. */
    async start() {
      if (timer) return;
      await service.resumeApplies(); // a junção ao vídeo não depende da Kling: retoma mesmo com o recurso desligado
      if (!settings.enabled) return;
      await repo.recoverStuck();
      timer = setInterval(() => service.tick().catch(() => {}), intervalMs);
      timer.unref();
      purgeTimer = setInterval(purgeOld, PURGE_EVERY_MS);
      purgeTimer.unref();
      purgeOld();
    },
    stop() {
      clearInterval(timer);
      clearInterval(purgeTimer);
      timer = null;
      purgeTimer = null;
    },
  };
  return service;
}
