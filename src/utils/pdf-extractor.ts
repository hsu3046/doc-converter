import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const execAsync = promisify(exec);

/**
 * pdftoppm을 이용해 PDF를 낱장 PNG로 변환합니다 (Fallback 용도).
 * @param pdfPath 원본 PDF 경로
 * @returns 추출된 PNG 파일 경로들의 배열 (처리 순서 보장)
 */
export async function extractPdfToImages(pdfPath: string): Promise<string[]> {
  try {
    // pdftoppm 설치 여부 확인
    await execAsync('which pdftoppm');
  } catch (err) {
    throw new Error('Local Fallback을 사용하려면 poppler가 설치되어 있어야 합니다. (brew install poppler)');
  }

  const outDir = path.join(path.dirname(pdfPath), `pdf_fallback_${crypto.randomUUID().slice(0,8)}`);
  await fs.mkdir(outDir, { recursive: true });

  const prefix = path.join(outDir, 'page');
  
  // -png: PNG 포맷
  // -r 150: 150 DPI (너무 고해상도면 API 또 거부됨)
  // -rx 150 -ry 150 도 쓸 수 있음
  try {
    // pdftoppm 실행
    await execAsync(`pdftoppm -png -r 150 "${pdfPath}" "${prefix}"`);

    // 생성된 파일 목록 읽기
    const files = await fs.readdir(outDir);
    const pngFiles = files.filter(f => f.startsWith('page-') && f.endsWith('.png'));
    
    // 번호 순 정렬 (page-1.png, page-2.png ...)
    pngFiles.sort((a, b) => {
      const matchA = a.match(/page-(\d+)\.png/);
      const matchB = b.match(/page-(\d+)\.png/);
      const numA = matchA ? parseInt(matchA[1], 10) : 0;
      const numB = matchB ? parseInt(matchB[1], 10) : 0;
      return numA - numB;
    });

    return pngFiles.map(f => path.join(outDir, f));
  } catch (error: any) {
    throw new Error(`PDF 로컬 변환 실패: ${error.message}`);
  }
}

/** 생성된 임시 폴더 삭제 */
export async function cleanupExtractedImages(imagePaths: string[]) {
  if (!imagePaths || imagePaths.length === 0) return;
  const dir = path.dirname(imagePaths[0]);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (e) {
    // ignore
  }
}
