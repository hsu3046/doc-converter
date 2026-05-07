import type { EvidenceMeta } from '../types/index.js';

/**
 * frontmatter YAML 문자열 생성 — 사용자 표시 우선, 한국어 라벨, 분 단위 KST.
 *
 * 출력 예시 (transcript):
 * ---
 * 원본 파일: 뚝섬로4길.m4a
 * 원본 날짜: 2026-05-06 15:00
 * 변환 날짜: 2026-05-07 17:02
 * ---
 *
 * type/converter 는 내부 분기/디버그용으로 보존되지만 frontmatter에 출력하지 않음.
 */
export function buildFrontmatter(meta: EvidenceMeta): string {
  const lines: string[] = [
    '---',
    `원본 파일: ${meta.source}`,
  ];
  if (meta.recordedAt !== undefined) lines.push(`원본 날짜: ${meta.recordedAt}`);
  if (meta.date !== undefined) lines.push(`날짜 범위: ${meta.date}`);
  if (meta.template !== undefined) lines.push(`템플릿: ${meta.template}`);
  lines.push(`변환 날짜: ${meta.processed}`);
  lines.push('---');
  return lines.join('\n');
}

/**
 * 증거자료 MD 파일 전체 생성 (제목 없음 — frontmatter로 충분)
 */
export function buildEvidenceMarkdown(
  meta: EvidenceMeta,
  _title: string,   // 하위 호환성 유지용, 실제 출력 안 함
  body: string
): string {
  const frontmatter = buildFrontmatter(meta);
  return `${frontmatter}\n\n${body}\n`;
}

/**
 * 분 단위 KST 시각 포맷터 — "YYYY-MM-DD HH:mm".
 * UTC Date 입력 → KST(UTC+9) 변환.
 */
export function formatKstMinute(date: Date = new Date()): string {
  const kstMs = date.getTime() + 9 * 60 * 60 * 1000;
  const k = new Date(kstMs);
  // UTC getter 사용 → 이미 +9 보정된 시각을 그대로 출력
  const yyyy = k.getUTCFullYear();
  const mm = String(k.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(k.getUTCDate()).padStart(2, '0');
  const hh = String(k.getUTCHours()).padStart(2, '0');
  const mi = String(k.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/** 호환성을 위해 유지 — 신규 코드는 formatKstMinute 사용 권장 */
export function nowISO(): string {
  return formatKstMinute(new Date());
}

/**
 * converter 버전 문자열
 */
export function converterVersion(): string {
  return 'doc-converter v1.0.0';
}
