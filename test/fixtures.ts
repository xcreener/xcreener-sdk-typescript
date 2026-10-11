/**
 * Shared fixtures.
 *
 * Every test runs against an in-memory `fetch`, so the suite never needs an
 * API key, never touches the network, and never spends quota.
 */

import {
  type FetchInitLike,
  type FetchLike,
  Xcreener,
  type XcreenerOptions,
} from "../src/index.js";

export const GOOD_QUERY = `market = "CRYPTO"
timeframe = h1
columns = [rsi(14), volume]
sort = volume desc
limit = 5
rsi(14) < 30 and close > d::sma(200)`;

export const BAD_OFFSET_QUERY =
  'market = "CRYPTO"\ntimeframe = h1\nrsi(14)[1] < 30';

export const LOOKBACK_QUERY =
  'market = "CRYPTO"\ntimeframe = h1\nclose > d::highest(high, 365)';

export const SYNTAX_ERROR = {
  valid: false,
  error: {
    type: "syntax",
    message:
      "Expected '-' (offset indexing uses the form [-N], e.g. [-1]) but found '1'",
    position: { line: 3, column: 9, offset: 41 },
  },
};

export const PLAN_ERROR = {
  valid: false,
  error: {
    type: "plan",
    message:
      "Query requires 366 bars of history for d, exceeding the maximum of 300",
  },
};

export const RUN_PAYLOAD = {
  results: [
    { symbol: "SOLUSDT", columns: { "rsi(14)": 24.8, volume: 512044.2 } },
    { symbol: "ADAUSDT", columns: { "rsi(14)": 27.1, volume: 118642.0 } },
  ],
};

export const EXPLAIN_PAYLOAD = {
  plan: {
    market: "CRYPTO",
    sources: [
      { timeframe: "h1", series: ["close", "volume"], minLookback: 15 },
      { timeframe: "d", series: ["close"], minLookback: 200 },
    ],
  },
  explanation: "Matches when rsi(14) < 30 and close > d::sma(200).",
};

export const USAGE_PAYLOAD = {
  tier: "essential",
  limit: 1500,
  used: 812,
  remaining: 688,
  resetAt: "2026-07-30T00:00:00.000Z",
};

export const RESET_HEADER = "2026-08-13T00:00:00.000Z";

export const RUN_HEADERS = {
  "X-RateLimit-Remaining": "687",
  "X-RateLimit-Reset": RESET_HEADER,
  "X-RateLimit-Limit": "1500",
};

/** One request as the client sent it. */
export interface RecordedRequest {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Handler = (
  request: RecordedRequest,
) => Response | Promise<Response>;

/**
 * Captures every request the client makes, so tests can assert on what was
 * (and was not) called: the precheck tests depend on it.
 */
export class Recorder {
  readonly requests: RecordedRequest[] = [];

  get paths(): string[] {
    return this.requests.map((r) => r.path);
  }

  get last(): RecordedRequest {
    const request = this.requests.at(-1);
    if (!request) throw new Error("no requests were made");
    return request;
  }

  fetch(handler: Handler): FetchLike {
    return async (url: string, init: FetchInitLike) => {
      const request: RecordedRequest = {
        url,
        path: new URL(url).pathname,
        method: init.method,
        // Lower-cased, the way a server would see them.
        headers: Object.fromEntries(
          Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]),
        ),
        body: init.body,
      };
      this.requests.push(request);
      return handler(request);
    };
  }
}

export function json(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A handler that answers everything the same way. */
export function responder(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): Handler {
  return () => json(status, payload, headers);
}

/** A handler wired to the documented happy-path responses. */
export const happyPath: Handler = (request) => {
  switch (request.path) {
    case "/usage":
      return json(200, USAGE_PAYLOAD);
    case "/xql/validate":
      return json(200, { valid: true });
    case "/xql/explain":
      return json(200, EXPLAIN_PAYLOAD);
    case "/xql/run":
      return json(200, RUN_PAYLOAD, RUN_HEADERS);
    default:
      throw new Error(`unexpected path ${request.path}`);
  }
};

/** Build a client whose fetch is driven by `handler`. */
export function makeClient(
  handler: Handler,
  options: XcreenerOptions = {},
): { client: Xcreener; recorder: Recorder } {
  const recorder = new Recorder();
  const client = new Xcreener({
    apiKey: "test-key",
    maxRetries: 1,
    ...options,
    fetch: recorder.fetch(handler),
  });
  return { client, recorder };
}
