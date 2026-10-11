/**
 * The XCREENER client.
 *
 * @module
 */

import {
  AuthenticationError,
  QuotaExceeded,
  TransportError,
  UpstreamError,
  XcreenerError,
  XQLError,
} from "./errors.js";
import { isObject, type JsonObject } from "./internal/parse.js";
import {
  backoffMs,
  describeFetchError,
  isBrowser,
  readEnvApiKey,
  sleep,
} from "./internal/runtime.js";
import {
  type Columns,
  Explanation,
  Quota,
  RateLimit,
  ResultSet,
  type SupportsXQL,
  ValidationFailure,
  type ValidationResult,
  ValidationSuccess,
  XQLErrorDetail,
} from "./models.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.xcreener.com";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;

const USER_AGENT = `xcreener-sdk-typescript/${VERSION}`;

/**
 * A zero-argument function returning the key, synchronously or not.
 *
 * Called on every request, which is what makes rotation possible without
 * rebuilding the client: point it at your secret manager.
 */
export type ApiKeyProvider = () => string | Promise<string>;

/** The key itself, or a provider for it. */
export type ApiKeyLike = string | ApiKeyProvider;

/**
 * A query is either raw XQL text, or any object that renders itself to XQL.
 *
 * The second case is what a future expression or builder layer plugs into: it
 * only has to grow a `toXql()` method, and this client keeps working.
 */
export type QueryLike = string | SupportsXQL;

/** The subset of a fetch `Response` this client reads. */
export interface FetchResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The subset of fetch `RequestInit` this client sends. */
export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * A `fetch`-compatible function. The global `fetch` satisfies it, and so does
 * a test double that implements only these few members.
 */
export type FetchLike = (
  url: string,
  init: FetchInitLike,
) => Promise<FetchResponseLike>;

/** Options for the {@link Xcreener} constructor. */
export interface XcreenerOptions {
  /**
   * The key, or a function returning it. Falls back to `$XCREENER_API_KEY`.
   * Nothing is written to disk: where the key lives is your call, not this
   * library's.
   */
  apiKey?: ApiKeyLike | undefined;
  /** Override for testing or a self-hosted proxy. */
  baseUrl?: string | undefined;
  /** Per-attempt timeout in milliseconds. Defaults to 30 000. */
  timeout?: number | undefined;
  /**
   * Retries for 5xx and transport failures only. Never for 400, 401 or 429,
   * which will not change on a retry. Zero disables retrying.
   */
  maxRetries?: number | undefined;
  /**
   * Default for {@link Xcreener.run}. When true, every run is preceded by a
   * free `validate` call so a malformed query throws before any quota is
   * spent. Costs a round trip, spends nothing.
   */
  precheck?: boolean | undefined;
  /** A `fetch` to use instead of the global one. */
  fetch?: FetchLike | undefined;
  /**
   * Allow construction in a browser page.
   *
   * Off by default because any key shipped to a browser is readable by
   * anyone who opens devtools. Only turn this on when the key is already
   * meant to be visible to the person running the page.
   */
  dangerouslyAllowBrowser?: boolean | undefined;
}

/** Options accepted by every call. */
export interface RequestOptions {
  /**
   * Cancels the call, including any retries still pending. A cancelled call
   * rejects with the signal's reason and is never retried.
   */
  signal?: AbortSignal | undefined;
}

/** Options for {@link Xcreener.run}. */
export interface RunOptions extends RequestOptions {
  /**
   * Overrides the client-level default. When true, a free `validate` runs
   * first and throws on failure, so a malformed query costs zero quota
   * instead of one call.
   */
  precheck?: boolean | undefined;
}

interface HttpResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: string;
}

/**
 * Trim and sanity-check a key before it reaches an HTTP header.
 *
 * The raw key is shown exactly once at generation time, so it is almost
 * always pasted, and a pasted key routinely carries a trailing newline. Sent
 * verbatim that produces an ordinary 401, which reads as "my key is wrong"
 * and tempts the user to regenerate: that invalidates the working key
 * everywhere it is in use, including their MCP config. Catching the
 * whitespace here turns a costly misdiagnosis into an obvious message.
 */
function normalizeApiKey(value: string): string {
  const key = value.trim();
  if (!key) throw new Error("API key is empty");
  for (const ch of key) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 32 || code >= 127) {
      throw new Error(
        "API key contains whitespace or non-printable characters. If you " +
          "pasted it, check for a stray newline or space. This is a " +
          "formatting problem, not a rejected key: you do not need to " +
          "regenerate it.",
      );
    }
  }
  return key;
}

