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
const PARALLEL_LIMIT = 8;

const TRANSCRIBE_PROMPT = `이 오디오 파일의 내용을 한국어로 정확하게 녹취해주세요.

## 요구사항:
1. 화자를 구분해주세요 (화자A, 화자B 등).
2. 타임스탬프를 [HH:MM:SS] 형식으로 포함해주세요.
3. 아래 형식으로 출력해주세요:

**[00:00:12] 화자A:** 대화 내용...

**[00:00:25] 화자B:** 대화 내용...

4. 불확실한 부분은 (불명확) 표시를 해주세요.
5. 위 형식의 녹취록만 출력하세요. 추가 설명은 불필요합니다.`;

async function transcribeInline(filePath: string): Promise<GenerateResult> {
  const buffer = await readFileBuffer(filePath);
  const mimeType = getMimeType(filePath);
  const base64 = buffer.toString('base64');
  return generateText(MODELS.AUDIO, TRANSCRIBE_PROMPT, { mimeType, data: base64 });
}

async function transcribeChunkViaFileApi(
  chunkPath: string,
  onProgress?: (msg: string) => void,
): Promise<GenerateResult> {
  const mimeType = getMimeType(chunkPath);
  return generateTextWithFileApi(MODELS.AUDIO, TRANSCRIBE_PROMPT, chunkPath, mimeType, onProgress);
}

function removeTimestamps(timestamped: string): string {
  return timestamped.replace(/\*\*\[\d{2}:\d{2}:\d{2}\]\s*/g, '**');
}

function formatTs(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 청크 i 결과의 [HH:MM:SS] 모두를 (i × CHUNK_DURATION_SEC) 만큼 미룬다.
 */
function offsetTimestamps(text: string, offsetSec: number): string {
  return text.replace(/\[(\d{2}):(\d{2}):(\d{2})\]/g, (_, h: string, m: string, s: string) => {
    const total = parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10);
    return `[${formatTs(total + offsetSec)}]`;
  });
}

/**
 * 청크 텍스트에서 화자 라벨 (예: "화자A", "화자B") 패턴 추출.
 * 라벨별로 첫 발화 1줄을 샘플로 잡는다.
 */
