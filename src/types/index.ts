/** 증거자료 유형 */
export type EvidenceType = 'ocr' | 'transcript' | 'chat-log' | 'meeting-note';

/** 증거자료 frontmatter 데이터.
 * 사용자 표시용 frontmatter는 한국어 라벨 + 분 단위 KST 시각.
 * type/converter 는 내부 분기/디버그용으로 보존되지만 frontmatter 에 출력 X.
 */
export interface EvidenceMeta {
  type: EvidenceType;
  source: string;
  /** 변환 시각 (KST, 분 단위 — "YYYY-MM-DD HH:mm") */
  processed: string;
  converter: string;
  /** transcript 전용: 원본 녹음 시각 (KST, 분 단위 — "YYYY-MM-DD HH:mm"). 메타데이터 없으면 undefined */
  recordedAt?: string;
  /** chat-log 전용: 날짜 범위 (YYYY-MM-DD 또는 YYYY-MM-DD ~ YYYY-MM-DD) */
  date?: string;
  /** meeting-note 전용: 사용된 템플릿 이름 */
  template?: string;
}

/** OCR 옵션 */
export interface OcrOptions {
  output: string;
  quick?: boolean;
}

/** 미팅 노트 상세도 — 동일 transcript 에 대해 출력 길이/디테일 조절 */
export type DetailLevel = 'concise' | 'standard' | 'detailed' | 'verbatim';

export const DETAIL_LEVELS: DetailLevel[] = ['concise', 'standard', 'detailed', 'verbatim'];

/** 미팅 노트 생성 LLM provider */
export type NotesProvider = 'claude' | 'gemini';

export const NOTES_PROVIDERS: NotesProvider[] = ['claude', 'gemini'];

export const DEFAULT_NOTES_PROVIDER: NotesProvider = 'claude';

/** 음성 녹취록 옵션 */
export interface TranscribeOptions {
  output: string;
  /** 녹취 후 후속으로 생성할 미팅 노트 템플릿 (id 또는 .md 경로) */
  notes?: string;
  /** 미팅 노트 상세도 (notes 옵션과 함께 사용) */
  notesDetail?: DetailLevel;
  /** 미팅 노트 LLM provider (notes 옵션과 함께 사용) */
  notesProvider?: NotesProvider;
  /** VAD 로 STT 전 무음 구간 자동 제거 (입력 시간 절감). 기본 false */
  trimSilence?: boolean;
}

/** 채팅 로그 분할 옵션 */
export interface ChatSplitOptions {
  output: string;
}

/** CSV 채팅 로그 행 */
export interface ChatRow {
  Date: string;
  User: string;
  Message: string;
}

/** Gemini 모델 이름 상수 */
export const MODELS = {
  // 이미지 OCR (PNG/JPEG/WebP) + PDF via File API — 확인된 모델
  OCR_FAST:    'gemini-3.1-flash-image-preview',
  OCR_ENHANCE: 'gemini-3-pro-image-preview',
  // 오디오
  AUDIO: 'gemini-3-flash-preview',
  // 미팅 노트 생성 (텍스트 입력/출력) — pro 급 추론
  NOTES: 'gemini-3.1-pro-preview',
  // Claude — 미팅 노트 생성 대안
  NOTES_CLAUDE: 'claude-sonnet-4-6',
} as const;

// ─── 비용 추적 ────────────────────────────────────────────

/** 모델별 단가 (USD per 1M tokens) */
export const PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'gemini-3.1-flash-image-preview': { inputPerM: 0.25,  outputPerM: 1.50  },
  'gemini-3-pro-image-preview':     { inputPerM: 2.00,  outputPerM: 12.00 },
  'gemini-3.1-pro-preview':         { inputPerM: 2.00,  outputPerM: 12.00 },
  'gemini-3-flash-preview':         { inputPerM: 0.50,  outputPerM: 3.00  },
  // Anthropic Claude
  'claude-sonnet-4-6':              { inputPerM: 3.00,  outputPerM: 15.00 },
};


/** 단일 API 호출 사용량 */
export interface UsageInfo {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** 기능별 최종 비용 요약 */
export interface CostSummary {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  breakdown: UsageInfo[];
}

/** generateText 반환값 */
export interface GenerateResult {
  text: string;
  usage: UsageInfo;
}
