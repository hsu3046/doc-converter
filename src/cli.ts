#!/usr/bin/env node

import { Command } from 'commander';
import { ocrCommand } from './commands/ocr.js';
import { transcribeCommand } from './commands/transcribe.js';
import { chatSplitCommand } from './commands/chat-split.js';
import { meetingNotesCommand } from './commands/meeting-notes.js';
import { startServer } from './ui/server.js';
import type { TranscribeOptions } from './types/index.js';

// .env.local 로드 (있으면)
import { readFile } from 'node:fs/promises';
try {
  const envContent = await readFile('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
} catch {
  // .env.local 없으면 무시
}

const program = new Command();

program
  .name('doc-converter')
  .description('사건 기록 변환 도구 — 손글씨 OCR, 음성 녹취록, 채팅 로그를 Markdown으로 변환')
  .version('1.0.0');

// 손글씨 OCR
program
  .command('ocr')
  .description('손글씨 이미지/PDF를 OCR로 텍스트 변환 → MD 저장')
  .argument('<input>', '이미지 파일 또는 glob 패턴 (예: ./scans/*.jpg)')
  .option('-o, --output <dir>', '출력 디렉토리', './output')
  .option('-q, --quick', 'Pass 1만 실행 (빠르지만 품질 낮음)', false)
  .action(async (input: string, options: { output: string; quick: boolean }) => {
    await ocrCommand(input, options);
  });

// 음성 녹취록
program
  .command('transcribe')
  .description('오디오 파일을 녹취록으로 변환 → 타임스탬프/클린 2개 MD 저장')
  .argument('<input>', '오디오 파일 또는 glob 패턴 (예: ./recordings/*.m4a)')
  .option('-o, --output <dir>', '출력 디렉토리', './output')
  .option('-n, --notes <template>', '녹취 후 미팅 노트도 생성 (템플릿 id 또는 .md 경로)')
  .option(
    '--notes-detail <level>',
    '미팅 노트 상세도 (concise | standard | detailed | verbatim)',
    'standard',
  )
  .option(
    '--notes-provider <name>',
    '미팅 노트 LLM provider (claude | gemini)',
    'claude',
  )
  .option(
    '--trim-silence',
    'VAD 로 무음/비음성 구간 잘라낸 뒤 STT (Gemini 입력 시간 절감)',
    false,
  )
  .action(
    async (
      input: string,
      options: {
        output: string;
        notes?: string;
        notesDetail?: string;
        notesProvider?: string;
        trimSilence?: boolean;
      },
    ) => {
      await transcribeCommand(input, {
        output: options.output,
        notes: options.notes,
        notesDetail: options.notesDetail as TranscribeOptions['notesDetail'],
        notesProvider: options.notesProvider as TranscribeOptions['notesProvider'],
        trimSilence: options.trimSilence ?? false,
      });
    },
  );

// 미팅 노트 생성
program
  .command('meeting-notes')
  .description('녹취록 .md → 템플릿 기반 미팅 노트 생성')
  .argument('[input]', '녹취록 .md 파일 경로 (--list 사용 시 생략)')
  .option('-o, --output <dir>', '출력 디렉토리', './output')
  .option('-t, --template <id>', '템플릿 id 또는 .md 파일 경로', 'general')
  .option(
    '-d, --detail <level>',
    '상세도 (concise | standard | detailed | verbatim)',
    'standard',
  )
  .option(
    '-p, --provider <name>',
    'LLM provider (claude | gemini)',
    'claude',
  )
  .option('--list', '사용 가능한 템플릿 목록만 출력', false)
  .action(
    async (
      input: string | undefined,
      options: {
        output: string;
        template: string;
        detail?: string;
        provider?: string;
        list?: boolean;
      },
    ) => {
      await meetingNotesCommand(input, options);
    },
  );

// 채팅 로그 분할
program
  .command('chat-split')
  .description('CSV 채팅 로그를 날짜별 MD 파일로 분할')
  .argument('<input>', 'CSV 파일 경로')
  .option('-o, --output <dir>', '출력 디렉토리', './output')
  .action(async (input: string, options: { output: string }) => {
    await chatSplitCommand(input, options);
  });

// 웹 UI 서버
program
  .command('ui')
  .description('브라우저 UI 실행 (기본: localhost:3000)')
  .option('-p, --port <number>', '포트 번호', '3000')
  .action((options: { port: string }) => {
    startServer(parseInt(options.port, 10));
  });

program.parse();
