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

export interface AudioResult {
  timestamped: string;
  clean: string;
  cost: CostSummary;
}

const CHUNK_THRESHOLD_SEC = 9 * 60;
const CHUNK_DURATION_SEC = 10 * 60;
const MAX_DURATION_SEC = 2.5 * 3600;
/** 다음 청크 프롬프트에 inject 할 직전 청크의 마지막 화자 발화 개수 */
const PREV_CONTEXT_LINES = 6;

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
      `🎙️ 청크 ${i + 1}/${total} 처리 중...`,
      i === 0 ? '첫 청크' : '직전 컨텍스트 inject',
    );
    const t = Date.now();
    const prompt = buildPromptWithContext(prevContext);
    const result = await transcribeChunkViaFileApi(chunk.chunkPath, prompt);
    results.push({
      index: chunk.index,
      startSec: chunk.startSec,
      text: result.text,
      usage: result.usage,
    });
    const elapsed = ((Date.now() - t) / 1000).toFixed(1);
    onProgress?.(
      `✅ 청크 ${i + 1}/${total} 완료 (${elapsed}초, ${result.usage.inputTokens.toLocaleString()} 토큰)`,
      `${i + 1}/${total} · 누적 비용 ${results.reduce((s, r) => s + r.usage.costUsd, 0).toFixed(4)} USD`,
    );
    prevContext = extractLastSpeakerLines(result.text);
  }
  return results;
}

export async function runAudioPipeline(
  filePath: string,
  originalName?: string,
  onProgress?: ProgressCallback,
): Promise<AudioResult> {
  const fileName = originalName ?? path.basename(filePath);
  const name = basename(originalName ?? filePath);

  onProgress?.(`📤 파일 수신 완료 — ${fileName}`);

  // 0) 원본 녹음 시각 메타데이터 추출 (분 단위 KST). 실패는 silent.
  const recordedAtDate = await probeRecordingTime(filePath).catch(() => undefined);
  const recordedAt = recordedAtDate ? formatKstMinute(recordedAtDate) : undefined;
  if (recordedAt) {
    onProgress?.(`🕐 원본 녹음 시각: ${recordedAt}`);
  }

  // 1) 길이 측정 → 짧으면 inline 경로, 길면 청크 모드, 너무 길면 거부
  let duration: number;
  try {
    onProgress?.('📊 길이 측정 중...');
    duration = await probeDuration(filePath);
  } catch (err) {
    // ffprobe 미설치 등 → inline 경로로 폴백 시도 (짧은 파일이면 동작)
    onProgress?.(
      '⚠️  길이 측정 실패 — inline 경로로 시도합니다.',
      err instanceof Error ? err.message : String(err),
    );
    return runInlineFallback(filePath, fileName, name, onProgress, recordedAt);
  }

  if (duration > MAX_DURATION_SEC) {
    throw new Error(
      `오디오 길이 ${(duration / 60).toFixed(1)}분이 최대 한도(${MAX_DURATION_SEC / 60}분)를 초과합니다.`,
    );
  }

  if (duration <= CHUNK_THRESHOLD_SEC) {
    onProgress?.(
      `🎙️ 녹취 중... (${(duration / 60).toFixed(1)}분, 단일 처리)`,
      MODELS.AUDIO,
    );
    return runInlineFallback(filePath, fileName, name, onProgress, recordedAt);
  }

  // 2) 청크 모드
  const numChunks = Math.ceil(duration / CHUNK_DURATION_SEC);
  onProgress?.(
    `🔪 ffmpeg 청크 분할 (${CHUNK_DURATION_SEC / 60}분 × ${numChunks}개)`,
    `총 ${(duration / 60).toFixed(1)}분`,
  );

  const tSplit = Date.now();
  const chunks = await splitAudioToChunks(filePath, CHUNK_DURATION_SEC);
  onProgress?.(
    `✅ 분할 완료 (${chunks.length}개, ${((Date.now() - tSplit) / 1000).toFixed(1)}초)`,
    `순차 처리 시작 — 직전 청크 컨텍스트 inject 로 화자 라벨 일관성 유지`,
  );

  const usageList: UsageInfo[] = [];
  try {
    const tSeq = Date.now();
    const chunkResults = await transcribeChunksSequential(chunks, onProgress);
    onProgress?.(
      `✅ 순차 녹취 완료 (${((Date.now() - tSeq) / 1000).toFixed(1)}초)`,
    );
    for (const r of chunkResults) usageList.push(r.usage);

    onProgress?.('💾 결과 머지 + 두 버전 생성 중...');

    // 청크별: 실측 startSec 으로 타임스탬프 오프셋만 적용 (화자 매핑 불필요 — STT 단계에서 이미 일관)
    const merged = chunkResults
      .map((r) => offsetTimestamps(r.text, r.startSec).trim())
      .join('\n\n');

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
): Promise<AudioResult> {
  const t = Date.now();
  const result = await transcribeInline(filePath);
  onProgress?.(
    `✅ 녹취 완료 (${((Date.now() - t) / 1000).toFixed(1)}초)`,
    `${result.usage.inputTokens.toLocaleString()} 토큰 입력`,
  );
  return buildAudioResult(result.text, fileName, name, [result.usage], recordedAt);
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
