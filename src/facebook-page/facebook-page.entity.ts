import { Column, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { encryptedTransformer } from '../common/encrypted.transformer';

// Single-row table, same convention as instagram_connection. This is a SEPARATE connection from the main
// Instagram Login one: it exists only because Meta's "send a private reply to a comment" endpoint is not
// part of the Instagram API with Instagram Login product — it requires a Facebook Page access token instead.
// Everything else in this app keeps using the Instagram Login connection; only comment-dm.service.ts reads this.
@Entity('facebook_page_connection')
export class FacebookPageConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'page_id' })
  pageId: string;

  @Column({ name: 'page_name' })
  pageName: string;

  // The Instagram professional account this Page is linked to, so we can confirm it's the same account
  // connected via Instagram Login (and warn if someone connects the wrong Page).
  @Column({ name: 'ig_user_id', type: 'varchar', nullable: true })
  igUserId: string | null;

  // Page access tokens obtained from a long-lived user token do not expire on their own; they only stop
  // working if the person's role on the Page changes or they revoke the app's access.
  @Column({ name: 'page_access_token', type: 'text', transformer: encryptedTransformer })
  pageAccessToken: string;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
