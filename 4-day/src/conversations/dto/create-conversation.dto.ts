import { IsString, IsOptional } from 'class-validator';

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  systemPrompt?: string;
}
