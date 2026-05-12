import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SAMPLE_RATE = 16000;
// Silero VAD v5: 16kHz 기준 윈도우 512 samples (= 32ms)
const WINDOW_SAMPLES = 512;

export interface SpeechSegment {
  /** 원본 오디오 기준 시작 시각 (초) */
  startSec: number;
  /** 원본 오디오 기준 끝 시각 (초) */
  endSec: number;
}

export interface VadOptions {
  /** speech 판정 확률 임계 (0~1). 기본 0.5 */
  threshold?: number;
  /** 이보다 짧은 speech 는 노이즈로 보고 버림 (ms). 기본 250 */
  minSpeechDurationMs?: number;
  /** 이보다 짧은 무음은 segment 안 호흡으로 보고 유지 (ms). 기본 1500 */
  minSilenceDurationMs?: number;
  /** segment 양끝에 추가할 여유 (ms). 단어 잘림 방지. 기본 200 */
  speechPadMs?: number;
  /** 인접 segment 간격이 이보다 좁으면 머지 (ms). 기본 500 */
  mergeGapMs?: number;
}

// asar 안에서 require 되면 path 가 'app.asar/.../...' — 실제 asset 은
// asarUnpack 으로 'app.asar.unpacked/' 에 있다. dev 모드는 무영향.
function unpackPath(p: string): string {
  return p.replace('app.asar/', 'app.asar.unpacked/');
}

/**
 * 모델 파일 경로 해석.
 * - dev (tsx, src/utils/vad.ts): __dirname = src/utils → ../../assets
 * - prod (compiled, dist/src/utils/vad.js): __dirname = dist/src/utils → ../../../assets
 * 두 후보 모두 시도해 존재하는 쪽 선택.
 */
function resolveModelPath(): string {
  const candidates = [
    path.resolve(__dirname, '../../assets/silero_vad.onnx'),
    path.resolve(__dirname, '../../../assets/silero_vad.onnx'),
  ];
  for (const c of candidates) {
    const unpacked = unpackPath(c);
    if (fs.existsSync(unpacked)) return unpacked;
  }
  throw new Error(
    `Silero VAD 모델 파일을 찾을 수 없습니다. 시도한 경로:\n  ${candidates.join('\n  ')}`,
  );
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    const modelPath = resolveModelPath();
    sessionPromise = ort.InferenceSession.create(modelPath);
  }
  return sessionPromise;
}

/**
 * Silero VAD 추론으로 화자 발화 segment 추출.
 *
 * @param pcm 16kHz mono 16-bit signed PCM (Int16Array)
 * @param opts post-processing 파라미터
 * @returns 원본 시각 기준 speech segment 리스트 (startSec 오름차순)
 */
export async function runVad(
  pcm: Int16Array,
  opts: VadOptions = {},
): Promise<SpeechSegment[]> {
  const {
    threshold = 0.5,
    minSpeechDurationMs = 250,
    minSilenceDurationMs = 1500,
    speechPadMs = 200,
    mergeGapMs = 500,
  } = opts;

  const sess = await getSession();

  // LSTM hidden state: [2, 1, 128]. 윈도우마다 carry over.
  let state = new Float32Array(2 * 1 * 128);
  const stateShape = [2, 1, 128];

  // sample rate 는 int64 tensor 로 매 호출에 전달
  const srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1]);

  // 윈도우별 speech 확률
  const probs: number[] = [];

  for (let i = 0; i + WINDOW_SAMPLES <= pcm.length; i += WINDOW_SAMPLES) {
    // Int16 → Float32 정규화 (-1 ~ 1)
    const windowFloat = new Float32Array(WINDOW_SAMPLES);
    for (let j = 0; j < WINDOW_SAMPLES; j++) {
      windowFloat[j] = pcm[i + j]! / 32768;
    }

    const inputTensor = new ort.Tensor('float32', windowFloat, [1, WINDOW_SAMPLES]);
    const stateTensor = new ort.Tensor('float32', state, stateShape);

    const output = await sess.run({
      input: inputTensor,
      state: stateTensor,
      sr: srTensor,
    });

    const outData = output.output!.data as Float32Array;
    probs.push(outData[0]!);
    // state 를 새 Float32Array<ArrayBuffer> 로 복사 — onnxruntime 의 ArrayBufferLike 와
    // 우리 변수 타입(ArrayBuffer)을 맞추기 위해. 256 floats 라 부담 없음.
    state = new Float32Array(output.stateN!.data as Float32Array);
  }

  return postProcess(probs, {
    threshold,
    minSpeechSamples: (minSpeechDurationMs / 1000) * SAMPLE_RATE,
    minSilenceSamples: (minSilenceDurationMs / 1000) * SAMPLE_RATE,
    speechPadSamples: (speechPadMs / 1000) * SAMPLE_RATE,
    mergeGapSamples: (mergeGapMs / 1000) * SAMPLE_RATE,
    totalSamples: pcm.length,
  });
}

interface PostProcessConfig {
  threshold: number;
  minSpeechSamples: number;
  minSilenceSamples: number;
  speechPadSamples: number;
  mergeGapSamples: number;
  totalSamples: number;
}

function postProcess(probs: number[], cfg: PostProcessConfig): SpeechSegment[] {
  type Seg = { start: number; end: number };
  const raw: Seg[] = [];

  let triggered = false;
  let segStart = 0;
  let lastSpeechEnd = 0;
  let silenceCount = 0;

  for (let w = 0; w < probs.length; w++) {
    const samplePos = w * WINDOW_SAMPLES;
    const isSpeech = probs[w]! >= cfg.threshold;

    if (isSpeech && !triggered) {
      triggered = true;
      segStart = samplePos;
      lastSpeechEnd = samplePos + WINDOW_SAMPLES;
      silenceCount = 0;
    } else if (isSpeech && triggered) {
      lastSpeechEnd = samplePos + WINDOW_SAMPLES;
      silenceCount = 0;
    } else if (!isSpeech && triggered) {
      silenceCount += WINDOW_SAMPLES;
      if (silenceCount >= cfg.minSilenceSamples) {
        if (lastSpeechEnd - segStart >= cfg.minSpeechSamples) {
          raw.push({ start: segStart, end: lastSpeechEnd });
        }
        triggered = false;
        silenceCount = 0;
      }
    }
  }
  // tail segment 마감
  if (triggered && lastSpeechEnd - segStart >= cfg.minSpeechSamples) {
    raw.push({ start: segStart, end: lastSpeechEnd });
  }

  // speech pad — 양끝에 여유. 인접 segment 의 경계는 침범 안 함.
  const padded: Seg[] = raw.map((s, idx) => {
    const prevEnd = idx > 0 ? raw[idx - 1]!.end : 0;
    const nextStart = idx < raw.length - 1 ? raw[idx + 1]!.start : cfg.totalSamples;
    return {
      start: Math.max(prevEnd, s.start - cfg.speechPadSamples),
      end: Math.min(nextStart, s.end + cfg.speechPadSamples),
    };
  });

  // merge — pad 적용 후 가까워진 segment 합침
  const merged: Seg[] = [];
  for (const s of padded) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end <= cfg.mergeGapSamples) {
      last.end = s.end;
    } else {
      merged.push({ ...s });
    }
  }

  return merged.map((s) => ({
    startSec: s.start / SAMPLE_RATE,
    endSec: s.end / SAMPLE_RATE,
  }));
}
