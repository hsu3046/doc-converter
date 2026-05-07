import path from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import { processChatCsv, processInstagramHtml } from '../services/chat-processor.js';
import { writeOutput } from '../utils/file-io.js';
import type { ChatSplitOptions } from '../types/index.js';

/**
 * Chat-split 명령 핸들러
 * CSV 채팅 로그를 날짜별 MD 파일로 분할
 */
export async function chatSplitCommand(
  input: string,
  options: ChatSplitOptions
): Promise<void> {
  const spinner = ora(`CSV 파싱 중: ${path.basename(input)}`).start();

  try {
    const ext = path.extname(input).toLowerCase();
    let results;
    if (ext === '.html') {
      results = await processInstagramHtml(input);
    } else {
      results = await processChatCsv(input);
    }

    spinner.succeed(`📊 ${results.size}개 날짜로 분할`);

    let count = 0;
    for (const [fileName, content] of results) {
      const outPath = path.join(options.output, fileName);
      await writeOutput(outPath, content);
      count++;
    }

    console.log(chalk.green(`\n✨ ${count}개 MD 파일 생성 완료 → ${options.output}`));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    spinner.fail(`❌ 처리 실패: ${msg}`);
  }
}
