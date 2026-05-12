import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { runVad, type SpeechSegment, type VadOptions } from './vad.js';

function unpackPath(p: string): string {
  return p.replace('app.asar/', 'app.asar.unpacked/');
}

const FFMPEG: string = unpackPath(ffmpegInstaller.path);

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

/** trimmed 음성의 한 구간 ↔ 원본 음성의 한 구간 */
export interface SegmentMap {
  trimmedStart: number;
  trimmedEnd: number;
  originalStart: number;
  originalEnd: number;
}

export interface TrimResult {
  /** 잘라낸 후의 mp3 파일 경로 (Gemini 에 보낼 입력) */
  trimmedPath: string;
  /** 원본 길이 (초) */
  originalDuration: number;
  /** 잘라낸 후 길이 (초) */
  trimmedDuration: number;
  /** trimmed ↔ original 매핑 — Gemini 응답 timestamp 역변환에 사용 */
  segmentMap: SegmentMap[];
  /** 청소용 — 처리 끝나면 cleanupTrimmed() 로 임시 디렉토리 삭제 */
  workDir: string;
}

export interface TrimOptions {
  /** trim 결과 저장 디렉토리. 미지정 시 input 옆에 임시 폴더 */
  outputDir?: string;
  /** VAD post-processing 파라미터. 미지정 시 vad.ts 기본값 */
  vadOptions?: VadOptions;
  /** 진행 콜백 */
  onProgress?: (step: string, detail?: string) => void;
}

/**
 * input audio 를 ffmpeg 로 16kHz mono PCM stream 으로 디코드해서 Int16Array 로 수집.
 */
