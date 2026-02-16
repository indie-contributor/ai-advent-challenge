import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { SendMessageDto } from './dto/send-message.dto';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  create() {
    return this.conversationsService.create();
  }

  @Get(':id/messages')
  getMessages(@Param('id') id: number) {
    return this.conversationsService.getMessages(id);
  }

  @Post(':id/messages')
  sendMessage(@Param('id') id: number, @Body() dto: SendMessageDto) {
    return this.conversationsService.sendMessage(id, dto.text);
  }
}
