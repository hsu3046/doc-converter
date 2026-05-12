import express from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runOcrPipeline } from '../services/ocr-pipeline.js';
import { runAudioPipeline } from '../services/audio-pipeline.js';
import { processChatCsv, processInstagramHtml } from '../services/chat-processor.js';
import {
  listTemplates,
  saveUserTemplate,
} from '../services/template-loader.js';
import { runMeetingNotesPipeline } from '../services/meeting-notes-pipeline.js';
import {
  DETAIL_LEVELS,
  DEFAULT_NOTES_PROVIDER,
  NOTES_PROVIDERS,
  type DetailLevel,
  type NotesProvider,
} from '../types/index.js';
import { logEvent, getRecentEvents, getLogDir } from '../utils/error-logger.js';

function normalizeDetailLevel(input: unknown): DetailLevel {
  if (typeof input !== 'string') return 'standard';
  const lower = input.toLowerCase();
  return (DETAIL_LEVELS as string[]).includes(lower) ? (lower as DetailLevel) : 'standard';
}

function normalizeProvider(input: unknown): NotesProvider {
  if (typeof input !== 'string') return DEFAULT_NOTES_PROVIDER;
  const lower = input.toLowerCase();
  return (NOTES_PROVIDERS as string[]).includes(lower)
    ? (lower as NotesProvider)
    : DEFAULT_NOTES_PROVIDER;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 1GB — 보통 4~5시간 회의 m4a/mp3 분량. 청크 분할이 자동으로 처리하므로 파일 크기 자체는 병목 X.
// Gemini File API 단일 청크 제한 2GB 가 진짜 상한 (청크당 10분이라 실질 영향 없음).
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// ─── 잡 레지스트리 ────────────────────────────────────────
interface Job { emitter: EventEmitter; createdAt: number; }
const jobs = new Map<string, Job>();

/** 30분 후 미처리 잡 자동 정리 */
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 30 * 60 * 1000) jobs.delete(id);
  }
}, 5 * 60 * 1000);

/** jobId 생성 + emitter 등록 */
function createJob(): { jobId: string; emitter: EventEmitter } {
  const jobId = randomUUID();
  const emitter = new EventEmitter();
  jobs.set(jobId, { emitter, createdAt: Date.now() });
  return { jobId, emitter };
}

