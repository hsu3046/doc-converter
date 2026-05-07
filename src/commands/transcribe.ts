import path from 'node:path';
import { glob } from 'glob';
import chalk from 'chalk';
import ora from 'ora';
import { runAudioPipeline } from '../services/audio-pipeline.js';
import { runMeetingNotesPipeline } from '../services/meeting-notes-pipeline.js';
import { writeOutput, basename } from '../utils/file-io.js';
import type { TranscribeOptions, CostSummary } from '../types/index.js';

function formatCost(cost: CostSummary): string {
  const usd = cost.totalCostUsd.toFixed(5);
  const tokens = `입력 ${cost.totalInputTokens.toLocaleString()} / 출력 ${cost.totalOutputTokens.toLocaleString()}`;
  return `$${usd} | 토큰: ${tokens}`;
}

export async function transcribeCommand(input: string, options: TranscribeOptions): Promise<void> {
  const files = await glob(input, { absolute: true, nodir: true });
  const supportedExts = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma'];
  const audioFiles = files.filter((f) => supportedExts.includes(path.extname(f).toLowerCase()));

  if (audioFiles.length === 0) {
    console.log(chalk.red('❌ 지원되는 오디오 파일을 찾을 수 없습니다.'));
    console.log(chalk.gray(`  지원 형식: ${supportedExts.join(', ')}`));
    return;
  }

  console.log(chalk.blue(`🎙️ ${audioFiles.length}개 파일 녹취 시작`));

  for (const file of audioFiles) {
    const spinner = ora(`녹취 중: ${path.basename(file)}`).start();
    try {
      const { timestamped, clean, cost } = await runAudioPipeline(file);
      const name = basename(file);
      const tsPath = path.join(options.output, `${name}_timestamped.md`);
      const cleanPath = path.join(options.output, `${name}_clean.md`);
      await writeOutput(tsPath, timestamped);
      await writeOutput(cleanPath, clean);
      spinner.succeed(`✅ ${path.basename(file)} → 2개 파일 생성`);
      console.log(chalk.gray(`   📋 ${tsPath}`));
      console.log(chalk.gray(`   📋 ${cleanPath}`));
      console.log(chalk.cyan(`   💰 ${formatCost(cost)}`));

      // --notes 옵션 → 미팅 노트 후속 생성
      if (options.notes) {
        const detail = options.notesDetail ?? 'standard';
        const provider = options.notesProvider ?? 'claude';
        const noteSpin = ora(
          `미팅 노트 생성 중 (템플릿: ${options.notes}, 상세도: ${detail}, 모델: ${provider})`,
        ).start();
        try {
          const noteResult = await runMeetingNotesPipeline(
            clean,
            options.notes,
            path.basename(file),
            undefined,
            detail,
            provider,
          );
          const notePath = path.join(options.output, `${name}_notes.md`);
          await writeOutput(notePath, noteResult.markdown);
          noteSpin.succeed(`✅ 미팅 노트 → ${path.basename(notePath)}`);
          console.log(chalk.gray(`   📋 ${notePath}`));
          console.log(chalk.gray(`   📑 템플릿: ${noteResult.templateName}`));
          console.log(chalk.cyan(`   💰 ${formatCost(noteResult.cost)}`));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          noteSpin.fail(`❌ 미팅 노트 실패: ${msg}`);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      spinner.fail(`❌ ${path.basename(file)}: ${msg}`);
    }
  }
  console.log(chalk.green('\n✨ 녹취 완료'));
}
