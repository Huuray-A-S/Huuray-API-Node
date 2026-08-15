import { Resource } from './base.js';

/** A delivery template — the email or SMS your recipients receive. */
export interface Template {
  /** Pass this as `templateId` when ordering. */
  id: number;
  name: string | null;
  /** Template type, e.g. email or SMS, as named by the API. */
  type: string | null;
  /** ISO alpha-2 language code. */
  language: string | null;
  sender: string | null;
  subject: string | null;
  /** Template body including HTML. */
  formattedText: string | null;
  /** Template body as plain text. */
  plainText: string | null;
}

export interface ListTemplatesResult {
  templates: Template[];
}

interface WireTemplateItem {
  Id?: number;
  Name?: string | null;
  Type?: string | null;
  Language?: string | null;
  Sender?: string | null;
  Subject?: string | null;
  FormattedText?: string | null;
  PlainText?: string | null;
}
interface WireTemplateResponse {
  Templates?: WireTemplateItem[] | null;
}

export class TemplatesResource extends Resource {
  /**
   * Lists the delivery templates available to your account.
   *
   * `POST /v4/Template`
   *
   * The endpoint declares no request body in the API specification, so this
   * client sends none — confirmed accepted by the live API.
   *
   * Note: when the account has **no active templates**, the API answers
   * `404` ("There were no active templates") rather than an empty list, so
   * this method throws `HuurayNotFoundError` in that case — catch it and
   * treat it as "no templates exist".
   */
  async list(): Promise<ListTemplatesResult> {
    const { data } = await this.client.send<WireTemplateResponse>('POST', '/v4/Template', {
      retryable: true,
    });
    return {
      templates: (data?.Templates ?? []).map((t) => ({
        id: t.Id ?? 0,
        name: t.Name ?? null,
        type: t.Type ?? null,
        language: t.Language ?? null,
        sender: t.Sender ?? null,
        subject: t.Subject ?? null,
        formattedText: t.FormattedText ?? null,
        plainText: t.PlainText ?? null,
      })),
    };
  }
}
