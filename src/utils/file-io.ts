import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 디렉토리가 없으면 재귀적으로 생성
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * 파일 쓰기 (출력 디렉토리 자동 생성)
 */
export async function writeOutput(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * 파일을 Buffer로 읽기
 */
export async function readFileBuffer(filePath: string): Promise<Buffer> {
  return fs.readFile(filePath);
}

/**
 * 파일 확장자에서 MIME type 추정
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    // 이미지
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    // PDF
    '.pdf': 'application/pdf',
    // 오디오
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.qta': 'audio/mp4',  // QuickTime Audio (macOS) — MPEG-4 컨테이너와 동일
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.wma': 'audio/x-ms-wma',
    '.amr': 'audio/amr',
    '.opus': 'audio/opus',
    // 비디오 (화면 녹화본, 동영상 녹취용 지원)
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.m4v': 'video/x-m4v',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}

/**
 * 파일명에서 확장자 제거
 */
export function basename(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}
