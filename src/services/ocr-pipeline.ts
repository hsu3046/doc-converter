import path from 'node:path';
import fs from 'node:fs/promises'; // Added fs import
import { generateText, generateTextWithFileApi } from './gemini.js';
import { readFileBuffer, getMimeType, basename } from '../utils/file-io.js';
import { buildEvidenceMarkdown, nowISO, converterVersion } from '../templates/evidence.js';
import { MODELS, type CostSummary } from '../types/index.js'; // Corrected MODELS import
import { extractPdfToImages, cleanupExtractedImages } from '../utils/pdf-extractor.js'; // Added pdf-extractor imports

/** OCR 파이프라인 결과 */
export interface OcrResult {
  markdown: string;
  cost: CostSummary;
}

/** 진행상황 콜백 타입 */
export type ProgressCallback = (step: string, detail?: string) => void;

const PDF_EXT = '.pdf';

/**
 * gemini image 모델이 지원하는 MIME 타입
 * 이 외 형식은 텍스트 멀티모달 모델(PDF_FAST)로 폴백
 */
const SUPPORTED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

// Removed isPdf function as it's replaced by direct extension check

// Removed imageExtractRaw, imageEnhance, pdfExtractRaw, pdfEnhance functions
// Their logic is now integrated into runOcrPipeline

// ─── 페이지 검증 헬퍼 ───────────────────────────────────

/**
 * OCR 결과에서 '---' 구분자 수로 처리된 페이지 수를 추정
 */
function logPageCount(text: string, passLabel: string, onProgress?: ProgressCallback): void {
  const separatorCount = (text.match(/^---$/mg) ?? []).length;
  const estimatedPages = separatorCount + 1;
  if (separatorCount === 0) {
    onProgress?.(
      `⚠️  ${passLabel}: 페이지 구분자(---) 없음`,
      '1페이지만 처리됐을 수 있습니다. 원본 PDF 페이지 수를 확인해주세요.'
    );
  } else {
    onProgress?.(
      `📊 ${passLabel}: ${estimatedPages}페이지 감지 (구분자 ${separatorCount}개)`,
      `총 ${text.length.toLocaleString()}자`
    );
  }
}

// ─── 공통 파이프라인 ──────────────────────────────────────

