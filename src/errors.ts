/**
 * Error hierarchy for the XCREENER client.
 *
 * Three families live here, and they are deliberately different animals:
 *
 * - {@link XQLError} and subclasses mean *your query is wrong*. Never retryable.
 * - {@link QuotaExceeded} / {@link AuthenticationError} mean *your account is
 *   wrong*. Never retryable either, but for entirely different reasons.
 * - {@link UpstreamError} / {@link TransportError} mean *we are wrong*.
 *   Retryable, and the client already retried before throwing.
 *
 * Every class sets `name`, so `err.name` and the first line of a stack trace
 * identify the failure even after the error has been serialised by a logger.
 *
 * @module
 */

/** Options shared by every error this library throws. */
export interface XcreenerErrorOptions {
  /** HTTP status of the response that caused the error, if there was one. */
  statusCode?: number | null | undefined;
  /** The underlying error, for failures that wrap another one. */
  cause?: unknown;
  /**
   * The message exactly as the API (or this library) worded it. Defaults to
   * `message`. Subclasses that decorate `message` with extra context keep the
   * undecorated text here.
   */
  rawMessage?: string | undefined;
}

/** Base class for everything this library throws. */
export class XcreenerError extends Error {
  override readonly name: string = "XcreenerError";

  /** HTTP status of the response that caused the error, or `null`. */
  readonly statusCode: number | null;

  /**
   * The message as the API worded it, without anything this library added.
   *
   * `message` is what gets printed, so for some subclasses it carries extra
   * context: a caret excerpt for a syntax error, a reset time for a quota
   * error. Use `rawMessage` when you want to show the API's own words.
   */
  readonly rawMessage: string;

  constructor(message: string, options: XcreenerErrorOptions = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.statusCode = options.statusCode ?? null;
    this.rawMessage = options.rawMessage ?? message;
  }
}

/**
 * 401. Missing, malformed, or unrecognized API key.
 *
 * Rejected before parse/plan logic runs, so this says nothing about whether
 * your query is valid. Note that regenerating a key invalidates the old one
 * everywhere it is in use.
 */
export class AuthenticationError extends XcreenerError {
  override readonly name: string = "AuthenticationError";
}

/** Options for {@link QuotaExceeded}. */
export interface QuotaExceededOptions extends XcreenerErrorOptions {
  limit?: number | null | undefined;
  resetAt?: Date | null | undefined;
}

/**
 * 429. The daily `/xql/run` quota for this subscription tier is spent.
 *
 * `validate` and `explain` keep working: they are never metered. So a
 * reasonable reaction to this is to keep iterating on the query for free and
 * schedule the run for after {@link QuotaExceeded.resetAt}.
 *
 * `resetAt` and `limit` come from the rate-limit headers on the 429 itself, so
 * they describe the response you just got. Both are `null` if the server did
 * not send those headers.
 */
export class QuotaExceeded extends XcreenerError {
  override readonly name: string = "QuotaExceeded";
  readonly limit: number | null;
  readonly resetAt: Date | null;

  constructor(message: string, options: QuotaExceededOptions = {}) {
    const resetAt = options.resetAt ?? null;
    super(
      resetAt
        ? `${message} (quota resets at ${resetAt.toISOString()})`
        : message,
      { ...options, rawMessage: options.rawMessage ?? message },
    );
    this.limit = options.limit ?? null;
    this.resetAt = resetAt;
  }
}

/** Which stage of the XQL pipeline rejected a query. */
export type XQLErrorType = "syntax" | "plan" | "unknown";

/** Options for {@link XQLError}. */
export interface XQLErrorOptions extends XcreenerErrorOptions {
  /** The query text that was rejected. */
  query?: string | null | undefined;
}

/** 400. The query did not parse or did not plan. No data was fetched. */
export class XQLError extends XcreenerError {
  override readonly name: string = "XQLError";

  /** `"syntax"` or `"plan"`, straight from the API. */
  readonly errorType: XQLErrorType = "unknown";

  /** The query text that was rejected, or `null` if it was not known. */
  readonly query: string | null;

  constructor(message: string, options: XQLErrorOptions = {}) {
    super(message, options);
    this.query = options.query ?? null;
  }
}

/** Options for {@link XQLSyntaxError}. */
export interface XQLSyntaxErrorOptions extends XQLErrorOptions {
  line?: number | null | undefined;
  column?: number | null | undefined;
  offset?: number | null | undefined;
}

/**
 * A parse-time failure. Carries a 1-based line and column and a 0-based
 * character offset.
 *
 * `message` renders the offending line with a caret under the reported
 * column, so logging the error is usually enough to see what went wrong.
 * `rawMessage` has the API's text on its own.
 */
