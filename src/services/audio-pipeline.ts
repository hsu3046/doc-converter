import path from 'node:path';
import { generateText, generateTextWithFileApi } from './gemini.js';
import { readFileBuffer, getMimeType, basename } from '../utils/file-io.js';
import {
  buildEvidenceMarkdown,
  formatKstMinute,
  nowISO,
  converterVersion,
} from '../templates/evidence.js';
import { MODELS, type CostSummary, type UsageInfo, type GenerateResult } from '../types/index.js';
import type { ProgressCallback } from './ocr-pipeline.js';
import {
  splitAudioToChunks,
  cleanupChunks,
  probeDuration,
  probeRecordingTime,
  type AudioChunk,
} from '../utils/audio-splitter.js';
import {
  trimSilence,
  cleanupTrimmed,
  trimmedToOriginal,
  type SegmentMap,
  type TrimResult,
} from '../utils/trim-silence.js';
import { logEvent } from '../utils/error-logger.js';

export interface AudioResult {
  timestamped: string;
  clean: string;
  cost: CostSummary;
}

export interface AudioPipelineOptions {
  originalName?: string;
  onProgress?: ProgressCallback;
  /** VAD 로 무음 구간 자동 제거 (Gemini 입력 시간 절감). 기본 false */
  trimSilence?: boolean;
}

const CHUNK_THRESHOLD_SEC = 9 * 60;
const CHUNK_DURATION_SEC = 10 * 60;
const MAX_DURATION_SEC = 4 * 3600;
/** 다음 청크 프롬프트에 inject 할 직전 청크의 마지막 화자 발화 개수 */
const PREV_CONTEXT_LINES = 6;

/** 초 → "N시간 M분 / N분 S초 / S초" 보기 좋은 한국어 표기 */
function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(0)}초`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s === 0 ? `${m}분` : `${m}분 ${s}초`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

const BASE_TRANSCRIBE_PROMPT = `이 오디오 파일의 내용을 한국어로 정확하게 녹취해주세요.

## 요구사항:
1. 화자를 구분해주세요 (화자A, 화자B 등).
2. 타임스탬프를 [HH:MM:SS] 형식으로 포함해주세요.
3. 아래 형식으로 출력해주세요:

**[00:00:12] 화자A:** 대화 내용...

**[00:00:25] 화자B:** 대화 내용...

4. 불확실한 부분은 (불명확) 표시를 해주세요.
5. 위 형식의 녹취록만 출력하세요. 추가 설명은 불필요합니다.`;

/**
 * 첫 청크는 base 프롬프트.
 * 이어지는 청크는 직전 청크 마지막 발화를 컨텍스트로 inject — 화자 라벨 일관성 보장.
 */
function buildPromptWithContext(prevContext: string | null): string {
  if (!prevContext) return BASE_TRANSCRIBE_PROMPT;
  return `${BASE_TRANSCRIBE_PROMPT}

## 직전 구간 마지막 발화 (참고용 — 라벨 일관성)
이 오디오는 같은 미팅의 이어지는 구간입니다. 직전에 등장한 화자가 다시 말하면 같은 라벨(화자A/B 등)을 유지하세요. 새 화자라면 다음 알파벳(화자C, 화자D...)을 부여하세요.

