import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { Message } from '../messages/message.entity';

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
    params?: { stopSequence?: string[]; maxTokens?: number; n?: number },
  ): Promise<{ content: string; finishReason: string }[]> {
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages.map((m) => ({
        role: m.role,
        content: m.text,
      })),
      ...(params?.stopSequence && { stop: params.stopSequence }),
      ...(params?.maxTokens && { max_tokens: params.maxTokens }),
      ...(params?.n && { n: params.n }),
    });

    return response.choices.map((choice) => ({
      content: choice.message.content ?? '',
      finishReason: choice.finish_reason,
    }));
  }
}
