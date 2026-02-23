import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from './conversation.entity';
import { MessagesService } from '../messages/messages.service';
import { AiService } from '../ai/ai.service';
import { Message } from '../messages/message.entity';

@Injectable()
export class ConversationsService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversationsRepository: Repository<Conversation>,
    private readonly messagesService: MessagesService,
    private readonly aiService: AiService,
  ) {}

  create(systemPrompt?: string): Promise<Conversation> {
    const conversation = this.conversationsRepository.create({
      systemPrompt: systemPrompt ?? null,
    });
    return this.conversationsRepository.save(conversation);
  }

  async findOne(id: number): Promise<Conversation> {
    const conversation = await this.conversationsRepository.findOneBy({ id });
    if (!conversation) {
      throw new NotFoundException(`Conversation #${id} not found`);
    }
    return conversation;
  }

  async getMessages(id: number): Promise<Message[]> {
    const conversation = await this.findOne(id);
    return this.messagesService.findByConversation(conversation);
  }

  async sendMessage(
    id: number,
    text: string,
    params?: { stopSequence?: string[]; maxTokens?: number; n?: number; model?: string; temperature?: number },
  ) {
    const conversation = await this.findOne(id);

    const userMessage = await this.messagesService.create(
      conversation,
      'user',
      text,
    );

    const history = await this.messagesService.findByConversation(conversation);
    const result = await this.aiService.chat(history, params, conversation.systemPrompt ?? undefined);

    const assistantMessages = await Promise.all(
      result.choices.map((choice) =>
        this.messagesService.create(
          conversation,
          'assistant',
          choice.content,
          choice.finishReason,
        ),
      ),
    );

    return {
      userMessage,
      assistantMessages,
      usage: result.usage,
      cost: result.cost,
      responseTimeMs: result.responseTimeMs,
      model: result.model,
    };
  }
}
