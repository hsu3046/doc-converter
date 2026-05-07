import path from 'node:path';
import { glob } from 'glob';
import chalk from 'chalk';
import ora from 'ora';
import { runOcrPipeline } from '../services/ocr-pipeline.js';
import { writeOutput, basename } from '../utils/file-io.js';
import type { OcrOptions, CostSummary } from '../types/index.js';

/** 비용 문자열 포맷 */
function formatCost(cost: CostSummary): string {
  const usd = cost.totalCostUsd.toFixed(5);
  const tokens = `입력 ${cost.totalInputTokens.toLocaleString()} / 출력 ${cost.totalOutputTokens.toLocaleString()}`;
  const breakdown = cost.breakdown
    .map((u, i) => `Pass${i + 1}: $${u.costUsd.toFixed(5)}`)
    .join(' + ');
  return `$${usd} (${breakdown}) | 토큰: ${tokens}`;
}

export async function ocrCommand(input: string, options: OcrOptions): Promise<void> {
  const files = await glob(input, { absolute: true, nodir: true });
  const supportedExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf'];
  const imageFiles = files.filter((f) => supportedExts.includes(path.extname(f).toLowerCase()));

  if (imageFiles.length === 0) {
    console.log(chalk.red('❌ 지원되는 이미지/PDF 파일을 찾을 수 없습니다.'));
    console.log(chalk.gray(`  지원 형식: ${supportedExts.join(', ')}`));
    return;
  }

  console.log(chalk.blue(`📄 ${imageFiles.length}개 파일 처리 시작`) +
    (options.quick ? chalk.yellow(' (빠른 모드)') : ''));

  for (const file of imageFiles) {
    const spinner = ora(`OCR 처리 중: ${path.basename(file)}`).start();
    try {
      const { markdown, cost } = await runOcrPipeline(file, options.quick);
      const outPath = path.join(options.output, `${basename(file)}.md`);
      await writeOutput(outPath, markdown);
      spinner.succeed(`✅ ${path.basename(file)} → ${outPath}`);
      console.log(chalk.cyan(`   💰 ${formatCost(cost)}`));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      spinner.fail(`❌ ${path.basename(file)}: ${msg}`);
    }
  }
  console.log(chalk.green('\n✨ OCR 처리 완료'));
}
