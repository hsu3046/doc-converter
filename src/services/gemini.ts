import { GoogleGenAI, createPartFromUri } from '@google/genai';
import util from 'node:util';
import { PRICING, type UsageInfo, type GenerateResult } from '../types/index.js';
import { logEvent } from '../utils/error-logger.js';

let client: GoogleGenAI | null = null;

/**
 * Gemini API 클라이언트 초기화 (싱글턴)
 */
export function getClient(): GoogleGenAI {
  if (client) return client;

  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY 환경변수가 설정되지 않았습니다.\n' +
      '.env.local 파일에 GEMINI_API_KEY=your_key 형식으로 추가하세요.\n' +
      'API 키 발급: https://aistudio.google.com/apikey'
    );
  }

  client = new GoogleGenAI({ apiKey });
  return client;
}

/**
 * 토큰 수와 모델 단가로 실제 비용 계산 (USD)
 */
export function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.inputPerM +
         (outputTokens / 1_000_000) * pricing.outputPerM;
}

/**
 * Gemini API 일시 오류(503/429/500/502/504)에 대해 지수 백오프 재시도.
 * 재시도 불가능한 에러(400, 401, 403, INVALID_ARGUMENT 등)는 즉시 throw.
 */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_KEYWORDS = [
  // Gemini 서버 측 일시 에러
  'UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'DEADLINE_EXCEEDED',
  // 네트워크 일시 단절 (undici fetch / Node 내장 fetch)
  'fetch failed', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'socket hang up', 'network error', 'ENOTFOUND', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
];

function isNetworkError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? '');
  const causeMsg = String(((err as { cause?: { message?: unknown } })?.cause?.message) ?? '');
  const code = (err as { code?: unknown })?.code;
  const causeCode = (err as { cause?: { code?: unknown } })?.cause?.code;
  for (const k of RETRY_KEYWORDS) {
    if (msg.includes(k) || causeMsg.includes(k) || code === k || causeCode === k) return true;
  }
  return false;
}

function extractStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof e.status === 'number') return e.status;
  if (typeof e.code === 'number') return e.code;
  // 메시지에 JSON 박혀있는 케이스: '{"error":{"code":503,...}}'
  if (typeof e.message === 'string') {
    const m = e.message.match(/"code"\s*:\s*(\d{3})/);
    if (m) return parseInt(m[1]!, 10);
  }
  return undefined;
}

function isRetryable(err: unknown): boolean {
  const status = extractStatusCode(err);
  if (status && RETRY_STATUSES.has(status)) return true;
  return isNetworkError(err);
}

function friendlyError(err: unknown): Error {
  const status = extractStatusCode(err);
  const msg = (err as { message?: string })?.message ?? String(err);
  if (status === 503 || msg.includes('UNAVAILABLE')) {
    return new Error('Gemini 서버가 일시 과부하 상태입니다. 잠시 후 다시 시도해주세요.');
  }
  if (status === 429 || msg.includes('RESOURCE_EXHAUSTED')) {
    return new Error('Gemini API 할당량이 초과되었습니다. 잠시 후 다시 시도해주세요.');
  }
  if (isNetworkError(err)) {
    return new Error('네트워크 연결이 불안정합니다. 잠시 후 다시 시도해주세요.');
  }
  return err instanceof Error ? err : new Error(msg);
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 4,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err);
      if (attempt === maxAttempts || !retryable) {
        // 최종 실패 — 상세 정보 기록
        await logEvent({
          level: 'error',
          context: `gemini:${label}`,
          message: `${label} 실패 (재시도 ${attempt - 1}회 후 포기)`,
          err,
          extra: { attempts: attempt, maxAttempts, retryable },
        });
        throw friendlyError(err);
      }
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      const status = extractStatusCode(err) ?? '?';
      // 중간 실패 — warn 으로만 기록 (사용자가 결과적으로 성공하면 무시 가능)
      await logEvent({
        level: 'warn',
        context: `gemini:${label}`,
        message: `${label} 시도 ${attempt}/${maxAttempts} 실패, ${backoffMs}ms 후 재시도`,
        err,
        extra: { attempt, maxAttempts, backoffMs, status },
      });
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw friendlyError(lastErr);
}

/**
 * Gemini 콘텐츠 생성 — inline base64 방식 (이미지/오디오용)
 */
