import { Injectable, Logger } from '@nestjs/common';
import { InstagramConnectionService } from './instagram-connection.service';

// One place to change the Graph API version (dashboard webhook fields use v26.0).
export const GRAPH = `https://graph.instagram.com/${process.env.INSTAGRAM_API_VERSION ?? 'v26.0'}`;

// Thin wrapper around the Instagram Graph API using the stored token.
@Injectable()
export class GraphClient {
  private readonly logger = new Logger('Instagram API');

  constructor(private readonly connection: InstagramConnectionService) {}

  async get(path: string, params: Record<string, string> = {}, options?: { silent?: boolean }) {
    const qs = new URLSearchParams({ ...params, access_token: await this.connection.getValidAccessToken() });
    return this.parse(await fetch(`${GRAPH}${path}?${qs}`), `GET ${path}`, options?.silent);
  }

  async post(path: string, params: Record<string, string> = {}) {
    const body = new URLSearchParams({ ...params, access_token: await this.connection.getValidAccessToken() });
    return this.parse(await fetch(`${GRAPH}${path}`, { method: 'POST', body }), `POST ${path}`);
  }

  async postJson(path: string, payload: unknown) {
    return this.parse(
      await fetch(`${GRAPH}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await this.connection.getValidAccessToken()}`,
        },
        body: JSON.stringify(payload),
      }),
      `POST ${path}`,
    );
  }

  async delete(path: string, params: Record<string, string> = {}) {
    const qs = new URLSearchParams({ ...params, access_token: await this.connection.getValidAccessToken() });
    return this.parse(await fetch(`${GRAPH}${path}?${qs}`, { method: 'DELETE' }), `DELETE ${path}`);
  }

  // Poll a media container until Instagram has finished processing it (videos take a while).
  async waitForContainer(id: string, tries = 10, delayMs = 1500) {
    for (let i = 0; i < tries; i++) {
      const { status_code } = await this.get(`/${id}`, { fields: 'status_code' });
      if (status_code === 'FINISHED') return;
      if (status_code === 'ERROR' || status_code === 'EXPIRED') {
        throw new Error('Instagram could not process the media.');
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error('Instagram took too long to process the media.');
  }

  private async parse(res: Response, what: string, silent = false) {
    const body = await res.json();
    if (!res.ok) {
      const e = body?.error;
      const message = e?.error_user_msg ?? e?.message ?? `Instagram error ${res.status}`;
      // Code 230: "User consent is required to access user profile". This is an expected privacy restriction
      // in Instagram Graph API when reading an IGSID without end-user consent. We avoid spamming the warning log.
      if (!silent && e?.code !== 230) {
        this.logger.warn(`${what} failed: code ${e?.code ?? res.status}${e?.error_subcode ? '/' + e.error_subcode : ''} - ${message}`);
      } else if (e?.code === 230) {
        this.logger.debug?.(`${what} skipped: user consent required (code 230)`);
      }
      // Carry the code/subcode along so callers can tell "object gone" apart from other failures without
      // re-parsing the message text.
      throw new GraphApiError(message, e?.code, e?.error_subcode);
    }
    return body;
  }
}

export class GraphApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly subcode?: number,
  ) {
    super(message);
  }
}

// code 100 / subcode 33: the object (comment, media, ...) no longer exists — deleted on Instagram, expired,
// or never visible to this app. Distinct from a permission or transient failure, so callers can react
// differently (e.g. stop treating it as retryable) instead of showing a generic "Instagram error" message.
export function isGoneOnInstagram(err: unknown): boolean {
  return err instanceof GraphApiError && err.code === 100 && err.subcode === 33;
}

// code 230: end-user consent is required to access the user profile / profile picture.
export function isConsentRequired(err: unknown): boolean {
  return err instanceof GraphApiError && err.code === 230;
}
