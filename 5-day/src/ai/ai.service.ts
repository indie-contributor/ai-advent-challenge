import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { Message } from '../messages/message.entity';

export interface AiChatResult {
  choices: { content: string; finishReason: string }[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  cost: number;
  responseTimeMs: number;
  model: string;
}

const COST_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-5.2': { input: 1.75, output: 14 },
  'gpt-5.2-codex': { input: 1.75, output: 14 },
  'gpt-5.2-pro': { input: 21, output: 168 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'o1': { input: 15, output: 60 },
  'o1-mini': { input: 1.1, output: 4.4 },
  'o3': { input: 2, output: 8 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
};

@Injectable()
export class AiService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async chat(
    messages: Message[],
    params?: { stopSequence?: string[]; maxTokens?: number; n?: number; model?: string; temperature?: number },
    systemPrompt?: string,
  ): Promise<AiChatResult> {
    const model = params?.model ?? 'gpt-4o-mini';
    const systemMessage = systemPrompt
      ? [{ role: 'system' as const, content: systemPrompt }]
      : [];

    const startTime = Date.now();
    const response = await this.openai.chat.completions.create({
      model,
      messages: [
        ...systemMessage,
        ...messages.map((m) => ({ role: m.role, content: m.text })),
      ],
      ...(params?.stopSequence && { stop: params.stopSequence }),
      ...(params?.maxTokens && { max_tokens: params.maxTokens }),
      ...(params?.n && { n: params.n }),
      ...(params?.temperature !== undefined && { temperature: params.temperature }),
    });
    const responseTimeMs = Date.now() - startTime;

    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const completionTokens = response.usage?.completion_tokens ?? 0;
    const totalTokens = promptTokens + completionTokens;

    const pricing = COST_PER_1M_TOKENS[model] ?? COST_PER_1M_TOKENS['gpt-4o-mini'];
    const cost =
      (promptTokens / 1_000_000) * pricing.input +
      (completionTokens / 1_000_000) * pricing.output;

    return {
      choices: response.choices.map((choice) => ({
        content: choice.message.content ?? '',
        finishReason: choice.finish_reason,
      })),
      usage: { promptTokens, completionTokens, totalTokens },
      cost: Math.round(cost * 1_000_000) / 1_000_000,
      responseTimeMs,
      model: response.model,
    };
  }
}
