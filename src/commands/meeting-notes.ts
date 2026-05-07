import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import { runMeetingNotesPipeline } from '../services/meeting-notes-pipeline.js';
import { listTemplates } from '../services/template-loader.js';
import { writeOutput, basename } from '../utils/file-io.js';
import {
  DETAIL_LEVELS,
  DEFAULT_NOTES_PROVIDER,
  NOTES_PROVIDERS,
  type CostSummary,
  type DetailLevel,
  type NotesProvider,
} from '../types/index.js';

export interface MeetingNotesOptions {
  output: string;
  template: string;
  detail?: string;
  provider?: string;
  list?: boolean;
}

function normalizeDetail(input: string | undefined): DetailLevel {
  if (!input) return 'standard';
  const lower = input.toLowerCase();
  if ((DETAIL_LEVELS as string[]).includes(lower)) return lower as DetailLevel;
  throw new Error(
    `잘못된 상세도: ${input}. 허용값: ${DETAIL_LEVELS.join(', ')}`,
  );
}

function normalizeProvider(input: string | undefined): NotesProvider {
  if (!input) return DEFAULT_NOTES_PROVIDER;
  const lower = input.toLowerCase();
  if ((NOTES_PROVIDERS as string[]).includes(lower)) return lower as NotesProvider;
  throw new Error(
    `잘못된 provider: ${input}. 허용값: ${NOTES_PROVIDERS.join(', ')}`,
  );
}

function formatCost(cost: CostSummary): string {
  const usd = cost.totalCostUsd.toFixed(5);
  const tokens = `입력 ${cost.totalInputTokens.toLocaleString()} / 출력 ${cost.totalOutputTokens.toLocaleString()}`;
  return `$${usd} | 토큰: ${tokens}`;
}

export async function meetingNotesCommand(
  input: string | undefined,
  options: MeetingNotesOptions,
): Promise<void> {
  if (options.list) {
    const templates = await listTemplates();
    if (templates.length === 0) {
      console.log(chalk.yellow('등록된 템플릿이 없습니다.'));
      return;
    }
    console.log(chalk.blue(`\n📑 사용 가능한 템플릿 (${templates.length})\n`));
    for (const t of templates) {
      const tag = t.source === 'builtin' ? chalk.cyan('[builtin]') : chalk.green('[user]   ');
      console.log(`  ${tag} ${chalk.bold(t.id.padEnd(20))} ${t.name}`);
      if (t.description) console.log(chalk.gray(`              ${t.description}`));
    }
    console.log();
    return;
  }

  if (!input) {
    console.log(chalk.red('❌ 입력 파일이 필요합니다. (.md transcript)'));
    return;
  }

  const absInput = path.resolve(input);
  let transcript: string;
  try {
    transcript = await fs.readFile(absInput, 'utf-8');
  } catch (err) {
    console.log(chalk.red(`❌ 파일 읽기 실패: ${absInput}`));
    console.log(chalk.gray(err instanceof Error ? err.message : String(err)));
    return;
  }

  const sourceName = path.basename(absInput);
  let detailLevel: DetailLevel;
  let provider: NotesProvider;
  try {
    detailLevel = normalizeDetail(options.detail);
    provider = normalizeProvider(options.provider);
  } catch (err) {
    console.log(chalk.red(`❌ ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  const spinner = ora(
    `미팅 노트 생성 중 (템플릿: ${options.template}, 상세도: ${detailLevel}, 모델: ${provider})`,
  ).start();
  try {
    const { markdown, cost, templateName } = await runMeetingNotesPipeline(
      transcript,
      options.template,
      sourceName,
      undefined,
      detailLevel,
      provider,
    );
    const outName = `${basename(absInput)}_notes.md`;
    const outPath = path.join(options.output, outName);
    await writeOutput(outPath, markdown);
    spinner.succeed(`✅ ${sourceName} → ${outName}`);
    console.log(chalk.gray(`   📋 ${outPath}`));
    console.log(chalk.gray(`   📑 템플릿: ${templateName}`));
    console.log(chalk.cyan(`   💰 ${formatCost(cost)}`));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    spinner.fail(`❌ ${sourceName}: ${msg}`);
  }
}
