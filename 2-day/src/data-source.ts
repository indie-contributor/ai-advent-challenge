import { DataSource } from 'typeorm';
import { Message } from './messages/message.entity';
import { Conversation } from './conversations/conversation.entity';

export default new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST || 'localhost',
  port: 3306,
  username: 'root',
  password: 'root',
  database: 'chat',
  entities: [Message, Conversation],
  migrations: ['dist/migrations/*.js'],
});