function extractSpeakerSamples(text: string): Map<string, string> {
  const samples = new Map<string, string>();
  // 매치: **[HH:MM:SS] 화자A:** 본문...
  const regex = /\*\*\[\d{2}:\d{2}:\d{2}\]\s+(화자[A-Z]+|Speaker[A-Z0-9]+):\*\*\s*([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const label = m[1]!;
    const utterance = m[2]!.trim();
    if (!samples.has(label)) {
      samples.set(label, utterance.slice(0, 120));
    }
  }
  return samples;
}

/**
 * 청크별 화자 샘플을 모아 LLM에 정합 매핑 요청.
 * 실패 시 null 반환 → 호출자는 매핑 없이 진행.
 */
async function reconcileSpeakers(
  chunkResults: Array<{ index: number; text: string }>,
  onProgress?: ProgressCallback,
): Promise<{ mapping: Record<number, Record<string, string>>; usage: UsageInfo } | null> {
  const lines: string[] = [];
  for (const { index, text } of chunkResults) {
    const samples = extractSpeakerSamples(text);
    if (samples.size === 0) continue;
    lines.push(`청크 ${index}:`);
    for (const [label, utterance] of samples) {
      lines.push(`  ${label}: "${utterance}"`);
    }
  }
  if (lines.length === 0) return null;

  const prompt = `아래는 동일 음성을 시간 단위로 쪼개 녹취한 결과의 청크별 화자 라벨 + 첫 발화 샘플입니다.
각 청크에서 같은 라벨(예: 화자A)이라도 실제로는 서로 다른 사람일 수 있습니다.
발화 내용/말투/주제 흐름을 보고 청크 간 동일 인물이 같은 통합 라벨(화자1, 화자2 ...)을 갖도록 매핑하세요.

## 청크별 샘플
${lines.join('\n')}

## 출력 (JSON만, 추가 설명 금지)
{
  "0": {"화자A": "화자1", "화자B": "화자2"},
  "1": {"화자A": "화자1", "화자B": "화자2"},
  ...
}`;

  try {
    onProgress?.('🎭 화자 라벨 정합 중...', MODELS.AUDIO);
    const result = await generateText(MODELS.AUDIO, prompt);
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const mapping = JSON.parse(jsonMatch[0]) as Record<string, Record<string, string>>;
    const normalized: Record<number, Record<string, string>> = {};
    for (const [k, v] of Object.entries(mapping)) {
      normalized[parseInt(k, 10)] = v;
    }
    return { mapping: normalized, usage: result.usage };
  } catch (err) {
    onProgress?.(
      '⚠️  화자 라벨 정합 실패 — 청크별 라벨이 다를 수 있습니다.',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * 청크 텍스트에 라벨 매핑 적용 (화자A → 화자1).
 * 매핑된 라벨끼리 충돌(예: 화자A→화자1, 화자B→화자1)을 막기 위해 단일 패스 토큰 치환 사용.
 */
function applySpeakerMapping(text: string, mapping: Record<string, string>): string {
  const labels = Object.keys(mapping);
  if (labels.length === 0) return text;
  // 가장 긴 라벨부터 매칭 (Speaker10 → Speaker1 보다 우선)
  labels.sort((a, b) => b.length - a.length);
  const re = new RegExp(`(\\*\\*\\[\\d{2}:\\d{2}:\\d{2}\\]\\s+)(${labels.join('|')})(:\\*\\*)`, 'g');
  return text.replace(re, (_, ts: string, label: string, tail: string) => {
    return `${ts}${mapping[label] ?? label}${tail}`;
  });
}

/**
 * 동시 호출 상한을 두고 청크 처리.
 * 도착 순으로 onProgress 알림.
 */
async function transcribeChunksParallel(
  chunks: AudioChunk[],
  onProgress?: ProgressCallback,
): Promise<Array<{ index: number; startSec: number; text: string; usage: UsageInfo }>> {
  const results: Array<{ index: number; startSec: number; text: string; usage: UsageInfo }> = [];
  let completed = 0;
  const total = chunks.length;

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < chunks.length) {
      const myIndex = cursor++;
      const chunk = chunks[myIndex]!;
      const t = Date.now();
      const result = await transcribeChunkViaFileApi(chunk.chunkPath);
      results.push({
        index: chunk.index,
        startSec: chunk.startSec,
        text: result.text,
        usage: result.usage,
      });
      completed++;
      const elapsed = ((Date.now() - t) / 1000).toFixed(1);
      onProgress?.(
        `⚙️  청크 ${chunk.index + 1}/${total} 완료 (${elapsed}초, ${result.usage.inputTokens.toLocaleString()} 토큰)`,
        `진행 ${completed}/${total}`,
      );
    }
  }

  const workers = Array.from({ length: Math.min(PARALLEL_LIMIT, chunks.length) }, () => worker());
  await Promise.all(workers);
  results.sort((a, b) => a.index - b.index);
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
    `병렬 ${PARALLEL_LIMIT} 동시 처리 시작`,
  );

  const usageList: UsageInfo[] = [];
  try {
    onProgress?.(`🎙️ 병렬 녹취 시작 (동시 ${PARALLEL_LIMIT} 한도)`, MODELS.AUDIO);
    const tParallel = Date.now();
    const chunkResults = await transcribeChunksParallel(chunks, onProgress);
    onProgress?.(
      `✅ 병렬 녹취 완료 (${((Date.now() - tParallel) / 1000).toFixed(1)}초)`,
    );
    for (const r of chunkResults) usageList.push(r.usage);

    // 화자 정합: 청크 ≥ 2 인 경우만
    let mapping: Record<number, Record<string, string>> | null = null;
    if (chunkResults.length >= 2) {
      const reconciled = await reconcileSpeakers(chunkResults, onProgress);
      if (reconciled) {
        mapping = reconciled.mapping;
        usageList.push(reconciled.usage);
      }
    }

    onProgress?.('💾 결과 머지 + 두 버전 생성 중...');

    // 청크별: 실측 startSec 으로 타임스탬프 오프셋 → 화자 매핑 적용
    const merged = chunkResults
      .map((r) => {
        let body = offsetTimestamps(r.text, r.startSec);
        if (mapping?.[r.index]) {
          body = applySpeakerMapping(body, mapping[r.index]!);
        }
        return body.trim();
      })
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
