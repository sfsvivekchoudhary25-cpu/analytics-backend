import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { encryptText } from '../common/encrypted.transformer';
import { rlsStorage } from '../common/rls/rls.context';

// Customer message text is stored encrypted (see encryptedTextTransformer). Rows written before that was switched on
// are still plain text; this encrypts them, a few at a time, in the background after the server starts.
// Safe to run any number of times and from several servers at once: it only touches values that are still plain, and
// each update checks the value has not changed in the meantime.
const TARGETS: { table: string; pk: string; column: string }[] = [
  { table: 'message', pk: 'id', column: 'text' },
  { table: 'message', pk: 'id', column: 'attachment_url' },
  { table: 'conversation', pk: 'igsid', column: 'last_text' },
  { table: 'message_auto_log', pk: 'id', column: 'reply_text' },
];

@Injectable()
export class MessageEncryptionBackfill implements OnModuleInit {
  private readonly logger = new Logger('MessageEncryption');

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit() {
    // Not awaited: the server must start (and answer Render's health check) without waiting for this.
    setTimeout(() => this.run().catch((e) => this.logger.warn(`Backfill stopped: ${(e as Error).message}`)), 20_000);
  }

  async run(): Promise<number> {
    let total = 0;
    await rlsStorage.run({ bypass: true }, async () => {
      for (const t of TARGETS) {
        for (;;) {
          const rows: { pk: string; v: string }[] = await this.dataSource.query(
            `SELECT "${t.pk}"::text AS pk, "${t.column}" AS v FROM "${t.table}" WHERE "${t.column}" IS NOT NULL AND "${t.column}" <> '' AND "${t.column}" NOT LIKE 'enc1:%' LIMIT 200`,
          );
          if (!rows.length) break;
          for (const r of rows) {
            await this.dataSource.query(`UPDATE "${t.table}" SET "${t.column}" = $1 WHERE "${t.pk}"::text = $2 AND "${t.column}" = $3`, [
              encryptText(r.v),
              r.pk,
              r.v,
            ]);
          }
          total += rows.length;
        }
      }
    });
    if (total > 0) this.logger.log(`Encrypted ${total} stored message value(s) that were still plain text.`);
    return total;
  }
}
