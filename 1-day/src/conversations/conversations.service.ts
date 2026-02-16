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

  create(): Promise<Conversation> {
    const conversation = this.conversationsRepository.create();
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
  ): Promise<{ userMessage: Message; assistantMessage: Message }> {
    const conversation = await this.findOne(id);

    const userMessage = await this.messagesService.create(
      conversation,
      'user',
      text,
    );

    const history = await this.messagesService.findByConversation(conversation);
    const aiResponse = await this.aiService.chat(history);

    const assistantMessage = await this.messagesService.create(
      conversation,
      'assistant',
      aiResponse,
    );

    return { userMessage, assistantMessage };
  }
}
