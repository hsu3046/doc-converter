import fs from 'node:fs/promises';
import type { ChatRow } from '../types/index.js';
import { buildFrontmatter, converterVersion, nowISO } from '../templates/evidence.js';
import path from 'node:path';

/**
 * 카카오톡 CSV 전용 커스텀 파서
 * csv-parse 라이브러리의 엄격한 따옴표 규칙(RFC-4180) 때문에 발생하는
 * 에러(Invalid Closing Quote 등)를 원천 차단하기 위해,
 * 날짜 정규식을 기반으로 원시 텍스트를 무식하게 잘라버리는 100% 방탄 파서입니다.
 */
export function parseChatCsv(content: string): ChatRow[] {
  const rows: ChatRow[] = [];
  
  // 줄바꿈 정규화 (Mac/Windows 호환)
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  // 카카오톡 타임스탬프 시그니처 (예: "2016-04-18 02:13:04,")
  const regex = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),/gm;
  
  let match;
  let lastIndex = 0;
  let lastDate = '';
  
  // 첫 번째 날짜 매칭 (헤더는 자연스럽게 스킵됨)
  const firstMatch = regex.exec(normalized);
  if (!firstMatch) {
    throw new Error('유효한 채팅 데이터(날짜 형식)를 찾을 수 없습니다.');
  }
  
  lastDate = firstMatch[1];
  lastIndex = regex.lastIndex;
  
  // 타임스탬프를 기준으로 청크(Chunk) 단위로 쪼개기
  while ((match = regex.exec(normalized)) !== null) {
    const chunk = normalized.substring(lastIndex, match.index);
    rows.push(parseKakaoChunk(lastDate, chunk));
    
    lastDate = match[1];
    lastIndex = regex.lastIndex;
  }
  
  // 마지막 청크 처리
  const lastChunk = normalized.substring(lastIndex);
  rows.push(parseKakaoChunk(lastDate, lastChunk));
  
  return rows;
}

function parseKakaoChunk(date: string, chunk: string): ChatRow {
  let text = chunk.trim();
  let user = '알 수 없음';
  let msg = text;

  // 카카오톡 일반 포맷: "이름","메시지내용"
  if (text.startsWith('"')) {
    const userEndStr = '","';
    const splitIndex = text.indexOf(userEndStr);
    
    if (splitIndex !== -1) {
      user = text.substring(1, splitIndex); // 첫 따옴표 제외
      msg = text.substring(splitIndex + userEndStr.length);
      
      // 맨 끝 따옴표 제거 (있을 경우)
      if (msg.endsWith('"')) {
        msg = msg.substring(0, msg.length - 1);
      }
      
      // 정상적으로 이스케이프 되었던 내부 따옴표("")를 다시 일반 따옴표(")로 복원
      msg = msg.replace(/""/g, '"');
      return { Date: date, User: user, Message: msg };
    }
  }

  // 예외 포맷 대비 (따옴표가 이상하게 찍혀있는 경우)
  const fallbackCommaResult = text.indexOf(',');
  if (fallbackCommaResult !== -1) {
    user = text.substring(0, fallbackCommaResult).replace(/^"|"$/g, '');
    msg = text.substring(fallbackCommaResult + 1).replace(/^"|"$/g, '');
  }

  return { Date: date, User: user, Message: msg };
}

/**
 * 인스타그램 DM 날짜 문자열 변환 (예: "5월 01, 2025 3:32 오전") -> YYYY-MM-DD HH:mm:ss
 */
function parseKoreanDate(dateStr: string): string {
  const match = dateStr.match(/(\d+)월 (\d+), (\d+) (\d+):(\d+) (오전|오후)/);
  if (!match) return dateStr;
  
  let [_, month, day, year, hour, minute, ampm] = match;
  
  let h = parseInt(hour, 10);
  if (ampm === '오후' && h < 12) h += 12;
  if (ampm === '오전' && h === 12) h = 0;
  
  const paddedMonth = month.padStart(2, '0');
  const paddedDay = day.padStart(2, '0');
  const paddedHour = h.toString().padStart(2, '0');
  
  return `${year}-${paddedMonth}-${paddedDay} ${paddedHour}:${minute}:00`;
}

