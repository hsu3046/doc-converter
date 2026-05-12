import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 에러/이벤트 추적용 logger.
 *
 * - JSON line 으로 ~/.doc-converter/logs/<YYYY-MM-DD>.jsonl 에 append
 * - 메모리 ring buffer 100개 (UI 빠른 조회용)
 * - 에러 객체의 nested cause 까지 직렬화 — Node fetch 의 "fetch failed" 같은 wrapped 에러
 *   원인을 끝까지 추적
 *
 * 호출 예:
 *   logEvent({ level: 'error', context: 'audio:chunk', message: '청크 transcribe 실패',
 *              err, extra: { chunkIndex: 2, model: 'gemini-...' } });
 */

export const LOG_DIR = path.join(os.homedir(), '.doc-converter', 'logs');

export type LogLevel = 'error' | 'warn' | 'info';

export interface SerializedError {
  name?: string;
  message?: string;
  stack?: string;
  code?: string | number;
  status?: number;
  cause?: SerializedError;
  responseBody?: string;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  context: string;
  message: string;
  jobId?: string;
  step?: string;
  err?: SerializedError;
  extra?: Record<string, unknown>;
}

const RING_MAX = 100;
const ringBuffer: LogEntry[] = [];

/**
 * Error 객체를 JSON 직렬화 가능한 plain object 로 변환.
 * - stack 은 첫 12줄까지만 (너무 길어지면 로그 가독성 X)
 * - cause 는 재귀 (최대 5단계)
 * - response.body / response.text 가 string 이면 1KB 까지 보존
 */
export function serializeError(err: unknown, depth = 0): SerializedError | undefined {
  if (err == null || depth > 5) return undefined;
  if (typeof err === 'string') return { message: err };
  if (typeof err !== 'object') return { message: String(err) };

  const e = err as Record<string, unknown> & {
    name?: string;
    message?: string;
    stack?: string;
    code?: string | number;
    status?: number;
    cause?: unknown;
    response?: { body?: unknown; text?: unknown; status?: number };
  };

  const stack = typeof e.stack === 'string'
    ? e.stack.split('\n').slice(0, 12).join('\n')
    : undefined;

  let responseBody: string | undefined;
  const rawBody = e.response?.body ?? e.response?.text;
  if (typeof rawBody === 'string') responseBody = rawBody.slice(0, 1024);
  else if (rawBody != null) {
    try { responseBody = JSON.stringify(rawBody).slice(0, 1024); } catch { /* skip */ }
  }

  return {
    name: e.name,
    message: e.message,
    stack,
    code: e.code,
    status: e.status ?? e.response?.status,
    cause: serializeError(e.cause, depth + 1),
    responseBody,
  };
}

interface LogInput {
  level: LogLevel;
  context: string;
  message: string;
  jobId?: string;
  step?: string;
  err?: unknown;
  extra?: Record<string, unknown>;
}

/**
 * 이벤트 기록 — 메모리 ring buffer + 파일 append.
 * 파일 쓰기 실패는 silent (메인 에러를 덮으면 안 됨).
 */
export async function logEvent(input: LogInput): Promise<void> {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level: input.level,
    context: input.context,
    message: input.message,
    jobId: input.jobId,
    step: input.step,
    err: input.err !== undefined ? serializeError(input.err) : undefined,
    extra: input.extra,
  };

  // 메모리 ring
  ringBuffer.push(entry);
  if (ringBuffer.length > RING_MAX) ringBuffer.shift();

  // 콘솔 — dev 가시성. error 는 stack 까지, warn/info 는 한 줄.
  const tag = `[${entry.level.toUpperCase()}] [${entry.context}]`;
  const msg = entry.err?.message ? `${entry.message} — ${entry.err.message}` : entry.message;
  if (entry.level === 'error') {
    console.error(tag, msg);
    if (entry.err?.stack) console.error(entry.err.stack);
    if (entry.err?.cause) console.error('  cause:', JSON.stringify(entry.err.cause));
    if (entry.err?.responseBody) console.error('  body:', entry.err.responseBody);
  } else if (entry.level === 'warn') {
    console.warn(tag, msg);
  } else {
    console.log(tag, msg);
  }

  // 파일 — silent on failure
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const day = entry.timestamp.slice(0, 10);
    const logPath = path.join(LOG_DIR, `${day}.jsonl`);
    await fs.appendFile(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    /* 무시 — 로그 실패가 메인 처리를 막으면 안 됨 */
  }
}

/** 최근 이벤트 반환 (UI 표시용). 최신 순. */
export function getRecentEvents(limit = 50): LogEntry[] {
  return ringBuffer.slice(-limit).reverse();
}

/** 호출자가 "로그 폴더 열기" 같은 UI 동작에 쓸 수 있도록 경로 노출 */
export function getLogDir(): string {
  return LOG_DIR;
}