export class XQLSyntaxError extends XQLError {
  override readonly name: string = "XQLSyntaxError";
  override readonly errorType: XQLErrorType = "syntax";
  readonly line: number | null;
  readonly column: number | null;
  readonly offset: number | null;

  /** The offending line with a caret under the column, or `null`. */
  readonly excerpt: string | null;

  constructor(message: string, options: XQLSyntaxErrorOptions = {}) {
    const line = options.line ?? null;
    const column = options.column ?? null;
    const excerpt = renderExcerpt(options.query ?? null, line, column);

    let rendered = message;
    if (line !== null) {
      rendered = `line ${line}, column ${column}: ${message}`;
      if (excerpt) rendered = `${rendered}\n\n${excerpt}`;
    }

    super(rendered, { ...options, rawMessage: options.rawMessage ?? message });
    this.line = line;
    this.column = column;
    this.offset = options.offset ?? null;
    this.excerpt = excerpt;
  }
}

/** Render the offending line with a caret under the reported column. */
function renderExcerpt(
  query: string | null,
  line: number | null,
  column: number | null,
): string | null {
  if (!query || line === null || column === null) return null;
  const lines = query.split(/\r\n|\r|\n/);
  if (line < 1 || line > lines.length) return null;
  // Tabs would desynchronise the caret, so normalise them first.
  const source = (lines[line - 1] ?? "").replaceAll("\t", "    ");
  const caretColumn = Math.max(column - 1, 0);
  return `    ${source}\n    ${" ".repeat(caretColumn)}^`;
}

const LOOKBACK_PATTERN =
  /requires (?<required>\d+) bars? of history for (?<timeframe>\w+), exceeding the maximum of (?<maximum>\d+)/;

/**
 * A plan-time failure. The query parsed but cannot be executed as written.
 *
 * The common case by far is the 300-bar lookback ceiling, in which case
 * `requiredBars`, `maxBars` and `timeframe` are populated so callers can
 * react programmatically instead of matching on the message.
 */
export class XQLPlanError extends XQLError {
  override readonly name: string = "XQLPlanError";
  override readonly errorType: XQLErrorType = "plan";
  readonly requiredBars: number | null = null;
  readonly maxBars: number | null = null;
  readonly timeframe: string | null = null;

  constructor(message: string, options: XQLErrorOptions = {}) {
    super(message, options);
    const groups = LOOKBACK_PATTERN.exec(message)?.groups;
    if (groups?.required && groups.maximum && groups.timeframe) {
      this.requiredBars = Number(groups.required);
      this.maxBars = Number(groups.maximum);
      this.timeframe = groups.timeframe;
    }
  }

  /** True when this is specifically the 300-bar ceiling rejection. */
  get isLookbackCeiling(): boolean {
    return this.requiredBars !== null;
  }
}

/**
 * 5xx. The query parsed and planned, but the server could not serve it.
 *
 * Typically a database connection failure behind `/xql/run`. The client
 * retries these before throwing, so seeing one means the retries ran out.
 */
export class UpstreamError extends XcreenerError {
  override readonly name: string = "UpstreamError";
}

/**
 * The request never completed: DNS, TLS, connection reset, timeout.
 *
 * `cause` holds the underlying error from `fetch`. Cancelling a call through
 * your own `AbortSignal` is not a transport failure: that rejects with the
 * signal's reason, unwrapped, and is never retried.
 */
export class TransportError extends XcreenerError {
  override readonly name: string = "TransportError";
}

/** Options for {@link ColumnNotFoundError}. */
export interface ColumnNotFoundErrorOptions extends XcreenerErrorOptions {
  symbol: string;
  column: string;
  available: readonly string[];
}

/**
 * A column was read off a match that did not return it.
 *
 * Thrown by `Match.value()`. Almost always means the expression is missing
 * from the query's `columns` pragma: a condition's own inputs are not
 * surfaced automatically.
 */
export class ColumnNotFoundError extends XcreenerError {
  override readonly name: string = "ColumnNotFoundError";
  readonly symbol: string;
  readonly column: string;
  readonly available: readonly string[];

  constructor(options: ColumnNotFoundErrorOptions) {
    const listed = options.available.length
      ? options.available.join(", ")
      : "none";
    super(
      `"${options.column}" was not returned for ${options.symbol}. ` +
        `Columns present: ${listed}. ` +
        "Remember that a condition's own inputs are not surfaced " +
        "automatically: add the expression to the query's `columns` " +
        "pragma to get it back.",
      options,
    );
    this.symbol = options.symbol;
    this.column = options.column;
    this.available = options.available;
  }
}