/**
 * 인스타그램 DM HTML 파서
 * DOM 종속성 없이 정규식으로 안전하게 청크를 잘라 추출합니다.
 */
export function parseInstagramHtml(content: string): ChatRow[] {
  const rows: ChatRow[] = [];
  const blocks = content.split('<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder">');
  
  for(let i=1; i<blocks.length; i++) {
    const block = blocks[i];
    
    // 구조 의존적이지만 가장 안전한 빠른 파싱 수단
    const senderMatch = block.match(/<h2 class="_3-95 _2pim _a6-h _a6-i">([^<]+)<\/h2>/);
    const dateMatch = block.match(/<div class="_3-94 _a6-o">([^<]+)<\/div>/);
    const msgMatch = block.match(/<div class="_3-95 _a6-p">([\s\S]*?)<\/div>\s*<div class="_3-94 _a6-o">/);
    
    if (senderMatch && dateMatch && msgMatch) {
      const user = senderMatch[1].trim();
      const dateRaw = parseKoreanDate(dateMatch[1].trim()); // 변환 적용
      
      let msgHtml = msgMatch[1];
      msgHtml = msgHtml.replace(/<div[^>]*>/g, '\n'); 
      msgHtml = msgHtml.replace(/<br[^>]*>/g, '\n');
      msgHtml = msgHtml.replace(/<\/?[^>]+(>|$)/g, ' '); 
      let msg = msgHtml.replace(/[ \t]+/g, ' ').trim();
      
      rows.push({ Date: dateRaw, User: user, Message: msg });
    }
  }
  
  return rows;
}

/**
 * 날짜 문자열에서 YYYY-MM-DD 추출
 */
function extractDate(dateStr: string): string {
  if (!dateStr || typeof dateStr !== 'string') return '1970-01-01';
  // "2016-04-18 02:13:04" → "2016-04-18"
  return dateStr.split(' ')[0] ?? dateStr;
}

/**
 * 행들을 7일 단위로 그룹핑
 * (첫 메시지 날짜를 기준으로 +6일까지 하나의 그룹으로 묶음)
 */
export function groupBy7Days(rows: ChatRow[]): Map<string, ChatRow[]> {
  const groups = new Map<string, ChatRow[]>();
  
  if (rows.length === 0) return groups;

  let currentStartDateStr = extractDate(rows[0].Date);
  let currentStartDate = new Date(currentStartDateStr);
  let currentGroup: ChatRow[] = [];

  for (const row of rows) {
    const rowDateStr = extractDate(row.Date);
    const rowDate = new Date(rowDateStr);
    
    // 두 날짜 간의 일수 차이 계산
    const diffTime = rowDate.getTime() - currentStartDate.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24)); 
    
    // 7일 단위 (0~6일) 이내면 같은 그룹에 포함
    if (diffDays >= 0 && diffDays <= 6) {
      currentGroup.push(row);
    } else {
      // 그룹 저장 (시작 날짜를 키로 사용)
      groups.set(currentStartDateStr, currentGroup);
      
      // 새로운 7일 시작
      currentStartDateStr = rowDateStr;
      currentStartDate = rowDate;
      currentGroup = [row];
    }
  }
  
  // 마지막 그룹 저장
  if (currentGroup.length > 0) {
    groups.set(currentStartDateStr, currentGroup);
  }

  return groups;
}

/**
 * 날짜별 대화를 MD 문자열로 변환
 * 화자 + 메시지만 (시간 제외)
 */
