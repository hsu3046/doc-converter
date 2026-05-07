import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

const execAsync = promisify(exec);

export interface AudioChunk {
  chunkPath: string;
  startSec: number;
  index: number;
}

const CHUNK_SIZE_GUARD_MB = 150;

// 번들된 binary 절대경로 (시스템 PATH 의존 X — Electron 패키징에 안전)
const FFMPEG: string = ffmpegInstaller.path;
const FFPROBE: string = ffprobeInstaller.path;

/** shell command 안에 path 안전하게 quote (공백 포함 절대경로 대비) */
function q(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`;
}

/**
 * ffprobe로 원본 오디오의 녹음 시각 추출.
 * - m4a/mp4: format.tags.creation_time (대부분 UTC ISO)
 * - mp3 ID3v2: format.tags.date / TDRC
 * - wav BWF: format.tags.time_reference (있는 경우)
 * - flac: format.tags.DATE
 * 메타데이터가 없으면 undefined.
 */
export async function probeRecordingTime(filePath: string): Promise<Date | undefined> {
  try {
    const { stdout } = await execAsync(
      `${q(FFPROBE)} -v quiet -print_format json -show_format ${q(filePath)}`,
    );
    const json = JSON.parse(stdout) as { format?: { tags?: Record<string, string> } };
    const tags = json.format?.tags ?? {};
    // 대소문자 변형 모두 시도
    const candidates = [
      tags['creation_time'], tags['CREATION_TIME'],
      tags['date'], tags['DATE'],
      tags['TDRC'], tags['TDOR'],
      tags['recorded_date'],
    ].filter((v): v is string => typeof v === 'string' && v.length > 0);

    for (const raw of candidates) {
      // 일반적: "2026-05-06T15:00:00.000000Z" 또는 "2026-05-06 15:00:00" 또는 "2026"
      const d = new Date(raw);
      if (!isNaN(d.getTime())) return d;
    }
  } catch {
    // ffprobe 실패는 silent — 메타데이터 없는 것과 동일 처리
  }
  return undefined;
}

/**
 * ffprobe로 오디오 길이(초) 측정
 */
export async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execAsync(
    `${q(FFPROBE)} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${q(filePath)}`
  );
  const dur = parseFloat(stdout.trim());
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new Error(`오디오 길이를 측정할 수 없습니다: ${filePath}`);
  }
  return dur;
}

/**
 * 오디오를 시간 단위 청크로 분할.
 * - mp3/m4a/aac 등 컨테이너는 -c copy 로 빠른 분할 (재인코딩 없음)
 * - 청크 1개가 CHUNK_SIZE_GUARD_MB 초과 시 64kbps 다운샘플 재인코딩으로 폴백
 */
export async function splitAudioToChunks(
  filePath: string,
  chunkDurationSec: number
): Promise<AudioChunk[]> {
  const duration = await probeDuration(filePath);
  const numChunks = Math.ceil(duration / chunkDurationSec);

  const outDir = path.join(
    path.dirname(filePath),
    `audio_chunks_${crypto.randomUUID().slice(0, 8)}`
  );
  await fs.mkdir(outDir, { recursive: true });

  const chunks: AudioChunk[] = [];
  for (let i = 0; i < numChunks; i++) {
    const intendedStart = i * chunkDurationSec;
    const chunkPath = path.join(outDir, `chunk_${String(i).padStart(3, '0')}.mp3`);

    // -c copy 로 재인코딩 회피. 입력이 비-mp3 컨테이너면 ffmpeg가 자동으로 mp3 인코딩 폴백.
    // -c copy 가 실패하면 catch → 재인코딩 재시도.
    try {
      await execAsync(
        `${q(FFMPEG)} -y -ss ${intendedStart} -t ${chunkDurationSec} -i ${q(filePath)} -c copy -vn ${q(chunkPath)}`
      );
    } catch {
      await execAsync(
        `${q(FFMPEG)} -y -ss ${intendedStart} -t ${chunkDurationSec} -i ${q(filePath)} -vn -acodec libmp3lame -b:a 128k ${q(chunkPath)}`
      );
    }

    // 보조 용량 가드: 청크 1개가 150MB 초과 시 64kbps 다운샘플 재인코딩
    const stat = await fs.stat(chunkPath);
    if (stat.size > CHUNK_SIZE_GUARD_MB * 1024 * 1024) {
      await fs.unlink(chunkPath).catch(() => {});
      await execAsync(
        `${q(FFMPEG)} -y -ss ${intendedStart} -t ${chunkDurationSec} -i ${q(filePath)} -vn -acodec libmp3lame -b:a 64k ${q(chunkPath)}`
      );
    }

    // startSec 은 임시값(i*chunkDurationSec). 분할 후 ffprobe로 실측해 누적 보정.
    chunks.push({ chunkPath, startSec: intendedStart, index: i });
  }

  // 실측 길이로 누적 startSec 보정 — frame 정렬로 인한 누적 오차 제거
  const measuredDurations = await Promise.all(
    chunks.map((c) => probeDuration(c.chunkPath).catch(() => chunkDurationSec)),
  );
  let cumulative = 0;
  for (let i = 0; i < chunks.length; i++) {
    chunks[i]!.startSec = cumulative;
    cumulative += measuredDurations[i]!;
  }

  return chunks;
}

export async function cleanupChunks(chunks: AudioChunk[]): Promise<void> {
  if (chunks.length === 0) return;
  const dir = path.dirname(chunks[0]!.chunkPath);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
