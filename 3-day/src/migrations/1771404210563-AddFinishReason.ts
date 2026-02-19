import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFinishReason1771404210563 implements MigrationInterface {
    name = 'AddFinishReason1771404210563'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`message\` ADD \`finishReason\` varchar(255) NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`message\` DROP COLUMN \`finishReason\``);
    }

}