${prevContext}`;
}

/**
 * 청크 결과 텍스트의 마지막 N개 화자 발화를 추출 — 다음 청크 프롬프트 컨텍스트.
 */
function extractLastSpeakerLines(text: string, n: number = PREV_CONTEXT_LINES): string {
  // 타임스탬프 [HH:MM:SS] 또는 [MM:SS] 모두 인식 (Gemini 가 짧은 청크에서 단축 출력)
  const regex = /\*\*\[\d{1,2}:\d{2}(?::\d{2})?\]\s+(?:화자[A-Z0-9]+|화자\d+|Speaker[A-Z0-9]+):\*\*\s*[^\n]+/g;
  const matches = text.match(regex) ?? [];
  return matches.slice(-n).join('\n');
}

async function transcribeInline(filePath: string): Promise<GenerateResult> {
  const buffer = await readFileBuffer(filePath);
  const mimeType = getMimeType(filePath);
  const base64 = buffer.toString('base64');
  return generateText(MODELS.AUDIO, BASE_TRANSCRIBE_PROMPT, { mimeType, data: base64 });
}

async function transcribeChunkViaFileApi(
  chunkPath: string,
  prompt: string,
  onProgress?: (msg: string) => void,
): Promise<GenerateResult> {
  const mimeType = getMimeType(chunkPath);
  return generateTextWithFileApi(MODELS.AUDIO, prompt, chunkPath, mimeType, onProgress);
}

function removeTimestamps(timestamped: string): string {
  // [HH:MM:SS] / [MM:SS] / [H:MM:SS] 모두 처리 (offsetTimestamps 출력은 통일이지만 inline 경로 대비)
  return timestamped.replace(/\*\*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/g, '**');
}

function formatTs(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 청크 결과의 타임스탬프를 (i × CHUNK_DURATION_SEC) 만큼 미루고
 * 출력 형식을 [HH:MM:SS] 로 통일. STT 가 짧은 청크에서 [MM:SS] 만 내놓는 경우도 처리.
 *
 * 입력 패턴:
 *   [HH:MM:SS] — 일반
 *   [MM:SS]    — 짧은 청크에서 Gemini 가 종종 단축 출력
 *   [H:MM:SS]  — 1자리 시 (00 생략)
 */
function offsetTimestamps(text: string, offsetSec: number): string {
  return text.replace(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g, (_, a: string, b: string, c?: string) => {
    let total: number;
    if (c !== undefined) {
      // HH:MM:SS
      total = parseInt(a, 10) * 3600 + parseInt(b, 10) * 60 + parseInt(c, 10);
    } else {
      // MM:SS — 시는 0
      total = parseInt(a, 10) * 60 + parseInt(b, 10);
    }
    return `[${formatTs(total + offsetSec)}]`;
  });
}

/**
 * trimmed 시각 기준 timestamp [HH:MM:SS] 를 원본 시각으로 역변환.
 * VAD 로 무음 잘라낸 입력의 Gemini 응답을 원본 녹음 시각 기준 회의록으로 정렬.
 */
function mapTimestampsToOriginal(text: string, segmentMap: SegmentMap[]): string {
  return text.replace(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g, (_, a: string, b: string, c?: string) => {
    const total = c !== undefined
      ? parseInt(a, 10) * 3600 + parseInt(b, 10) * 60 + parseInt(c, 10)
      : parseInt(a, 10) * 60 + parseInt(b, 10);
    return `[${formatTs(trimmedToOriginal(total, segmentMap))}]`;
  });
}

/**
 * 청크를 순차적으로 처리하면서 직전 청크의 마지막 발화를 다음 프롬프트에 컨텍스트로 inject.
 * 화자 라벨이 STT 단계에서 자연스럽게 일관성 유지됨 (사후 매핑 LLM 호출 불필요).
 *
 * 산업 표준 (AssemblyAI/Pyannote 의 "unified context") 의 텍스트 기반 대응 패턴.
 */
async function transcribeChunksSequential(
  chunks: AudioChunk[],
  onProgress?: ProgressCallback,
): Promise<Array<{ index: number; startSec: number; text: string; usage: UsageInfo }>> {
  const results: Array<{ index: number; startSec: number; text: string; usage: UsageInfo }> = [];
  const total = chunks.length;
  let prevContext: string | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    onProgress?.(
      `🎙️ ${i + 1}/${total}번째 조각 녹취 중...`,
      i === 0 ? undefined : '이전 대화 이어받기',
    );
    const t = Date.now();
    const prompt = buildPromptWithContext(prevContext);
    let result;
    try {
      result = await transcribeChunkViaFileApi(chunk.chunkPath, prompt);
    } catch (err) {
      await logEvent({
        level: 'error',
        context: 'audio:chunk',
        message: `${i + 1}/${total}번째 조각 녹취 실패`,
        step: `chunk ${i + 1}/${total}`,
        err,
        extra: {
          chunkIndex: i,
          totalChunks: total,
          chunkStartSec: chunk.startSec,
          chunkPath: chunk.chunkPath,
          model: MODELS.AUDIO,
        },
      });
      throw err;
    }
    results.push({
      index: chunk.index,
      startSec: chunk.startSec,
      text: result.text,
      usage: result.usage,
    });
    const elapsed = ((Date.now() - t) / 1000).toFixed(0);
    onProgress?.(
      `✅ ${i + 1}/${total}번째 완료`,
      `${elapsed}초 소요 · 누적 $${results.reduce((s, r) => s + r.usage.costUsd, 0).toFixed(3)}`,
    );
    prevContext = extractLastSpeakerLines(result.text);
  }
  return results;
}

export async function runAudioPipeline(
  filePath: string,
  options: AudioPipelineOptions = {},
): Promise<AudioResult> {
  const { originalName, onProgress, trimSilence: doTrim = false } = options;
  const fileName = originalName ?? path.basename(filePath);
  const name = basename(originalName ?? filePath);

  onProgress?.(`📤 파일 확인 완료 — ${fileName}`);

  // 0) 원본 녹음 시각 메타데이터 추출 (분 단위 KST). 실패는 silent.
  //    원본 파일 기준으로 추출 (trim 후 mp3 는 메타 X).
  const recordedAtDate = await probeRecordingTime(filePath).catch(() => undefined);
  const recordedAt = recordedAtDate ? formatKstMinute(recordedAtDate) : undefined;
  if (recordedAt) {
    onProgress?.(`🕐 녹음 시각: ${recordedAt}`);
  }

  // 1) VAD trim 옵션 ON 시 — 무음 잘라낸 mp3 + 매핑 테이블 확보
  let trim: TrimResult | null = null;
  let workPath = filePath;
  if (doTrim) {
    try {
      trim = await trimSilence(filePath, { onProgress });
      workPath = trim.trimmedPath;
    } catch (err) {
      await logEvent({
        level: 'warn',
        context: 'audio:trim',
        message: 'VAD 기반 무음 제거 실패 — 원본으로 fallback',
        err,
        extra: { filePath, originalName },
      });
      onProgress?.(
        '⚠️ 무음 제거 실패 — 원본 그대로 진행합니다',
        err instanceof Error ? err.message : String(err),
      );
      trim = null;
    }
  }

  try {
    return await runPipelineCore(workPath, fileName, name, onProgress, recordedAt, trim);
  } finally {
    if (trim) await cleanupTrimmed(trim);
  }
}

async function runPipelineCore(
  workPath: string,
  fileName: string,
  name: string,
  onProgress: ProgressCallback | undefined,
  recordedAt: string | undefined,
  trim: TrimResult | null,
): Promise<AudioResult> {
  // 길이 측정 → 짧으면 inline 경로, 길면 청크 모드, 너무 길면 거부
  let duration: number;
  try {
    duration = await probeDuration(workPath);
  } catch (err) {
    // ffprobe 미설치 등 → inline 경로로 폴백 시도 (짧은 파일이면 동작)
    onProgress?.(
      '⚠️ 길이 측정 실패 — 그대로 진행합니다',
      err instanceof Error ? err.message : String(err),
    );
    return runInlineFallback(workPath, fileName, name, onProgress, recordedAt, trim);
  }

  if (duration > MAX_DURATION_SEC) {
    throw new Error(
      `오디오 길이 ${(duration / 60).toFixed(1)}분이 최대 한도(${MAX_DURATION_SEC / 60}분)를 초과합니다.`,
    );
  }

  if (duration <= CHUNK_THRESHOLD_SEC) {
    onProgress?.(`🎙️ 녹취 중... (${fmtDuration(duration)})`);
    return runInlineFallback(workPath, fileName, name, onProgress, recordedAt, trim);
  }

  // 청크 모드
  const numChunks = Math.ceil(duration / CHUNK_DURATION_SEC);
  onProgress?.(
    `🔪 녹음 파일 분할 중`,
    `${CHUNK_DURATION_SEC / 60}분씩 ${numChunks}조각`,
  );

  const chunks = await splitAudioToChunks(workPath, CHUNK_DURATION_SEC);
  onProgress?.(`✅ 분할 완료`);

  const usageList: UsageInfo[] = [];
  try {
    const chunkResults = await transcribeChunksSequential(chunks, onProgress);
    for (const r of chunkResults) usageList.push(r.usage);

    onProgress?.('💾 결과 합치는 중...');

    // 청크별: 실측 startSec 으로 타임스탬프 오프셋 (=trimmed 시각). trim 적용 시 마지막에 segmentMap 으로 원본 시각 역매핑.
    let merged = chunkResults
      .map((r) => offsetTimestamps(r.text, r.startSec).trim())
      .join('\n\n');
    if (trim) merged = mapTimestampsToOriginal(merged, trim.segmentMap);

    return buildAudioResult(merged, fileName, name, usageList, recordedAt);
  } finally {
    await cleanupChunks(chunks);
  }
}

async function runInlineFallback(
  filePath: string,
  fileName: string,
  name: string,
  onProgress?: ProgressCallback,
  recordedAt?: string,
  trim?: TrimResult | null,
): Promise<AudioResult> {
  const t = Date.now();
  const result = await transcribeInline(filePath);
  onProgress?.(
    `✅ 녹취 완료`,
    `${((Date.now() - t) / 1000).toFixed(0)}초 소요`,
  );
  // trim 적용 시 응답 timestamp 는 trimmed 시각 — 원본 시각으로 역매핑
  const body = trim ? mapTimestampsToOriginal(result.text, trim.segmentMap) : result.text;
  return buildAudioResult(body, fileName, name, [result.usage], recordedAt);
}

function buildAudioResult(
  body: string,
  fileName: string,
  name: string,
  usageList: UsageInfo[],
  recordedAt?: string,
): AudioResult {
  const processed = nowISO();
  const baseMeta = {
    type: 'transcript' as const,
    source: fileName,
    processed,
    converter: converterVersion(),
    ...(recordedAt ? { recordedAt } : {}),
  };
  const timestamped = buildEvidenceMarkdown(baseMeta, `녹취록: ${name} (타임스탬프)`, body);
  const cleanBody = removeTimestamps(body);
  const clean = buildEvidenceMarkdown(baseMeta, `녹취록: ${name}`, cleanBody);

  const cost: CostSummary = {
    totalCostUsd: usageList.reduce((s, u) => s + u.costUsd, 0),
    totalInputTokens: usageList.reduce((s, u) => s + u.inputTokens, 0),
    totalOutputTokens: usageList.reduce((s, u) => s + u.outputTokens, 0),
    breakdown: usageList,
  };

  return { timestamped, clean, cost };
}
