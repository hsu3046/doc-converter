import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
// @ts-expect-error - pdf-poppler 타입 미제공 (CJS 라이브러리)
import poppler from 'pdf-poppler';

/**
 * pdf-poppler 번들 binary 로 PDF를 낱장 PNG로 변환 (Fallback 용도).
 * 시스템 PATH 의존 X — Electron 패키징에서도 동작.
 *
 * @param pdfPath 원본 PDF 경로
 * @returns 추출된 PNG 파일 경로들의 배열 (처리 순서 보장)
 */
export async function extractPdfToImages(pdfPath: string): Promise<string[]> {
  const outDir = path.join(path.dirname(pdfPath), `pdf_fallback_${crypto.randomUUID().slice(0, 8)}`);
  await fs.mkdir(outDir, { recursive: true });

  // pdf-poppler convert: format=png, scale=1240 ≈ A4 150 DPI 너비 (기존 -r 150 와 유사)
  // out_prefix='page' → page-1.png, page-2.png ...
  try {
    await poppler.convert(pdfPath, {
      format: 'png',
      out_dir: outDir,
      out_prefix: 'page',
      scale: 1240,
    });

    const files = await fs.readdir(outDir);
    const pngFiles = files.filter((f) => f.startsWith('page-') && f.endsWith('.png'));
    pngFiles.sort((a, b) => {
      const matchA = a.match(/page-(\d+)\.png/);
      const matchB = b.match(/page-(\d+)\.png/);
      const numA = matchA ? parseInt(matchA[1]!, 10) : 0;
      const numB = matchB ? parseInt(matchB[1]!, 10) : 0;
      return numA - numB;
    });

    return pngFiles.map((f) => path.join(outDir, f));
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`PDF 로컬 변환 실패: ${msg}`);
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
