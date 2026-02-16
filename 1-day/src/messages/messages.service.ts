import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message } from './message.entity';
import { Conversation } from '../conversations/conversation.entity';

@Injectable()
export class MessagesService {
  constructor(
    @InjectRepository(Message)
    private readonly messagesRepository: Repository<Message>,
  ) {}

  findByConversation(conversation: Conversation): Promise<Message[]> {
    return this.messagesRepository.find({
      where: { conversation: { id: conversation.id } },
      order: { createdAt: 'ASC' },
    });
  }

  create(
    conversation: Conversation,
    role: 'user' | 'assistant',
    text: string,
  ): Promise<Message> {
    const message = this.messagesRepository.create({
      conversation,
      role,
      text,
    });
    return this.messagesRepository.save(message);
  }
}
