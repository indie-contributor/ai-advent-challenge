import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSystemPromptToConversation1771500000000 implements MigrationInterface {
    name = 'AddSystemPromptToConversation1771500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`conversation\` ADD \`systemPrompt\` text NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`conversation\` DROP COLUMN \`systemPrompt\``);
    }
}
