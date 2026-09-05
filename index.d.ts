/* Hand-written, because the package ships as plain ESM with no build step.
   Kept in step with src/ by test/types.test.js, which fails if a method
   exported at runtime is missing here. Mirrors packages/shared/openapi.yaml. */

export type OutcomeType =
  | 'DELIVERED' | 'PAID_ONLINE' | 'REFUSED_COD' | 'CANCELLED'
  | 'NO_ANSWER' | 'FRAUD_CONFIRMED' | 'RETURNED';

export type RiskLevel = 'UNRATED' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Verdict = 'BLOCKED' | 'OVERRIDE' | 'TRUSTED' | 'RATED' | 'UNRATED';
export type VerdictSource =
  | 'manual_blacklist' | 'network_blacklist' | 'admin_override'
  | 'whitelist' | 'events' | 'no_evidence';

export type NumraErrorCode =
  | 'LICENSE_MISSING' | 'LICENSE_INVALID' | 'LICENSE_EXPIRED' | 'LICENSE_BOUND'
  | 'COUNTRY_NOT_ALLOWED' | 'INVALID_PAYLOAD' | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED' | 'ENDPOINT_NOT_FOUND'
  | 'NETWORK_ERROR' | 'TIMEOUT' | 'SERVER_ERROR';

export declare const VERSION: string;
export declare const ERROR_CODES: readonly NumraErrorCode[];

export declare class NumraError extends Error {
  readonly code: NumraErrorCode;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryAfter: number | null;
  readonly docsUrl: string | null;
  readonly body: Record<string, unknown> | null;
  /** True when trying again later could plausibly succeed. */
  readonly retryable: boolean;
  /** True when the credential is the problem and retrying will never help. */
  readonly isAuthError: boolean;
  /** True when you are out of quota — retryable, but not today. */
  readonly isQuotaError: boolean;
}

export interface CustomerStyle {
  code: string; label: string; icon: string; color: string; riskSensitivity: number;
}

export interface TimelineEntry {
  eventType: OutcomeType;
  orderTotal: number | null;
  currency: string | null;
  region: string | null;
  note: string | null;
  siteUrl: string | null;
  createdAt: string;
}

export interface PhoneCheck {
  phone: string;
  country: 'MA';
  carrier: { code: string | null; label: string };
  /** The resolved answer; render from this rather than re-deriving one. */
  verdict: Verdict;
  /** Which rule produced the verdict. */
  verdictSource: VerdictSource;
  /** Risk, 0–100. Higher is worse. */
  riskScore: number;
  riskLevel: RiskLevel;
  /** Trust, 0–100, where high means trustworthy. A number with no history
      at all is trust 50, confidence 0 — this is what distinguishes a
      stranger from a vouched-for customer. */
  trustScore: number;
  confidence: number;
  isRated: boolean;
  totalEvents: number;
  customerStyle: CustomerStyle | null;
  isBlacklisted: boolean;
  blacklistedReason: string | null;
  lastRiskUpdateAt: string | null;
  cacheTtlSeconds: number;
  timeline: TimelineEntry[] | null;
  raw: Record<string, unknown>;
}

export interface OutcomeResult {
  /** False for an idempotent replay AND for an untracked number — read
      `message` to tell them apart. */
  recorded: boolean;
  idempotent: boolean;
  phone: string;
  orderId: string;
  outcomeType: OutcomeType;
  message: string | null;
}

export interface LicenseStatus {
  status: 'active' | 'expired' | 'suspended' | 'revoked';
  plan: string;
  country: 'MA';
  /** null means unlimited. Never coerce to 0. */
  dailyLimit: number | null;
  dailyUsed: number;
  unlimited: boolean;
  expiresAt: string | null;
  renewUrl: string;
}

export interface NumraOptions {
  /** Licence key or API key. Opaque — do not parse it. */
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout in ms. Default 10000. */
  timeout?: number;
  /** Retries for transient failures. Default 2 (three attempts total). */
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
  /** Appended to the User-Agent so we can see which versions are live. */
  integration?: string;
}

export interface CheckOptions {
  eventType?: OutcomeType;
  includeTimeline?: boolean;
  context?: {
    paymentMethod?: string;
    orderTotal?: number;
    currency?: string;
    region?: string;
    note?: string;
  };
}

/** Server-side only. The constructor throws if a real DOM is present. */
export declare class Numra {
  constructor(options: NumraOptions);
  check(phone: string, options?: CheckOptions): Promise<PhoneCheck>;
  reportOutcome(input: {
    phone: string;
    orderId: string;
    outcomeType: OutcomeType;
    orderTotal?: number;
    currency?: string;
    region?: string;
    note?: string;
  }): Promise<OutcomeResult>;
  verifyLicense(): Promise<LicenseStatus>;
}

export declare class WebhookVerificationError extends Error {
  readonly reason:
    | 'missing_signature' | 'missing_timestamp' | 'bad_timestamp'
    | 'expired' | 'invalid_signature' | 'body_not_raw';
}

export interface VerifyOptions {
  /** How far out of date a timestamp may be, in seconds. Default 300. */
  toleranceSeconds?: number;
  nowSeconds?: number;
}

/** Verify against the RAW body — a re-serialised object will never match. */
export declare function verifyWebhook(
  rawBody: string | Buffer | Uint8Array,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  options?: VerifyOptions,
): Record<string, unknown>;

export declare function isValidWebhook(
  rawBody: string | Buffer | Uint8Array,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  options?: VerifyOptions,
): boolean;

/* ── Framework-neutral request handling ─────────────────────────────────────
   What @numra/express, @numra/fastify, @numra/next and @numra/nuxt are built
   on. Use it directly only if you are writing an adapter for a framework we
   do not ship — the four decisions below are the ones that must not drift.  */

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

export interface WebhookResult extends HandlerResult {
  /** Present only on a verified webhook. Acknowledge before handling it. */
  event?: Record<string, unknown>;
}

export interface CreateHandlersOptions {
  client: Numra;
  /** Omit and every request is refused — deliberately. */
  authorize?: (ctx: unknown) => boolean | Promise<boolean>;
  webhookSecret?: string;
  /** The paste-able fix printed when `authorize` is missing. */
  usage?: string;
  log?: (...args: unknown[]) => void;
}

export declare function createHandlers(options: CreateHandlersOptions): {
  check(input: unknown, ctx?: unknown): Promise<HandlerResult>;
  outcome(input: unknown, ctx?: unknown): Promise<HandlerResult>;
  webhook(rawBody: string | Buffer | Uint8Array, headers: Record<string, string | string[] | undefined>): WebhookResult;
};

/** Narrow a check to what the browser may see. */
export declare function forBrowser(check: PhoneCheck): Record<string, unknown>;

/** Turn an upstream failure into a response. Never relays a 401. */
export declare function translateError(e: unknown, log?: (...a: unknown[]) => void): HandlerResult;

export declare const DENY_BY_DEFAULT: () => false;
export declare const DEFAULT_USAGE: string;
export declare const NOT_CONFIGURED_MESSAGE: string;
export declare function notConfiguredMessage(usage?: string): string;