export function formatChatDay(dateRaw: string, rows: ChatRow[], source: string): string {
  // 실제 파일에 기록될 때, 해당 파일에 담긴 실제 날짜 범위를 표시
  const firstDate = extractDate(rows[0].Date);
  const lastDate = extractDate(rows[rows.length - 1].Date);
  const dateRange = firstDate === lastDate ? firstDate : `${firstDate} ~ ${lastDate}`;

  const frontmatter = buildFrontmatter({
    type: 'chat-log',
    source,
    date: dateRange,
    processed: nowISO(),
    converter: converterVersion(),
  });

  // 해당 7일치 그룹 내에서 다시 '일자별'로 소분류
  const dailyGroups = new Map<string, ChatRow[]>();
  for (const row of rows) {
    const d = extractDate(row.Date);
    if (!dailyGroups.has(d)) dailyGroups.set(d, []);
    dailyGroups.get(d)!.push(row);
  }

  const blocks: string[] = [];
  for (const [dayStr, dayRows] of dailyGroups) {
    // YYYY-MM-DD -> YYYY.MM.DD 형식 변환
    const formattedDate = dayStr.replace(/-/g, '.');
    
    // 말풍선 레이아웃: **이름** : 메시지
    const msgs = dayRows.map((row) => `**${row.User}** : ${row.Message}`);
    
    // 서브헤더(##)와 메시지 본문 결합
    blocks.push(`## ${formattedDate}\n\n${msgs.join('\n\n')}`);
  }

  // 일자별 섹션을 '---' 수평선으로 구분
  const body = blocks.join('\n\n---\n\n');

  return `${frontmatter}\n\n${body}\n`;
}

/**
 * CSV → 날짜별 MD 파일 맵 생성
 * @returns Map<파일명, MD 내용>
 */
export async function processChatCsv(
  filePath: string,
  originalFileName?: string
): Promise<Map<string, string>> {
  const content = await fs.readFile(filePath, 'utf-8');
  let rows = parseChatCsv(content);
  
  // 유효하지 않은 CSV 행(헤더 매칭 실패 등) 필터링 (분할 에러 방지)
  rows = rows.filter(r => r && typeof r.Date === 'string' && r.Date.trim() !== '');

  if (rows.length === 0) {
    throw new Error('유효한 채팅 데이터(Date 컬럼)를 찾을 수 없습니다. CSV 양식을 확인해주세요.');
  }

  // 날짜 기반 최신 오름차순 정렬
  rows.sort((a, b) => new Date(extractDate(a.Date)).getTime() - new Date(extractDate(b.Date)).getTime());
  
  const groups = groupBy7Days(rows);
  const source = originalFileName ?? path.basename(filePath);

  const results = new Map<string, string>();
  for (const [startDate, dayRows] of groups) {
    // startDate부터 7일치를 묶은 파일명
    const fileName = `채팅기록_${startDate}.md`;
    results.set(fileName, formatChatDay(startDate, dayRows, source));
  }

  return results;
}

/**
 * Instagram HTML → 날짜별 MD 파일 맵 생성
 */
export async function processInstagramHtml(
  filePath: string,
  originalFileName?: string
): Promise<Map<string, string>> {
  const content = await fs.readFile(filePath, 'utf-8');
  let rows = parseInstagramHtml(content);
  
  // 유효하지 않은 데이터 필터링
  rows = rows.filter(r => r && typeof r.Date === 'string' && r.Date.trim() !== '');

  if (rows.length === 0) {
    throw new Error('유효한 Instagram 채팅 데이터를 찾을 수 없습니다. DM 메세지 구조를 확인해주세요.');
  }

  // 날짜 기반 최신 오름차순 정렬
  rows.sort((a, b) => new Date(extractDate(a.Date)).getTime() - new Date(extractDate(b.Date)).getTime());
  
  const groups = groupBy7Days(rows);
  const source = originalFileName ?? path.basename(filePath);

  const results = new Map<string, string>();
  for (const [startDate, dayRows] of groups) {
    const fileName = `인스타DM_${startDate}.md`;
    results.set(fileName, formatChatDay(startDate, dayRows, source));
  }

  return results;
}