function toXqlText(query: QueryLike): string {
  let text: unknown;
  if (typeof query === "string") {
    text = query;
  } else if (
    typeof query === "object" &&
    query !== null &&
    typeof (query as Partial<SupportsXQL>).toXql === "function"
  ) {
    text = query.toXql();
  } else {
    const got = query === null ? "null" : typeof query;
    throw new TypeError(
      `Expected XQL text or an object with .toXql(), got ${got}`,
    );
  }
  const trimmed = String(text).trim();
  if (!trimmed) throw new Error("Query is empty");
  return trimmed;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Client for the XCREENER HTTP API.
 *
 * All three XQL endpoints read the query from the raw request body as plain
 * text, so this client never JSON-wraps it.
 *
 * `validate` and `explain` are unmetered and only `run` counts against the
 * daily quota. That asymmetry shows up in the API here: `validate` and
 * `explain` are cheap enough to call in a loop while iterating, and
 * `run(q, { precheck: true })` turns a doomed metered call into a free one.
 *
 * ```ts
 * const xc = new Xcreener(); // reads XCREENER_API_KEY
 * const result = await xc.validate('market = "CRYPTO"\ntimeframe = h1\nrsi(14) < 30');
 * result.valid; // true
 * ```
 */
export class Xcreener {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly precheck: boolean;

  // True private fields: absent from console.log, util.inspect, JSON.stringify
  // and Object.keys, so the key cannot leak through any of them.
  readonly #apiKeyProvider: ApiKeyProvider;
  readonly #fetch: FetchLike;
  #rateLimit: RateLimit | null = null;

  constructor(options: XcreenerOptions = {}) {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      // Left unchecked this skips the request loop entirely and surfaces as a
      // TransportError with no underlying cause, which reads like a network
      // fault rather than a typo.
      throw new RangeError(
        `maxRetries must be an integer >= 0, got ${maxRetries}`,
      );
    }
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new RangeError(
        `timeout must be a positive number of milliseconds, got ${timeout}`,
      );
    }
    if (isBrowser() && !options.dangerouslyAllowBrowser) {
      throw new XcreenerError(
        "Refusing to run in a browser: the API key would be readable by " +
          "anyone who opens devtools. Call the API from a server you control " +
          "instead, or pass dangerouslyAllowBrowser: true if the key is " +
          "already meant to be visible to whoever runs this page.",
      );
    }

    const apiKey = options.apiKey;
    if (typeof apiKey === "function") {
      // Resolved per request, so a rotated key is picked up without
      // rebuilding the client. Deliberately not called here: a provider
      // backed by a secret manager should not be hit an extra time at
      // construction, and it may not be ready yet.
      this.#apiKeyProvider = apiKey;
    } else {
      const key = apiKey || readEnvApiKey();
      if (!key) {
        throw new Error(
          "No API key. Pass { apiKey } or set XCREENER_API_KEY. " +
            "Generate one at https://xcreener.com/account/api-key " +
            "(the raw key is shown only once).",
        );
      }
      const checked = normalizeApiKey(key);
      this.#apiKeyProvider = () => checked;
    }

    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.precheck = options.precheck ?? false;
    // Looked up at call time rather than captured here, so a polyfill or a
    // test spy installed after construction is still honoured. Called through
    // globalThis because browsers reject an unbound fetch.
    this.#fetch =
      options.fetch ??
      ((url, init) =>
        globalThis.fetch(url, init) as Promise<FetchResponseLike>);
  }

  // ------------------------------------------------------------------
  // Endpoints
  // ------------------------------------------------------------------

  /**
   * `POST /xql/validate`. Parse and plan without touching data.
   *
   * Unmetered, and works on any recognized key including free tier. An
   * invalid query resolves to a {@link ValidationFailure} rather than
   * rejecting, since checking is the point of the call.
   */
  async validate(
    query: QueryLike,
    options: RequestOptions = {},
  ): Promise<ValidationResult> {
    const text = toXqlText(query);
    const response = await this.#request(
      "POST",
      "/xql/validate",
      text,
      options.signal,
    );

    if (response.status === 400) {
      const detail = this.#errorDetail(response);
      if (detail) return new ValidationFailure(detail, text);
    }

    this.#throwForStatus(response, text);
    const payload = this.#json(response);
    const valid = payload.valid === undefined ? true : Boolean(payload.valid);
    if (valid) return new ValidationSuccess(text);
    const error = isObject(payload.error)
      ? XQLErrorDetail.fromJSON(payload.error)
      : null;
    return new ValidationFailure(error, text);
  }

  /**
   * `POST /xql/explain`. Return the data plan and a description.
   *
   * Unmetered. Useful for reading `minLookback` per timeframe before
   * committing a metered run.
   */
  async explain(
    query: QueryLike,
    options: RequestOptions = {},
  ): Promise<Explanation> {
    const text = toXqlText(query);
    const response = await this.#request(
      "POST",
      "/xql/explain",
      text,
      options.signal,
    );
    this.#throwForStatus(response, text);
    return Explanation.fromJSON(this.#json(response));
  }

  /**
   * `POST /xql/run`. Execute against live market data.
   *
   * This is the only metered endpoint. An empty {@link ResultSet} means the
   * query is valid and nothing matches right now, which is not an error.
   *
   * Pass a column shape to get typed values back. It is a type assertion
   * about what your query's `columns` pragma returns, not a runtime check:
   *
   * ```ts
   * const rs = await xc.run<{ "rsi(14)": number; volume: number }>(query);
   * rs.at(0)?.value("rsi(14)"); // number
   * ```
   */
  async run<C extends Columns = Columns>(
    query: QueryLike,
    options: RunOptions = {},
  ): Promise<ResultSet<C>> {
    const text = toXqlText(query);
    if (options.precheck ?? this.precheck) {
      (await this.validate(text, options)).throwIfInvalid();
    }

    const response = await this.#request(
      "POST",
      "/xql/run",
      text,
      options.signal,
    );
    this.#captureRateLimit(response);
    this.#throwForStatus(response, text);
    return ResultSet.fromJSON<C>(this.#json(response));
  }

  /**
   * `GET /usage`. Report quota state without consuming any of it.
   *
   * Safe to call as often as you like, and it still answers at 429.
   */
  async usage(options: RequestOptions = {}): Promise<Quota> {
    const response = await this.#request("GET", "/usage", null, options.signal);
    this.#throwForStatus(response, null);
    return Quota.fromJSON(this.#json(response));
  }

  // ------------------------------------------------------------------
  // Convenience
  // ------------------------------------------------------------------

  /**
   * Quota state from the headers of the most recent {@link Xcreener.run}.
   *
   * `null` until the first run. Reading this is free; polling `usage()` for
   * the same information is not necessary between runs.
   */
  get rateLimit(): RateLimit | null {
    return this.#rateLimit;
  }

  /**
   * A masked form of the key, safe to log or paste into a support thread.
   *
   * Asynchronous because the key may come from an async provider. The full
   * key is never exposed by this class: not through `console.log`, not
   * through `JSON.stringify`, not through any error it throws.
   */
  async keyHint(): Promise<string> {
    const key = await this.#resolveKey();
    return key.length > 8 ? `...${key.slice(-4)}` : "...";
  }

  toString(): string {
    return `Xcreener(baseUrl=${JSON.stringify(this.baseUrl)})`;
  }

  // Clients end up in logs, error trackers and REPL output. These keep every
  // rendering of one to the base URL.
  toJSON(): { baseUrl: string } {
    return { baseUrl: this.baseUrl };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  // ------------------------------------------------------------------
  // Transport
  // ------------------------------------------------------------------

  async #resolveKey(): Promise<string> {
    const key = await this.#apiKeyProvider();
    if (!key) throw new Error("apiKey provider returned an empty key");
    return normalizeApiKey(key);
  }

  async #headers(hasBody: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.#resolveKey()}`,
      Accept: "application/json",
    };
    // Browsers refuse to let a page set User-Agent, so only send it elsewhere.
    if (!isBrowser()) headers["User-Agent"] = USER_AGENT;
    if (hasBody) {
      // The endpoints read raw text, not a JSON-wrapped field.
      headers["Content-Type"] = "text/plain; charset=utf-8";
    }
    return headers;
  }

  async #request(
    method: string,
    path: string,
    body: string | null,
    signal: AbortSignal | undefined,
  ): Promise<HttpResponse> {
    const url = `${this.baseUrl}${path}`;
    const headers = await this.#headers(body !== null);

    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const timeoutSignal = AbortSignal.timeout(this.timeout);
      const init: FetchInitLike = {
        method,
        headers,
        signal: signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal,
      };
      if (body !== null) init.body = body;

      let response: HttpResponse;
      try {
        const raw = await this.#fetch(url, init);
        // Read inside the try: a connection dropped mid-body is a transport
        // failure too, and just as worth retrying.
        response = {
          status: raw.status,
          headers: raw.headers,
          body: await raw.text(),
        };
      } catch (error) {
        // The caller cancelled. That is a decision, not a fault: surface it
        // as-is and do not retry.
        if (signal?.aborted) throw signal.reason;
        if (attempt >= this.maxRetries) {
          throw new TransportError(
            `Request to ${url} failed: ${describeFetchError(error, this.timeout)}`,
            { cause: error },
          );
        }
        await sleep(backoffMs(attempt), signal);
        continue;
      }

      // Only server-side failures are worth retrying. A 400 will parse
      // exactly the same way next time, and a 429 will not have refilled.
      if (response.status >= 500 && attempt < this.maxRetries) {
        await sleep(backoffMs(attempt), signal);
        continue;
      }
      return response;
    }
  }

  #captureRateLimit(response: HttpResponse): void {
    const parsed = RateLimit.fromHeaders(response.headers);
    if (parsed) this.#rateLimit = parsed;
  }

  #json(response: HttpResponse): JsonObject {
    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      throw new XcreenerError(
        `Expected JSON, got ${JSON.stringify(response.body.slice(0, 200))}`,
        { statusCode: response.status },
      );
    }
    if (!isObject(payload)) {
      const kind = Array.isArray(payload)
        ? "array"
        : payload === null
          ? "null"
          : typeof payload;
      throw new XcreenerError(`Expected a JSON object, got ${kind}`, {
        statusCode: response.status,
      });
    }
    return payload;
  }

  /**
   * Pull the `error` object out of a 400 body, if it is one.
   *
   * Not every error body is an object: 429 returns `{"error": "..."}` with a
   * bare string, so this returns null in that case rather than pretending it
   * is an XQL error.
   */
  #errorDetail(response: HttpResponse): XQLErrorDetail | null {
    const payload = parseJson(response.body);
    if (!isObject(payload) || !isObject(payload.error)) return null;
    return XQLErrorDetail.fromJSON(payload.error);
  }

  #errorMessage(response: HttpResponse, fallback: string): string {
    const payload = parseJson(response.body);
    if (payload === undefined) {
      return response.body.trim().slice(0, 200) || fallback;
    }
    if (isObject(payload)) {
      const error = payload.error;
      if (typeof error === "string") return error;
      if (isObject(error) && error.message !== undefined) {
        return String(error.message);
      }
      if (typeof payload.message === "string") return payload.message;
    }
    return fallback;
  }

  #throwForStatus(response: HttpResponse, query: string | null): void {
    const status = response.status;
    if (status < 400) return;

    if (status === 401) {
      throw new AuthenticationError(
        this.#errorMessage(
          response,
          "API key missing or unrecognized. Check XCREENER_API_KEY, and " +
            "note that regenerating a key invalidates the old one.",
        ),
        { statusCode: 401 },
      );
    }

    if (status === 429) {
      // From this response, not from the last run: a 429 thrown by usage()
      // or validate() would otherwise report a reset time scraped from an
      // unrelated earlier call, or none at all.
      const limit = RateLimit.fromHeaders(response.headers) ?? this.#rateLimit;
      throw new QuotaExceeded(
        this.#errorMessage(response, "Daily API rate limit exceeded"),
        {
          statusCode: 429,
          limit: limit?.limit ?? null,
          resetAt: limit?.resetAt ?? null,
        },
      );
    }

    if (status === 400) {
      const detail = this.#errorDetail(response);
      if (detail) throw detail.toError(query);
      throw new XQLError(this.#errorMessage(response, "Query rejected"), {
        query,
        statusCode: 400,
      });
    }

    if (status >= 500) {
      throw new UpstreamError(
        this.#errorMessage(
          response,
          "The query planned successfully but the server could not serve it.",
        ),
        { statusCode: status },
      );
    }

    throw new XcreenerError(
      this.#errorMessage(response, `Unexpected status ${status}`),
      { statusCode: status },
    );
  }
}