export async function runOcrPipeline(
  filePath: string,
  quick = false,
  originalName?: string,
  onProgress?: ProgressCallback
): Promise<OcrResult> {
  const fileName = originalName ?? path.basename(filePath);
  const usageList = [];
  const ext = path.extname(filePath).toLowerCase(); // Added ext variable
  const pdf = ext === PDF_EXT; // Updated pdf check
  const fileType = pdf ? 'PDF' : '이미지';
  const totalPasses = quick ? 1 : 2;

  onProgress?.(`📤 파일 수신 완료 — ${fileName}`, `형식: ${fileType} | ${totalPasses}-Pass 모드`);

  // ─── Pass 1: Extract ────────────────────────────────────────────────────────────────
  let rawText = '';
  let input1 = 0; let output1 = 0; let cost1 = 0;

  const pass1Prompt = pdf
    ? `이 PDF의 모든 페이지에서 손글씨 텍스트를 추출해주세요.

## 규칙:
- 모든 페이지를 순서대로 처리해주세요.
- 페이지 구분은 "---" (수평선)으로 표시해주세요.
- 손글씨 한글을 최대한 정확히 인식해주세요.
- 인식이 불확실한 글자는 [?]로 표시해주세요.
- **단락 사이에 빈 줄(\\n\\n)** 을 반드시 넣어주세요.
- 한 문장/줄이 끝나면 새 줄에서 시작해주세요.
- 텍스트만 출력하세요. 추가 설명은 포함하지 마세요.`
    : `이 이미지에서 손글씨 텍스트를 추출해주세요.

## 규칙:
- 손글씨 한글을 최대한 정확히 인식해주세요.
- 인식이 불확실한 글자는 [?]로 표시해주세요.
- 반드시 **단락 사이에 빈 줄(\\n\\n)** 을 넣어주세요.
- 한 문장/줄이 끝나면 새 줄에서 시작해주세요.
- 텍스트만 출력하세요. 설명, 제목, 코드 블록은 포함하지 마세요.`;

  // PDF인 경우 먼저 File API(네이티브 처리)를 시도
  if (pdf) {
    const pass1Label = `🔍 Pass 1/${totalPasses} — 전체 페이지 텍스트 추출 중...`;
    onProgress?.(pass1Label, MODELS.OCR_FAST);
    const t1 = Date.now(); // Moved t1 here

    try {
      const { text, usage } = await generateTextWithFileApi( // Changed to destructure usage
        MODELS.OCR_FAST,
        pass1Prompt, // Use pass1Prompt
        filePath,
        'application/pdf',
        (msg) => onProgress?.(pass1Label + `\n   ${msg}`)
        // UI에 너무 많은 메시지가 갈 경우를 대비해 필요시 로깅만
      );
      rawText = text;
      input1 = usage.inputTokens;
      output1 = usage.outputTokens;
      cost1 = usage.costUsd;
      usageList.push(usage); // Push usage to list
      onProgress?.(`✅ Pass 1 완료 (${((Date.now() - t1) / 1000).toFixed(1)}초)`, `${usage.inputTokens.toLocaleString()} 토큰 입력`);
      logPageCount(rawText, 'Pass 1', onProgress); // Log page count for rawText
    } catch (err: any) {
      if (err.message?.includes('INVALID_ARGUMENT')) {
        onProgress?.(`⚠️ Gemini 기본 처리 한계 초과. 로컬 분할 변환(Fallback)으로 재시도 중...`, MODELS.OCR_FAST);

        // ─── Fallback: Local PDF Rasterization ──────────
        let fallbackImages: string[] = [];
        try {
          fallbackImages = await extractPdfToImages(filePath);
          onProgress?.(`✅ 로컬 변환 완료 (${fallbackImages.length}장). 텍스트 추출 시작...`, MODELS.OCR_FAST);

          const imageDatas: { mimeType: string; data: string }[] = [];
          for (const imgPath of fallbackImages) {
            const buf = await fs.readFile(imgPath);
            imageDatas.push({
              data: buf.toString('base64'),
              mimeType: 'image/png'
            });
          }

          const { text, usage } = await generateText( 
            MODELS.OCR_FAST,
            pass1Prompt, 
            imageDatas
          );
          rawText = text;
          input1 = usage.inputTokens;
          output1 = usage.outputTokens;
          cost1 = usage.costUsd;
          usageList.push(usage); // Push usage to list
          onProgress?.(`✅ Pass 1 완료 (${((Date.now() - t1) / 1000).toFixed(1)}초)`, `${usage.inputTokens.toLocaleString()} 토큰 입력`);
          logPageCount(rawText, 'Pass 1', onProgress); // Log page count for rawText
        } finally {
          await cleanupExtractedImages(fallbackImages);
        }
      } else {
        throw err;
      }
    }
  } else {
    // 일반 이미지
    const pass1Label = `🔍 Pass 1/${totalPasses} — 텍스트 추출 중...`;
    onProgress?.(pass1Label, MODELS.OCR_FAST);
    const t1 = Date.now(); // Moved t1 here

    const buffer = await readFileBuffer(filePath);
    const mimeType = getMimeType(filePath); // Define mimeType
    const base64 = buffer.toString('base64');

    // 지원되지 않는 MIME 타입은 텍스트 모델로 폴백 (original logic)
    // const model = SUPPORTED_IMAGE_MIMES.has(mimeType) ? MODELS.OCR_FAST : MODELS.OCR_FAST; // This line is redundant, always OCR_FAST
    if (!SUPPORTED_IMAGE_MIMES.has(mimeType)) {
      console.warn(`[OCR] 이미지 모델 미지원 MIME(${mimeType}) → ${MODELS.OCR_FAST} 폴백`);
    }

    const { text, usage } = await generateText( // Changed to destructure usage
      MODELS.OCR_FAST, // Always use OCR_FAST for raw extraction
      pass1Prompt, // Use pass1Prompt
      { mimeType, data: base64 }
    );
    rawText = text;
    input1 = usage.inputTokens;
    output1 = usage.outputTokens;
    cost1 = usage.costUsd;
    usageList.push(usage); // Push usage to list
    onProgress?.(`✅ Pass 1 완료 (${((Date.now() - t1) / 1000).toFixed(1)}초)`, `${usage.inputTokens.toLocaleString()} 토큰 입력`);
  }

  // Pass 2
  let body = rawText; // Use rawText from Pass 1
  if (!quick) {
    const pass2Prompt = pdf
      ? `아래는 PDF에서 1차 OCR로 추출된 텍스트입니다.
원본 PDF를 직접 보고 다음을 수행해주세요:

## 1차 추출 텍스트:
${rawText}

## 작업:
1. 한글 맞춤법/문법 교정
2. [?] 부분을 문맥으로 추론하여 복원
3. 전체 내용을 Markdown으로 구조화
4. 페이지 구분("---")은 유지
5. 원본 의미 변경 금지

## 출력 형식 규칙:
- 단락 사이에 반드시 빈 줄(\\n\\n)을 삽입
- 목록 항목은 각각 새 줄로 작성
- 코드 블록(백틱)으로 감싸지 말 것
- Markdown 본문만 출력`
      : `아래는 손글씨 이미지에서 1차 OCR로 추출된 텍스트입니다.
원본 이미지를 직접 보고 다음을 수행해주세요:

## 1차 추출 텍스트:
${rawText}

## 작업:
1. 한글 맞춤법/문법 교정
2. [?] 부분을 문맥으로 추론하여 복원
3. Markdown으로 구조화 (제목, 본문, 목록 등 적절히 사용)
4. 원본 의미 변경 금지

## 출력 형식 규칙:
- 단락 사이에 반드시 빈 줄(\\n\\n)을 삽입
- 목록 항목은 각각 새 줄에 작성
- 코드 블록(백틱)으로 감싸지 말 것
- Markdown 본문만 출력`;

    onProgress?.(
      `🧠 Pass 2/${totalPasses} — 문맥 보강 + Markdown 구조화 중...`,
      pdf ? MODELS.OCR_ENHANCE : MODELS.OCR_ENHANCE
    );
    const t2 = Date.now();
    let text2 = '';
    
    if (pdf) {
      try {
        const { text, usage } = await generateTextWithFileApi(
          MODELS.OCR_ENHANCE,
          pass2Prompt,
          filePath,
          'application/pdf',
          onProgress
        );
        text2 = text;
        usageList.push(usage);
      } catch (err: any) {
        if (err.message?.includes('INVALID_ARGUMENT')) {
          onProgress?.(`⚠️ Pass 2: Gemini 기본 처리 한계 초과. 로컬 분할 변환(Fallback)으로 재시도 중...`, MODELS.OCR_ENHANCE);
          
          let fallbackImages: string[] = [];
          try {
            fallbackImages = await extractPdfToImages(filePath);
            
            const imageDatas: { mimeType: string; data: string }[] = [];
            for (const imgPath of fallbackImages) {
              const buf = await fs.readFile(imgPath);
              imageDatas.push({
                data: buf.toString('base64'),
                mimeType: 'image/png'
              });
            }

            const { text, usage } = await generateText( 
              MODELS.OCR_ENHANCE,
              pass2Prompt, 
              imageDatas
            );
            text2 = text;
            usageList.push(usage);
          } finally {
            await cleanupExtractedImages(fallbackImages);
          }
        } else {
          throw err;
        }
      }
    } else {
      const buffer = await readFileBuffer(filePath);
      const mimeType = getMimeType(filePath);
      const base64 = buffer.toString('base64');
      const { text, usage } = await generateText(
        MODELS.OCR_ENHANCE,
        pass2Prompt,
        { mimeType, data: base64 }
      );
      text2 = text;
      usageList.push(usage);
    }
    
    body = text2;
    onProgress?.(`✅ Pass 2 완료 (${((Date.now() - t2) / 1000).toFixed(1)}초)`, `${usageList[usageList.length-1].inputTokens.toLocaleString()} 토큰 입력`);
    if (pdf) logPageCount(body, 'Pass 2', onProgress);
  }

  onProgress?.('💾 Markdown 저장 중...');

  const markdown = buildEvidenceMarkdown(
    {
      type: 'ocr',
      source: fileName,
      processed: nowISO(),
      converter: converterVersion(),
    },
    `OCR: ${basename(fileName)}`,
    body
  );

  const cost: CostSummary = {
    totalCostUsd: usageList.reduce((s, u) => s + u.costUsd, 0),
    totalInputTokens: usageList.reduce((s, u) => s + u.inputTokens, 0),
    totalOutputTokens: usageList.reduce((s, u) => s + u.outputTokens, 0),
    breakdown: usageList,
  };

  return { markdown, cost };
}