async function decodeTo16kPcm(input: string): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, [
      '-i', input,
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      '-loglevel', 'error',
      '-',
    ]);
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => (stderr += c.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg PCM 디코드 실패 (exit ${code}): ${stderr}`));
      }
      const buf = Buffer.concat(chunks);
      // Int16Array view — slice 로 새 ArrayBuffer 복사해 alignment/오너쉽 안전
      const pcm = new Int16Array(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      );
      resolve(pcm);
    });
  });
}

/**
 * SpeechSegment[] 를 ffmpeg concat demuxer 의 list 파일로 변환.
 *
 * 이전엔 filter_complex 의 atrim + concat filter 를 사용했지만, segment 수가 수백 개를
 * 넘어가면 ffmpeg 가 그래프를 구축·실행하면서 O(n²) 에 가까운 처리 시간이 들었음
 * (2시간/444 segment 케이스에서 단일 코어 100% 로 10분+ 소요).
 *
 * concat demuxer 는 같은 input 을 여러 번 reference 하면서 inpoint/outpoint 로 빠르게
 * seek 하므로 filter graph 오버헤드가 거의 없다. 같은 결과를 30~60초 안에 처리.
 *
 * concat demuxer list format:
 *   ffconcat version 1.0
 *   file '/abs/path/to/input.qta'
 *   inpoint 3.2
 *   outpoint 47.8
 *   file '/abs/path/to/input.qta'
 *   inpoint 52.1
 *   outpoint 89.4
 *
 * 주의: ffmpeg concat demuxer 의 file 경로 escape 는 single-quote 안에서 ' → '\''
 *      로 변환. POSIX shell escape 와 동일 규칙.
 */
function buildConcatDemuxerList(inputPath: string, segments: SpeechSegment[]): string {
  const escaped = inputPath.replace(/'/g, `'\\''`);
  const lines = ['ffconcat version 1.0'];
  for (const s of segments) {
    lines.push(`file '${escaped}'`);
    lines.push(`inpoint ${s.startSec.toFixed(3)}`);
    lines.push(`outpoint ${s.endSec.toFixed(3)}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * VAD speech segments → 매핑 테이블.
 * trimmed 음성에서의 누적 시각과 원본 시각을 짝지어 둔다.
 */
function buildSegmentMap(segments: SpeechSegment[]): SegmentMap[] {
  const map: SegmentMap[] = [];
  let trimmedCursor = 0;
  for (const s of segments) {
    const duration = s.endSec - s.startSec;
    map.push({
      trimmedStart: trimmedCursor,
      trimmedEnd: trimmedCursor + duration,
      originalStart: s.startSec,
      originalEnd: s.endSec,
    });
    trimmedCursor += duration;
  }
  return map;
}

/**
 * input audio 의 무음/비음성 구간을 VAD 로 검출하고 잘라낸 mp3 + 매핑 테이블 생성.
 *
 * 흐름:
 *   1) ffmpeg 로 input 을 16kHz mono PCM 으로 디코드 (메모리)
 *   2) Silero VAD 추론 → speech segment 리스트 (원본 시각)
 *   3) ffmpeg concat filter 로 segment 만 이어 붙인 mp3 생성
 *   4) trimmed ↔ original 매핑 테이블 반환
 *
 * 호출자는 처리 끝나면 cleanupTrimmed(result) 로 임시 폴더 삭제.
 */
export async function trimSilence(
  inputPath: string,
  opts: TrimOptions = {},
): Promise<TrimResult> {
  const { vadOptions, onProgress } = opts;

  // 임시 작업 디렉토리
  const workDir =
    opts.outputDir ??
    path.join(path.dirname(inputPath), `vad_trim_${crypto.randomUUID().slice(0, 8)}`);
  await fs.mkdir(workDir, { recursive: true });

  // 1) PCM 디코드
  onProgress?.('🔊 오디오 분석 준비 중');
  const pcm = await decodeTo16kPcm(inputPath);
  const originalDuration = pcm.length / 16000;
  onProgress?.(`✅ 준비 완료 (총 ${fmtDuration(originalDuration)})`);

  // 2) VAD 추론
  onProgress?.('🧠 대화 구간 찾는 중...');
  const segments = await runVad(pcm, vadOptions);

  if (segments.length === 0) {
    // 화자 발화 검출 실패 — 안전하게 원본 사용 (잘못된 trim 방지)
    onProgress?.(
      '⚠️ 대화 구간을 찾지 못해 정리 건너뜀',
      '원본 그대로 진행합니다',
    );
    return {
      trimmedPath: inputPath,
      originalDuration,
      trimmedDuration: originalDuration,
      segmentMap: [{
        trimmedStart: 0,
        trimmedEnd: originalDuration,
        originalStart: 0,
        originalEnd: originalDuration,
      }],
      workDir,
    };
  }

  const totalSpeech = segments.reduce((sum, s) => sum + (s.endSec - s.startSec), 0);
  const ratio = (totalSpeech / originalDuration) * 100;
  onProgress?.(
    `📒 대화 ${segments.length}곳 발견`,
    `총 ${fmtDuration(totalSpeech)} (원본의 ${ratio.toFixed(0)}%)`,
  );

  // 3) ffmpeg concat demuxer 로 trimmed mp3 생성
  onProgress?.('✂️ 무음 잘라낸 파일 만드는 중...');
  const tTrim = Date.now();
  const trimmedPath = path.join(workDir, 'trimmed.mp3');
  const listScript = buildConcatDemuxerList(inputPath, segments);
  const listPath = path.join(workDir, 'concat.txt');
  await fs.writeFile(listPath, listScript, 'utf8');

  // spawn 으로 직접 호출 — execAsync 는 ffmpeg 가 stderr 를 많이 내뱉으면
  // child_process 의 buffer 이슈로 close 이벤트가 안 와서 hang 할 수 있음.
  // stderr 는 drain 하면서 error 메시지용으로만 보관.
  //
  // concat demuxer (`-f concat -safe 0`) 는 같은 input 을 여러 번 reference 하면서
  // inpoint/outpoint 로 빠른 seek — filter graph O(n²) 함정 회피.
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(FFMPEG, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-acodec', 'libmp3lame',
      '-b:a', '128k',
      '-loglevel', 'error',
      trimmedPath,
    ]);
    let stderr = '';
    const STDERR_MAX = 64 * 1024;
    proc.stdout.on('data', () => { /* drain — backpressure 방지 */ });
    proc.stderr.on('data', (c) => {
      if (stderr.length < STDERR_MAX) stderr += c.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg concat 실패 (exit ${code}): ${stderr.trim()}`));
    });
  });

  // 4) 매핑 테이블 + trimmed 길이
  const segmentMap = buildSegmentMap(segments);
  const trimmedDuration = segmentMap[segmentMap.length - 1]!.trimmedEnd;
  const saved = originalDuration - trimmedDuration;
  onProgress?.(
    `✅ 정리 완료 — ${fmtDuration(originalDuration)} → ${fmtDuration(trimmedDuration)}`,
    `${fmtDuration(saved)} 절약 (${((Date.now() - tTrim) / 1000).toFixed(0)}초 소요)`,
  );

  return {
    trimmedPath,
    originalDuration,
    trimmedDuration,
    segmentMap,
    workDir,
  };
}

/**
 * trimmed 음성의 시각 (예: Gemini 응답의 [00:14:23]) 을 원본 시각으로 변환.
 *
 * 매핑 테이블의 segment 들은 trimmed 시간 축에서 연속 (gap 없음). 이진탐색 가능하지만
 * 회의 녹음 segment 수는 보통 수십~수백 개라 선형 탐색으로 충분.
 */
export function trimmedToOriginal(trimmedSec: number, map: SegmentMap[]): number {
  if (map.length === 0) return trimmedSec;
  for (const m of map) {
    if (trimmedSec >= m.trimmedStart && trimmedSec <= m.trimmedEnd) {
      return m.originalStart + (trimmedSec - m.trimmedStart);
    }
  }
  // trimmed 범위 밖 — 마지막 segment 의 원본 끝 시각으로 clamp
  const last = map[map.length - 1]!;
  if (trimmedSec > last.trimmedEnd) return last.originalEnd;
  return trimmedSec;
}

/**
 * trim 결과 임시 폴더 통째 삭제.
 * trimmedPath === inputPath 인 경우 (segments 0 fallback) 는 noop — 원본 보호.
 */
export async function cleanupTrimmed(result: TrimResult): Promise<void> {
  if (result.trimmedPath === path.join(result.workDir, 'trimmed.mp3')) {
    await fs.rm(result.workDir, { recursive: true, force: true }).catch(() => {});
  } else {
    // segments 0 fallback — workDir 만 정리 (filter.txt 등 없을 수도)
    await fs.rm(result.workDir, { recursive: true, force: true }).catch(() => {});
  }
}
