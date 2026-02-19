import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  create(@Body() dto: CreateConversationDto) {
    return this.conversationsService.create(dto.systemPrompt);
  }

  @Get(':id/messages')
  getMessages(@Param('id') id: number) {
    return this.conversationsService.getMessages(id);
  }

  @Post(':id/messages')
  sendMessage(@Param('id') id: number, @Body() dto: SendMessageDto) {
    return this.conversationsService.sendMessage(id, dto.text, {
      stopSequence: dto.stopSequence,
      maxTokens: dto.maxTokens,
      n: dto.n,
      model: dto.model,
    });
  }
}
