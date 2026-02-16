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

  async chat(messages: Message[]): Promise<string> {
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages.map((m) => ({
        role: m.role,
        content: m.text,
      })),
    });

    return response.choices[0].message.content ?? '';
  }
}
