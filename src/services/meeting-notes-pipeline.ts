import { generateText as generateTextGemini } from './gemini.js';
import { generateText as generateTextClaude } from './anthropic.js';
import { buildEvidenceMarkdown, nowISO, converterVersion } from '../templates/evidence.js';
import {
  MODELS,
  DEFAULT_NOTES_PROVIDER,
  type CostSummary,
  type DetailLevel,
  type NotesProvider,
} from '../types/index.js';
import { getTemplate } from './template-loader.js';
import type { ProgressCallback } from './ocr-pipeline.js';

export interface MeetingNotesResult {
  markdown: string;
  cost: CostSummary;
  templateName: string;
}

const MIN_TRANSCRIPT_CHARS = 100;
const MAX_OUTPUT_TOKENS = 16384;

const DETAIL_INSTRUCTIONS: Record<DetailLevel, string> = {
  concise:
    '5~7줄 이내로 핵심만 압축. 세부 인용/설명 생략. 토픽이 많아도 묶어서 짧게.',
  standard:
    '템플릿 구조에 맞춰 균형 있게 작성. 각 섹션 평균 2~5문장. 핵심 발언은 간결한 요약.',
  detailed:
    '토픽별로 단락(3~6문장)으로 풍부하게 정리. 각 토픽에 핵심 발언 1~3개를 transcript 원문에 가깝게 인용(`> "발언"`). 숫자/고유명사/날짜는 그대로 보존.',
  verbatim:
    '주요 발언을 가능한 원문 그대로 적극 인용. 토픽별 5~10문장 + 인용 3개 이상. 미팅 시간 흐름이 살아있도록 작성.',
};

/**
 * frontmatter 가 붙은 transcript .md 라면 frontmatter 부분 제거.
 * 본문만 LLM 입력으로 사용.
 */
function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  return text.slice(end + 4).replace(/^\r?\n/, '');
}

export async function runMeetingNotesPipeline(
  transcriptText: string,
  templateIdOrPath: string,
  source: string,
  onProgress?: ProgressCallback,
  detailLevel: DetailLevel = 'standard',
  provider: NotesProvider = DEFAULT_NOTES_PROVIDER,
): Promise<MeetingNotesResult> {
  const body = stripFrontmatter(transcriptText).trim();
  if (body.length < MIN_TRANSCRIPT_CHARS) {
    throw new Error(
      `녹취록이 너무 짧습니다 (${body.length}자). 최소 ${MIN_TRANSCRIPT_CHARS}자 필요.`,
    );
  }

  onProgress?.('📑 템플릿 로딩 중...', templateIdOrPath);
  const template = await getTemplate(templateIdOrPath);
  onProgress?.(
    `✅ 템플릿: ${template.info.name} · 상세도: ${detailLevel} · 모델: ${provider}`,
    template.info.source === 'builtin' ? '기본' : '사용자 정의',
  );

  const detailInstruction = DETAIL_INSTRUCTIONS[detailLevel];

  const prompt = `## 미팅 녹취록
${body}

## 작업 지시 (템플릿)
${template.body}

## 상세도 지시 (${detailLevel})
${detailInstruction}

## 출력 규칙
- 위 템플릿 구조의 마크다운 본문만 출력 (frontmatter, 코드블록 감싸기 금지)
- 원본에 없는 내용은 만들지 마세요 (할루시네이션 금지)
- 단, 다음은 적극 보존: 화자명, 인물/회사/제품/서비스 고유명사, 숫자, 날짜, 기간, 금액
- 핵심 발언 인용은 transcript 원문에 가깝게 (의미 변경 X)
- 한국어로 작성`;

  const model = provider === 'claude' ? MODELS.NOTES_CLAUDE : MODELS.NOTES;
  onProgress?.('🧠 미팅 노트 생성 중...', `${model} · max ${MAX_OUTPUT_TOKENS} tok`);
  const t = Date.now();
  const result =
    provider === 'claude'
      ? await generateTextClaude(model, prompt, { maxOutputTokens: MAX_OUTPUT_TOKENS })
      : await generateTextGemini(model, prompt, undefined, { maxOutputTokens: MAX_OUTPUT_TOKENS });
  onProgress?.(
    `✅ 노트 생성 완료 (${((Date.now() - t) / 1000).toFixed(1)}초)`,
    `${result.usage.outputTokens.toLocaleString()} 토큰 출력`,
  );

  if (!result.text.trim()) {
    throw new Error('LLM 응답이 비어있습니다. 다시 시도해주세요.');
  }

  const markdown = buildEvidenceMarkdown(
    {
      type: 'meeting-note',
      source,
      processed: nowISO(),
      converter: converterVersion(),
      template: template.info.name,
    },
    `미팅 노트: ${source}`,
    result.text.trim(),
  );

  const cost: CostSummary = {
    totalCostUsd: result.usage.costUsd,
    totalInputTokens: result.usage.inputTokens,
    totalOutputTokens: result.usage.outputTokens,
    breakdown: [result.usage],
  };

  return { markdown, cost, templateName: template.info.name };
}
