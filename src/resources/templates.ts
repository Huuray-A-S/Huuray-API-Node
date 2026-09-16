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

/** A PDF template — a document attached to the emails a delivery template sends. */
export interface PdfTemplate {
  /** Pass this as `pdfTemplateUid` when ordering, alongside an email `templateId`. */
  uid: string | null;
  name: string | null;
  /** PDF template type, as named by the API. */
  type: string | null;
  /** ISO alpha-2 language code. */
  language: string | null;
  /** The country the template can be used for; `null` means any country. */
  country: string | null;
  /** The brand the template can be used for; `null` means any brand. */
  brandName: string | null;
}

export interface ListTemplatesResult {
  templates: Template[];
  /** PDF templates, used to deliver codes as a document attached to an email. */
  pdfTemplates: PdfTemplate[];
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
interface WirePdfTemplateItem {
  Uid?: string | null;
  Name?: string | null;
  Type?: string | null;
  Language?: string | null;
  Country?: string | null;
  BrandName?: string | null;
}
interface WireTemplateResponse {
  Templates?: WireTemplateItem[] | null;
  PDFTemplates?: WirePdfTemplateItem[] | null;
}

export class TemplatesResource extends Resource {
  /**
   * Lists the delivery templates available to your account.
   *
   * `POST /v4/Template`
   *
   * Email and SMS delivery templates are in `templates`; PDF templates, which
   * attach the codes as a document to an email, are in `pdfTemplates`.
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
      pdfTemplates: (data?.PDFTemplates ?? []).map((t) => ({
        uid: t.Uid ?? null,
        name: t.Name ?? null,
        type: t.Type ?? null,
        language: t.Language ?? null,
        country: t.Country ?? null,
        brandName: t.BrandName ?? null,
      })),
    };
  }
}