export async function generateText(
  model: string,
  prompt: string,
  inlineData?: { mimeType: string; data: string } | Array<{ mimeType: string; data: string }>,
  generationConfig?: { maxOutputTokens?: number; temperature?: number }
): Promise<GenerateResult> {
  const ai = getClient();

  const contents: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

  if (Array.isArray(inlineData)) {
    for (const data of inlineData) {
      contents.push({ inlineData: data });
    }
  } else if (inlineData) {
    contents.push({ inlineData });
  }

  contents.push({ text: prompt });

  const response = await withRetry(`generateContent(${model})`, () =>
    ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: contents }],
      ...(generationConfig ? { config: generationConfig } : {}),
    }),
  );

  const inputTokens  = response.usageMetadata?.promptTokenCount     ?? 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount  ?? 0;
  const costUsd      = calcCost(model, inputTokens, outputTokens);

  const usage: UsageInfo = { model, inputTokens, outputTokens, costUsd };

  return { text: response.text ?? '', usage };
}

/**
 * Gemini File API 방식 — 파일 업로드 → URI 참조 → 처리 → 삭제
 * 대용량/멀티페이지 PDF 전용 (20MB 제한 없음, 최대 2GB)
 */
export async function generateTextWithFileApi(
  model: string,
  prompt: string,
  filePath: string,
  mimeType: string,
  onUploadProgress?: (msg: string) => void
): Promise<GenerateResult> {
  const ai = getClient();
  let uploadedFileName: string | undefined;

  try {
    // 1. File API로 업로드 (네트워크 일시 단절 대비 retry)
    onUploadProgress?.('📡 Gemini File API에 업로드 중...');
    const uploaded = await withRetry(`files.upload`, () =>
      ai.files.upload({
        file: filePath,
        config: { mimeType, displayName: filePath.split('/').pop() },
      }),
    );

    uploadedFileName = uploaded.name;
    onUploadProgress?.(`✅ 업로드 완료 (${uploaded.name})`);

    // 2. 파일이 ACTIVE 상태가 될 때까지 대기 (대용량 파일 처리 시간 필요)
    //    개별 polling 요청은 네트워크 일시 에러를 자체 흡수 — polling 자체는 무한 루프라
    //    한 번 실패해도 다음 iteration 에서 다시 시도하는 게 자연.
    let fileState = uploaded.state as string | undefined;
    if (fileState === 'PROCESSING' || fileState === undefined) {
      onUploadProgress?.('⏳ 파일 처리 대기 중...');
      const pollStart = Date.now();
      while (true) {
        await new Promise((r) => setTimeout(r, 2000));
        let info: { state?: string };
        try {
          info = await (ai.files as any).get({ name: uploaded.name });
        } catch (pollErr) {
          if (isNetworkError(pollErr)) {
            // 네트워크 일시 단절 — 다음 iteration 에서 다시 polling
            onUploadProgress?.('⏳ 네트워크 일시 단절, 재시도 중...');
            continue;
          }
          throw pollErr;
        }
        fileState = info.state as string;
        const elapsed = ((Date.now() - pollStart) / 1000).toFixed(0);
        if (fileState === 'ACTIVE') {
          onUploadProgress?.(`✅ 파일 준비 완료 (${elapsed}초 대기)`);
          break;
        }
        if (fileState === 'FAILED') {
          throw new Error(`File API 처리 실패: ${uploaded.name}`);
        }
        onUploadProgress?.(`⏳ 파일 처리 중... (${elapsed}초 경과)`);
      }
    }

    const fileUri = uploaded.uri;
    if (!fileUri) throw new Error('File API URI를 가져오지 못했습니다.');

    // 3. 업로드된 파일 URI로 콘텐츠 생성 (재시도 포함)
    let response;
    try {
      response = await withRetry(`generateContent(file ${model})`, () =>
        ai.models.generateContent({
          model,
          contents: [{
            role: 'user',
            parts: [
              createPartFromUri(fileUri, mimeType),
              { text: prompt },
            ],
          }],
        }),
      );
    } catch (apiError: any) {
      // INVALID_ARGUMENT 는 재시도 무의미 (PDF 구조 문제) — 호출자에게 그대로 전달해 fallback 트리거
      const errMsg = apiError.message || '';
      if (errMsg.includes('INVALID_ARGUMENT')) {
        console.error('[Gemini API] INVALID_ARGUMENT:', util.inspect(apiError, { depth: 2 }));
        throw new Error(`Gemini API 파일 검증 실패 (INVALID_ARGUMENT): 해당 PDF 구조, 용량(페이지 수), 또는 인코딩을 모델(${model})이 지원하지 않습니다.`);
      }
      throw apiError;  // friendlyError 로 이미 변환됨
    }

    const inputTokens  = response.usageMetadata?.promptTokenCount    ?? 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    const costUsd      = calcCost(model, inputTokens, outputTokens);

    return { text: response.text ?? '', usage: { model, inputTokens, outputTokens, costUsd } };

  } finally {
    // 3. 처리 완료 후 파일 삭제 (성공/실패 무관)
    if (uploadedFileName) {
      await ai.files.delete({ name: uploadedFileName }).catch((e: unknown) => {
        console.warn('[File API] 파일 삭제 실패:', uploadedFileName, e);
      });
    }
  }
}