/** SSE 이벤트 전송 헬퍼 */
function sendEvent(
  res: express.Response,
  event: string,
  data: unknown
): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createServer() {
  const app = express();
  // transcript 본문이 클 수 있어 5MB까지 허용 (2h 녹취록 ~100KB 안쪽이지만 여유)
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  /**
   * multer는 파일명을 Latin-1로 저장함.
   * UTF-8 한글/특수문자 파일명이 깨지는 것을 방지하기 위해 재디코딩.
   */
  function decodeFilename(raw: string): string {
    try {
      return Buffer.from(raw, 'latin1').toString('utf8');
    } catch {
      return raw;
    }
  }

  // ─── SSE 진행상황 스트림 ──────────────────────────────
  app.get('/api/progress/:jobId', (req, res) => {
    const job = jobs.get(req.params['jobId'] ?? '');
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const { emitter } = job;

    const onProgress = (data: unknown) => sendEvent(res, 'progress', data);
    const onResult   = (data: unknown) => { sendEvent(res, 'result', data);   res.end(); jobs.delete(req.params['jobId'] ?? ''); };
    const onError    = (data: unknown) => { sendEvent(res, 'error',  data);   res.end(); jobs.delete(req.params['jobId'] ?? ''); };

    emitter.on('progress', onProgress);
    emitter.once('result',  onResult);
    emitter.once('error',   onError);

    req.on('close', () => {
      emitter.off('progress', onProgress);
      emitter.off('result',   onResult);
      emitter.off('error',    onError);
    });
  });

  // ─── OCR ──────────────────────────────────────────────
  app.post('/api/ocr', upload.single('file'), async (req, res): Promise<void> => {
    const file = req.file;
    if (!file) { res.status(400).json({ error: '파일이 없습니다.' }); return; }

    const quick = req.body['quick'] === 'true';
    const { jobId, emitter } = createJob();
    res.json({ jobId });

    // 비동기 처리 시작
    const originalName = decodeFilename(file.originalname);
    const ext = path.extname(originalName);
    const renamedPath = file.path + ext;

    try {
      await fs.rename(file.path, renamedPath);

      const { markdown, cost } = await runOcrPipeline(
        renamedPath,
        quick,
        originalName,
        (step, detail) => emitter.emit('progress', { step, detail })
      );
      await fs.unlink(renamedPath).catch(() => {});

      emitter.emit('result', {
        filename: path.basename(originalName, ext) + '.md',
        content: markdown,
        cost,
      });
    } catch (err) {
      await fs.unlink(renamedPath).catch(() => {});
      await fs.unlink(file.path).catch(() => {});
      emitter.emit('error', { message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── 음성 녹취 ────────────────────────────────────────
  app.post('/api/transcribe', upload.single('file'), async (req, res): Promise<void> => {
    const file = req.file;
    if (!file) { res.status(400).json({ error: '파일이 없습니다.' }); return; }

    const notesTemplate = (req.body['notes'] as string | undefined) || undefined;
    const notesDetail = normalizeDetailLevel(req.body['notesDetail']);
    const notesProvider = normalizeProvider(req.body['notesProvider']);
    // checkbox / true/false / on 모두 truthy 로 처리
    const trimSilenceRaw = req.body['trimSilence'];
    const trimSilence =
      trimSilenceRaw === true ||
      trimSilenceRaw === 'true' ||
      trimSilenceRaw === 'on' ||
      trimSilenceRaw === '1';
    const { jobId, emitter } = createJob();
    res.json({ jobId });

    const ext = path.extname(file.originalname);
    const originalName = decodeFilename(file.originalname);
    const renamedPath = file.path + ext;

    try {
      await fs.rename(file.path, renamedPath);

      const { timestamped, clean, cost } = await runAudioPipeline(renamedPath, {
        originalName,
        onProgress: (step, detail) => emitter.emit('progress', { step, detail }),
        trimSilence,
      });
      await fs.unlink(renamedPath).catch(() => {});

      const baseName = path.basename(originalName, ext);
      const files = [
        { filename: `${baseName}_timestamped.md`, content: timestamped },
        { filename: `${baseName}_clean.md`,        content: clean },
      ];
      let totalCost = cost;

      if (notesTemplate) {
        try {
          emitter.emit('progress', { step: '📝 미팅 노트 후속 생성 중...', detail: notesTemplate });
          const noteResult = await runMeetingNotesPipeline(
            clean,
            notesTemplate,
            originalName,
            (step, detail) => emitter.emit('progress', { step, detail }),
            notesDetail,
            notesProvider,
          );
          files.push({ filename: `${baseName}_notes.md`, content: noteResult.markdown });
          totalCost = {
            totalCostUsd: cost.totalCostUsd + noteResult.cost.totalCostUsd,
            totalInputTokens: cost.totalInputTokens + noteResult.cost.totalInputTokens,
            totalOutputTokens: cost.totalOutputTokens + noteResult.cost.totalOutputTokens,
            breakdown: [...cost.breakdown, ...noteResult.cost.breakdown],
          };
        } catch (err) {
          emitter.emit('progress', {
            step: '⚠️  미팅 노트 생성 실패',
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }

      emitter.emit('result', { files, cost: totalCost });
    } catch (err) {
      await logEvent({
        level: 'error',
        context: 'api:transcribe',
        message: '녹취 작업 실패',
        jobId,
        err,
        extra: {
          fileName: originalName,
          fileSize: file.size,
          trimSilence,
          notesTemplate,
        },
      });
      await fs.unlink(renamedPath).catch(() => {});
      await fs.unlink(file.path).catch(() => {});
      emitter.emit('error', {
        message: err instanceof Error ? err.message : String(err),
        jobId,  // UI 가 이 jobId 로 상세 로그 조회 가능
      });
    }
  });

  // ─── 로그 조회 ─────────────────────────────────────────
  // 최근 에러/경고 이벤트를 JSON 으로 반환 (UI 의 "상세" 모달용)
  app.get('/api/logs/recent', (req, res) => {
    const limit = Math.min(parseInt((req.query['limit'] as string) ?? '50', 10) || 50, 200);
    const jobId = req.query['jobId'] as string | undefined;
    let events = getRecentEvents(limit);
    if (jobId) events = events.filter((e) => e.jobId === jobId);
    res.json({ logDir: getLogDir(), events });
  });

  // ─── 미팅 노트 ────────────────────────────────────────
  app.get('/api/meeting-templates', async (_req, res) => {
    try {
      const templates = await listTemplates();
      res.json({ templates });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post(
    '/api/meeting-templates/upload',
    upload.single('file'),
    async (req, res): Promise<void> => {
      const file = req.file;
      if (!file) { res.status(400).json({ error: '파일이 없습니다.' }); return; }
      try {
        const originalName = decodeFilename(file.originalname);
        if (!originalName.toLowerCase().endsWith('.md')) {
          res.status(400).json({ error: '.md 파일만 업로드 가능합니다.' });
          await fs.unlink(file.path).catch(() => {});
          return;
        }
        const content = await fs.readFile(file.path, 'utf-8');
        const info = await saveUserTemplate(originalName, content);
        await fs.unlink(file.path).catch(() => {});
        res.json({ template: info });
      } catch (err) {
        await fs.unlink(file.path).catch(() => {});
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post('/api/meeting-notes', async (req, res): Promise<void> => {
    const { transcript, templateId, source, detailLevel, provider } = req.body as {
      transcript?: string;
      templateId?: string;
      source?: string;
      detailLevel?: string;
      provider?: string;
    };
    if (!transcript || !templateId) {
      res.status(400).json({ error: 'transcript 와 templateId 가 필요합니다.' });
      return;
    }

    const { jobId, emitter } = createJob();
    res.json({ jobId });

    try {
      const result = await runMeetingNotesPipeline(
        transcript,
        templateId,
        source ?? 'pasted-transcript',
        (step, detail) => emitter.emit('progress', { step, detail }),
        normalizeDetailLevel(detailLevel),
        normalizeProvider(provider),
      );
      const baseName = (source ?? 'meeting').replace(/\.[^.]+$/, '');
      emitter.emit('result', {
        files: [{ filename: `${baseName}_notes.md`, content: result.markdown }],
        cost: result.cost,
        templateName: result.templateName,
      });
    } catch (err) {
      emitter.emit('error', { message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── 채팅 로그 분할 (SSE 불필요 — 빠름) ──────────────
  app.post('/api/chat-split', upload.single('file'), async (req, res): Promise<void> => {
    const file = req.file;
    if (!file) { res.status(400).json({ error: '파일이 없습니다.' }); return; }

    try {
      const originalName = decodeFilename(file.originalname);
      const ext = path.extname(originalName).toLowerCase();
      const renamedPath = file.path + ext;
      
      await fs.rename(file.path, renamedPath);
      
      let results;
      if (ext === '.html') {
        results = await processInstagramHtml(renamedPath, originalName);
      } else {
        results = await processChatCsv(renamedPath, originalName);
      }
      
      await fs.unlink(renamedPath).catch(() => {});

      const files = Array.from(results.entries()).map(([filename, content]) => ({
        filename, content,
      }));
      res.json({ files });
    } catch (err) {
      await fs.unlink(file.path).catch(() => {});
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // multer LIMIT_FILE_SIZE 등 업로드 단계 에러 처리
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const e = err as { code?: string; message?: string } | undefined;
    if (e?.code === 'LIMIT_FILE_SIZE') {
      const limitMb = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);
      res.status(413).json({ error: `파일이 ${limitMb}MB를 초과합니다. 더 짧은 파일로 분할하거나 비트레이트를 낮춰주세요.` });
      return;
    }
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: e?.message ?? '서버 오류' });
  });

  return app;
}

export function startServer(port = 3000) {
  const app = createServer();
  app.listen(port, () => {
    console.log(`\n🚀 Doc Converter UI 시작`);
    console.log(`   브라우저에서 열기: http://localhost:${port}\n`);
  });
}
