import analyticsJson from "../catalogue/analytics-events.json" with { type: "json" };
import errorCatalogueJson from "../catalogue/errors.json" with { type: "json" };

export const API_BASE_URL = "https://templatedesign.zhst.app/api/v1";
export const PROFILE = "certificate-cfo-v1" as const;
export const PROFILE_VERSION = "1.0.0" as const;

export type Locale = "en" | "vi";

export const ERROR_CODES = [
  "invalid_input",
  "unauthenticated",
  "insufficient_credits",
  "forbidden",
  "not_found",
  "idempotency_conflict",
  "revision_conflict",
  "payload_too_large",
  "unsupported_template",
  "profile_violation",
  "rate_limited",
  "quota_exceeded",
  "busy",
  "dependency_unavailable",
  "render_failed",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorDefinition {
  code: ErrorCode;
  http: number;
  retryable: boolean;
  title: Record<Locale, string>;
  detail: Record<Locale, string>;
  fix: string;
}

export const ERROR_CATALOGUE = errorCatalogueJson.codes as ErrorDefinition[];

const errorByCode = new Map(ERROR_CATALOGUE.map((entry) => [entry.code, entry]));

export function errorDefinition(code: ErrorCode): ErrorDefinition {
  const entry = errorByCode.get(code);
  if (!entry) throw new Error(`Unknown error code: ${code}`);
  return entry;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  request_id?: string;
  details?: Record<string, unknown>;
}

export interface ProblemInput {
  detail?: string;
  requestId?: string;
  details?: Record<string, unknown>;
  locale?: Locale;
}

/**
 * Build an RFC 9457 problem document. `code` is the stable contract; the human
 * strings are localized and may change without notice.
 */
export function problem(code: ErrorCode, input: ProblemInput = {}): Problem {
  const definition = errorDefinition(code);
  const locale = input.locale ?? "en";
  return {
    type: `https://templatedesign.zhst.app/docs/errors/#${code}`,
    title: definition.title[locale],
    status: definition.http,
    code,
    detail: input.detail ?? definition.detail[locale],
    ...(input.requestId ? { request_id: input.requestId } : {}),
    ...(input.details ? { details: input.details } : {}),
  };
}

/* ------------------------------------------------------------------ jobs */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: string;
  status: JobStatus;
  livemode: boolean;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  template_id?: string;
  template_version?: number;
  pages?: number | null;
  credits?: { reserved: number; charged: number; released: number };
  output_id?: string | null;
  delete_at?: string | null;
  error?: Problem | null;
}

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "cancelled"];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/* ------------------------------------------------------------- templates */

export interface TemplateEnvelope {
  profile: typeof PROFILE;
  kind: "certificate" | "cfo" | "logistics";
  page: {
    size: "A4" | "A6" | "100x150" | "Letter";
    orientation: "portrait" | "landscape";
    unit: "mm";
    backgroundAssetId?: string | null;
  };
  source: {
    basePdf?: string | { width: number; height: number; padding?: number[] };
    schemas: Array<Array<Record<string, unknown>>>;
  };
  td: {
    profileVersion: typeof PROFILE_VERSION;
    docLocale: Locale;
    inputSchema: Record<string, unknown>;
    sampleData?: Record<string, unknown>;
    guides?: Array<{ axis: "x" | "y"; position: number }>;
    locks?: string[];
    cfo?: {
      sections?: Array<Record<string, unknown>>;
      reconciliation?: "fail" | "show_unallocated";
    };
  };
}

/* --------------------------------------------------------------- inputs */

export interface CertificateInput {
  recipient_name: string;
  course_title: string;
  issued_on: string;
  issuer_name: string;
  issuer_role?: string;
  serial?: string;
  qr_url?: string;
  doc_language?: Locale;
  signatory_name?: string;
  signatory_role?: string;
}

export interface CfoInput {
  report: {
    title: string;
    org_name: string;
    period_start: string;
    period_end: string;
    currency: string;
    basis: "actual" | "invoice" | "estimated" | "forecast";
    source_label: string;
    locale?: Locale;
  };
  totals: {
    current_minor: number;
    previous_minor?: number | null;
    budget_minor?: number | null;
  };
  services: Array<{
    name: string;
    actual_minor: number;
    budget_minor?: number | null;
    previous_minor?: number | null;
    basis?: "actual" | "invoice" | "estimated" | "forecast";
    currency?: string;
  }>;
  allocations?: Array<{ label: string; amount_minor: number }>;
  recommendations?: string[];
  reconciliation?: "fail" | "show_unallocated";
  fx?: { base: string; quote: string; rate: number; as_of: string };
}

/* ------------------------------------------------------------ analytics */

export interface AnalyticsEvent {
  name: string;
  props: string[];
}

export const ANALYTICS_EVENTS = analyticsJson.events as AnalyticsEvent[];

const eventsByName = new Map(ANALYTICS_EVENTS.map((event) => [event.name, event]));
export const FORBIDDEN_ANALYTICS_PROPERTIES: readonly string[] = analyticsJson.forbiddenProperties;

export function isAllowedEvent(name: string): boolean {
  return eventsByName.has(name);
}

export function eventPropErrors(name: string, props: Record<string, unknown> = {}): string[] {
  const event = eventsByName.get(name);
  if (!event) return [`Unknown analytics event: ${name}`];
  const errors: string[] = [];
  for (const key of Object.keys(props)) {
    if (!event.props.includes(key)) errors.push(`${name} does not allow property "${key}"`);
  }
  for (const key of event.props) {
    if (!(key in props)) errors.push(`${name} is missing property "${key}"`);
  }
  return errors;
}

/* ---------------------------------------------------------------- limits */

export const LIMITS = {
  guestPagesPerDocument: 3,
  freePagesPerDocument: 10,
  paidPagesPerDocument: 50,
  guestConcurrentJobs: 1,
  freeConcurrentJobs: 1,
  paidConcurrentJobs: 2,
  jsonBodyBytes: { guest: 256 * 1024, free: 1024 * 1024, paid: 1024 * 1024 },
  retentionSeconds: [3600, 86400, 604800, 2592000] as const,
  shareMaxSeconds: 2592000,
} as const;

/* ------------------------------------------------------------ book profiles */

export * from "./book";
export * from "./print";
