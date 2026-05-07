import Anthropic from '@anthropic-ai/sdk';
import { calcCost } from './gemini.js';
import type { GenerateResult, UsageInfo } from '../types/index.js';

let client: Anthropic | null = null;

/**
 * Anthropic Claude API 클라이언트 (싱글턴).
 * CLAUDE_API_KEY 환경변수 (디폴트 ANTHROPIC_API_KEY 가 아님 — 명시 전달).
 */
export function getClient(): Anthropic {
  if (client) return client;

  const apiKey = process.env['CLAUDE_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'CLAUDE_API_KEY 환경변수가 설정되지 않았습니다.\n' +
        '.env.local 파일에 CLAUDE_API_KEY=your_key 형식으로 추가하세요.\n' +
        'API 키 발급: https://console.anthropic.com/settings/keys',
    );
  }

  client = new Anthropic({ apiKey });
  return client;
}

/**
 * Claude messages API 텍스트 호출.
 * SDK 자체에 default max_retries=2 — 429/5xx 자동 재시도 (gemini withRetry 와 동일 효과).
 */
export async function generateText(
  model: string,
  prompt: string,
  options?: { maxOutputTokens?: number; system?: string },
): Promise<GenerateResult> {
  const ai = getClient();
  const maxTokens = options?.maxOutputTokens ?? 16000;

  let response: Anthropic.Message;
  try {
    response = await ai.messages.create({
      model,
      max_tokens: maxTokens,
      ...(options?.system ? { system: options.system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    throw friendlyError(err);
  }

  // content 는 ContentBlock[] 디스크리미네이트 유니온 — text 블록만 합침
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const costUsd = calcCost(model, inputTokens, outputTokens);

  const usage: UsageInfo = { model, inputTokens, outputTokens, costUsd };
  return { text, usage };
}

function friendlyError(err: unknown): Error {
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Claude API 할당량이 초과되었습니다. 잠시 후 다시 시도해주세요.');
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('CLAUDE_API_KEY 가 잘못되었습니다. .env.local 을 확인하세요.');
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 503 || err.status === 529) {
      return new Error('Claude 서버가 일시 과부하 상태입니다. 잠시 후 다시 시도해주세요.');
    }
    return new Error(`Claude API 오류 (${err.status}): ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
