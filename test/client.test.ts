import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  AuthenticationError,
  ColumnNotFoundError,
  Explanation,
  Match,
  QuotaExceeded,
  ResultSet,
  TransportError,
  UpstreamError,
  ValidationFailure,
  ValidationSuccess,
  VERSION,
  Xcreener,
  XcreenerError,
  XQLError,
  XQLPlanError,
  XQLSyntaxError,
} from "../src/index.js";
import {
  BAD_OFFSET_QUERY,
  GOOD_QUERY,
  happyPath,
  json,
  LOOKBACK_QUERY,
  makeClient,
  PLAN_ERROR,
  RESET_HEADER,
  responder,
  SYNTAX_ERROR,
} from "./fixtures.js";

/** Await a promise that must reject, and hand back what it rejected with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ transport

describe("transport", () => {
  it("sends the query as raw text, not JSON", async () => {
    const { client, recorder } = makeClient(happyPath);
    await client.run(GOOD_QUERY);
    const request = recorder.last;
    expect(request.body).toBe(GOOD_QUERY);
    expect(request.headers["content-type"]).toMatch(/^text\/plain/);
    expect(request.headers.authorization).toBe("Bearer test-key");
    expect(request.headers["user-agent"]).toBe(
      `xcreener-sdk-typescript/${VERSION}`,
    );
  });

  it("sends no body or content type on GET", async () => {
    const { client, recorder } = makeClient(happyPath);
    await client.usage();
    expect(recorder.last.method).toBe("GET");
    expect(recorder.last.body).toBeUndefined();
    expect(recorder.last.headers["content-type"]).toBeUndefined();
  });

  it("strips a trailing slash from baseUrl", async () => {
    const { client, recorder } = makeClient(happyPath, {
      baseUrl: "https://proxy.example.com/",
    });
    await client.usage();
    expect(recorder.last.url).toBe("https://proxy.example.com/usage");
  });

  it("falls back to the environment for the key", async () => {
    vi.stubEnv("XCREENER_API_KEY", "from-env");
    const { client, recorder } = makeClient(happyPath, { apiKey: undefined });
    await client.usage();
    expect(recorder.last.headers.authorization).toBe("Bearer from-env");
  });

  it("trims whitespace from a pasted key", async () => {
    // A trailing newline from a paste must not reach the wire as a bad 401.
    const { client, recorder } = makeClient(happyPath, {
      apiKey: () => "  padded-key\n",
    });
    await client.validate(GOOD_QUERY);
    expect(recorder.last.headers.authorization).toBe("Bearer padded-key");
  });

  it.each(["key with space", "key\twith\ttab", "k\u0000ey", "kéy"])(
    "names the real problem for a malformed key %j",
    (bad) => {
      expect(() => new Xcreener({ apiKey: bad })).toThrow(
        /do not need to regenerate/,
      );
    },
  );

  it("rejects a missing key at construction", () => {
    vi.stubEnv("XCREENER_API_KEY", undefined);
    expect(() => new Xcreener()).toThrow(/XCREENER_API_KEY/);
  });

  it("accepts any object with toXql()", async () => {
    // Forward compatibility with a future expression or builder layer.
    const { client } = makeClient(happyPath);
    const query = { toXql: () => GOOD_QUERY };
    expect((await client.run(query)).symbols).toEqual(["SOLUSDT", "ADAUSDT"]);
  });

  it.each([123, null, {}, undefined])("rejects a non-query %j", async (bad) => {
    const { client } = makeClient(happyPath);
    // @ts-expect-error: deliberately the wrong type
    await expect(client.run(bad)).rejects.toThrow(TypeError);
  });

  it("rejects an empty query", async () => {
    const { client } = makeClient(happyPath);
    await expect(client.run("   \n  ")).rejects.toThrow(/empty/);
  });

  it("rejects a negative or fractional maxRetries", () => {
    expect(() => makeClient(happyPath, { maxRetries: -1 })).toThrow(
      /maxRetries must be an integer >= 0/,
    );
    expect(() => makeClient(happyPath, { maxRetries: 1.5 })).toThrow(
      RangeError,
    );
  });

  it("rejects a non-positive timeout", () => {
    expect(() => makeClient(happyPath, { timeout: 0 })).toThrow(RangeError);
  });

  it("uses the global fetch when none is injected", async () => {
    const fetch = vi.fn(async () => json(200, { valid: true }));
    vi.stubGlobal("fetch", fetch);
    const client = new Xcreener({ apiKey: "test-key" });
    await client.validate(GOOD_QUERY);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

// ------------------------------------------------------------------- validate

describe("validate", () => {
  it("narrows to ValidationSuccess for a good query", async () => {
    const { client } = makeClient(happyPath);
    const result = await client.validate(GOOD_QUERY);
    expect(result).toBeInstanceOf(ValidationSuccess);
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
    expect(result.message).toBeNull();
  });

  it("resolves an invalid query rather than rejecting", async () => {
    const { client } = makeClient(responder(400, SYNTAX_ERROR));
    const result = await client.validate(BAD_OFFSET_QUERY);
    expect(result).toBeInstanceOf(ValidationFailure);
    expect(result.valid).toBe(false);
  });

  it("surfaces the raw API message", async () => {
    const { client } = makeClient(responder(400, SYNTAX_ERROR));
    const result = await client.validate(BAD_OFFSET_QUERY);
    expect(result.message).toBe(SYNTAX_ERROR.error.message);
  });

  it("throwIfInvalid throws with the position", async () => {
    const { client } = makeClient(responder(400, SYNTAX_ERROR));
    const result = await client.validate(BAD_OFFSET_QUERY);
    const error = (() => {
      try {
        result.throwIfInvalid();
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(XQLSyntaxError);
    const syntax = error as XQLSyntaxError;
    expect([syntax.line, syntax.column, syntax.offset]).toEqual([3, 9, 41]);
    expect(syntax.rawMessage).toBe(SYNTAX_ERROR.error.message);
  });

  it("renders a caret under the column", async () => {
    const { client } = makeClient(responder(400, SYNTAX_ERROR));
    const error = (await client.validate(
      BAD_OFFSET_QUERY,
    )) as ValidationFailure;
    const rendered = error.toError().message;
    expect(rendered).toContain("rsi(14)[1] < 30");
    const caretLine = rendered.split("\n").at(-1) ?? "";
    expect(caretLine.trim()).toBe("^");
    expect(caretLine.indexOf("^")).toBe("    rsi(14)[".length);
  });

  it("treats a bare {valid: false} as invalid and still throws", async () => {
    // Nothing to build a specific error from, but staying silent would make
    // the result invalid *and* non-throwing.
    const { client } = makeClient(responder(200, { valid: false }));
    const result = await client.validate(GOOD_QUERY);
    expect(result.valid).toBe(false);
    expect(() => result.throwIfInvalid()).toThrow(XQLError);
  });

  it("keeps an error object sent with a 200 {valid: false}", async () => {
    const { client } = makeClient(
      responder(200, { valid: false, error: PLAN_ERROR.error }),
    );
    const result = await client.validate(LOOKBACK_QUERY);
    expect(result.message).toBe(PLAN_ERROR.error.message);
    expect(() => result.throwIfInvalid()).toThrow(XQLPlanError);
  });

  it("narrows on valid at the type level", async () => {
    const { client } = makeClient(happyPath);
    const result = await client.validate(GOOD_QUERY);
    if (!result.valid) {
      expectTypeOf(result).toEqualTypeOf<ValidationFailure>();
      expectTypeOf(result.message).toEqualTypeOf<string | null>();
    } else {
      expectTypeOf(result).toEqualTypeOf<ValidationSuccess>();
    }
  });
});

// -------------------------------------------------------------------- explain

describe("explain", () => {
  it("returns the plan and a description", async () => {
    const { client } = makeClient(happyPath);
    const result = await client.explain(GOOD_QUERY);
    expect(result).toBeInstanceOf(Explanation);
    expect(result.plan.market).toBe("CRYPTO");
    expect(result.plan.timeframes).toEqual(["h1", "d"]);
    expect(result.plan.maxLookback).toBe(200);
    expect(result.plan.sources[1]?.minLookback).toBe(200);
    expect(String(result)).toMatch(/^Matches when/);
  });

  it("rejects on an invalid query", async () => {
    // Unlike validate, a 400 here is a bug, so it throws.
    const { client } = makeClient(responder(400, SYNTAX_ERROR));
    await expect(client.explain(BAD_OFFSET_QUERY)).rejects.toThrow(
      XQLSyntaxError,
    );
  });
});

// ------------------------------------------------------------------------ run

describe("run", () => {
  it("returns matches in query order", async () => {
    const { client } = makeClient(happyPath);
    const results = await client.run(GOOD_QUERY);
    expect(results).toBeInstanceOf(ResultSet);
    expect(results.symbols).toEqual(["SOLUSDT", "ADAUSDT"]);
    expect(results.length).toBe(2);
    expect(String(results)).toBe("ResultSet(2 matches: SOLUSDT, ADAUSDT)");
  });

  it("treats empty results as a normal outcome", async () => {
    const { client } = makeClient(responder(200, { results: [] }));
    const results = await client.run(GOOD_QUERY);
    expect(results.length).toBe(0);
    expect(results.isEmpty).toBe(true);
    expect([...results]).toEqual([]);
    expect(results.columnNames).toEqual([]);
  });

  it("keys columns by expression text", async () => {
    const { client } = makeClient(happyPath);
    const match = (await client.run(GOOD_QUERY)).at(0);
    expect(match?.value("rsi(14)")).toBe(24.8);
    expect(match?.has("volume")).toBe(true);
    expect(match?.get("missing")).toBeUndefined();
  });

  it("accepts an object that renders to XQL as a column key", async () => {
    const { client } = makeClient(happyPath);
    const rsi = { toXql: () => "rsi(14)" };
    const results = await client.run(GOOD_QUERY);
    expect(results.at(0)?.value(rsi)).toBe(24.8);
    expect(results.column(rsi)).toEqual([24.8, 27.1]);
  });

  it("points a missing column at the columns pragma", async () => {
    const { client } = makeClient(happyPath);
    const match = (await client.run(GOOD_QUERY)).at(0);
    const error = (() => {
      try {
        match?.value("sma(50)");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ColumnNotFoundError);
    expect(error).toBeInstanceOf(XcreenerError);
    const missing = error as ColumnNotFoundError;
    expect(missing.message).toMatch(/columns/);
    expect(missing.available).toEqual(["rsi(14)", "volume"]);
  });

  it("does not resolve prototype keys as columns", async () => {
    const { client } = makeClient(happyPath);
    const match = (await client.run(GOOD_QUERY)).at(0);
    expect(match?.has("constructor")).toBe(false);
    expect(match?.get("toString")).toBeUndefined();
  });

  it("slices and projects", async () => {
    const { client } = makeClient(happyPath);
    const results = await client.run(GOOD_QUERY);
    expect(results.slice(0, 1)).toBeInstanceOf(ResultSet);
    expect(results.slice(0, 1).symbols).toEqual(["SOLUSDT"]);
    expect(results.at(-1)?.symbol).toBe("ADAUSDT");
    expect(results.column("volume")).toEqual([512044.2, 118642.0]);
    expect(results.columnNames).toEqual(["rsi(14)", "volume"]);
    expect(results.toObjects()[0]).toEqual({
      symbol: "SOLUSDT",
      "rsi(14)": 24.8,
      volume: 512044.2,
    });
    for (const match of results) expect(match).toBeInstanceOf(Match);
  });

  it("returns frozen results", async () => {
    const { client } = makeClient(happyPath);
    const results = await client.run(GOOD_QUERY);
    expect(Object.isFrozen(results.matches)).toBe(true);
    expect(Object.isFrozen(results.at(0)?.columns)).toBe(true);
    expect(Object.isFrozen(results.raw)).toBe(true);
  });

  it("types column values from the generic", async () => {
    const { client } = makeClient(happyPath);
    const results = await client.run<{ "rsi(14)": number; volume: number }>(
      GOOD_QUERY,
    );
    const match = results.at(0);
    if (!match) throw new Error("expected a match");
    expectTypeOf(match.value("rsi(14)")).toEqualTypeOf<number>();
    expectTypeOf(match.get("volume")).toEqualTypeOf<number | undefined>();
    expectTypeOf(results.column("volume")).toEqualTypeOf<
      Array<number | undefined>
    >();
    // Compiled, never called: only the type error matters here.
    // @ts-expect-error: not a declared column
    const undeclared = () => match.value("sma(50)");
    expect(undeclared).toThrow(ColumnNotFoundError);
  });
});

// --------------------------------------------------------------------- errors

describe("errors", () => {
  it("parses the lookback ceiling out of a plan error", async () => {
    const { client } = makeClient(responder(400, PLAN_ERROR));
    const error = await rejection(client.run(LOOKBACK_QUERY));
    expect(error).toBeInstanceOf(XQLPlanError);
    const plan = error as XQLPlanError;
    expect(plan.isLookbackCeiling).toBe(true);
    expect([plan.requiredBars, plan.maxBars, plan.timeframe]).toEqual([
      366,
      300,
      "d",
    ]);
    expect(plan.query).toBe(LOOKBACK_QUERY);
    expect(plan.errorType).toBe("plan");
  });

  it("degrades gracefully on an unknown plan message", async () => {
    const payload = {
      valid: false,
      error: { type: "plan", message: "something else" },
    };
    const { client } = makeClient(responder(400, payload));
    const error = (await rejection(client.run(GOOD_QUERY))) as XQLPlanError;
    expect(error).toBeInstanceOf(XQLPlanError);
    expect(error.isLookbackCeiling).toBe(false);
    expect(error.requiredBars).toBeNull();
  });

  it("maps 401 to AuthenticationError", async () => {
    const { client } = makeClient(responder(401, { error: "Unauthorized" }));
    await expect(client.run(GOOD_QUERY)).rejects.toThrow(AuthenticationError);
  });

  it("maps 429 to QuotaExceeded with the reset time", async () => {
    // The 429 body carries a bare string, not the object shape a 400 uses.
    const { client } = makeClient(
      responder(
        429,
        { error: "Daily API rate limit exceeded" },
        { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1755043200" },
      ),
    );
    const error = (await rejection(client.run(GOOD_QUERY))) as QuotaExceeded;
    expect(error).toBeInstanceOf(QuotaExceeded);
    expect(error.resetAt).toEqual(new Date(1755043200 * 1000));
    expect(error.message).toMatch(/resets at/);
    expect(error.rawMessage).toBe("Daily API rate limit exceeded");
  });

  it("reads QuotaExceeded from the headers of the 429 itself", async () => {
    // usage() never populates rateLimit, so sourcing the reset from the last
    // run would report an unrelated time here, or nothing.
    const { client } = makeClient(
      responder(
        429,
        { error: "limit" },
        {
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": RESET_HEADER,
          "X-RateLimit-Limit": "1500",
        },
      ),
    );
    const error = (await rejection(client.usage())) as QuotaExceeded;
    expect(client.rateLimit).toBeNull();
    expect(error.resetAt?.getUTCFullYear()).toBe(2026);
    expect(error.limit).toBe(1500);
  });

  it("retries a 500, then throws UpstreamError", async () => {
    const { client, recorder } = makeClient(
      responder(500, { error: "database connection failed" }),
    );
    const error = await rejection(client.run(GOOD_QUERY));
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).statusCode).toBe(500);
    expect(recorder.requests).toHaveLength(2); // the attempt plus one retry
  });

  it("recovers when a retry succeeds", async () => {
    let calls = 0;
    const { client } = makeClient(() =>
      ++calls === 1 ? json(503, { error: "busy" }) : json(200, { valid: true }),
    );
    expect((await client.validate(GOOD_QUERY)).valid).toBe(true);
    expect(calls).toBe(2);
  });

  it.each([
    [400, SYNTAX_ERROR],
    [401, { error: "no" }],
    [429, { error: "no" }],
  ])("never retries a %i", async (status, payload) => {
    const { client, recorder } = makeClient(responder(status, payload));
    await expect(client.run(GOOD_QUERY)).rejects.toThrow(XcreenerError);
    expect(recorder.requests).toHaveLength(1);
  });

  it("wraps a transport failure and keeps the cause", async () => {
    const cause = new Error("connect ECONNREFUSED");
    const failure = new TypeError("fetch failed", { cause });
    const { client, recorder } = makeClient(() => {
      throw failure;
    });
    const error = (await rejection(client.run(GOOD_QUERY))) as TransportError;
    expect(error).toBeInstanceOf(TransportError);
    expect(error.cause).toBe(failure);
    expect(error.message).toMatch(/fetch failed \(connect ECONNREFUSED\)/);
    expect(recorder.requests).toHaveLength(2);
  });

  it("reports a non-JSON body clearly", async () => {
    const { client } = makeClient(
      () => new Response("<html>gateway</html>", { status: 200 }),
    );
    await expect(client.run(GOOD_QUERY)).rejects.toThrow(/Expected JSON/);
  });

  it("reports a JSON body that is not an object", async () => {
    const { client } = makeClient(responder(200, [1, 2, 3]));
    await expect(client.run(GOOD_QUERY)).rejects.toThrow(
      /Expected a JSON object, got array/,
    );
  });

  it("uses a plain-text error body as the message", async () => {
    const { client } = makeClient(
      () => new Response("Bad Gateway", { status: 502 }),
      { maxRetries: 0 },
    );
    await expect(client.run(GOOD_QUERY)).rejects.toThrow("Bad Gateway");
  });

  it("names each error class, so serialised logs stay readable", () => {
    const cases: Array<[XcreenerError, string]> = [
      [new XcreenerError("x"), "XcreenerError"],
      [new AuthenticationError("x"), "AuthenticationError"],
      [new QuotaExceeded("x"), "QuotaExceeded"],
      [new XQLError("x"), "XQLError"],
      [new XQLSyntaxError("x"), "XQLSyntaxError"],
      [new XQLPlanError("x"), "XQLPlanError"],
      [new UpstreamError("x"), "UpstreamError"],
      [new TransportError("x"), "TransportError"],
    ];
    for (const [error, name] of cases) {
      expect(error.name).toBe(name);
      expect(error.stack?.split("\n")[0]).toBe(`${name}: x`);
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("keeps the hierarchy instanceof-checkable", () => {
    expect(new XQLSyntaxError("x")).toBeInstanceOf(XQLError);
    expect(new XQLPlanError("x")).toBeInstanceOf(XcreenerError);
    expect(new QuotaExceeded("x")).not.toBeInstanceOf(XQLError);
  });
});

// ---------------------------------------------------------------------- quota

describe("quota", () => {
  it("spends no run call on a bad query when prechecking", async () => {
    const { client, recorder } = makeClient(responder(400, SYNTAX_ERROR), {
      precheck: true,
    });
    await expect(client.run(BAD_OFFSET_QUERY)).rejects.toThrow(XQLSyntaxError);
    expect(recorder.paths).toEqual(["/xql/validate"]);
  });

  it("lets precheck be turned on per call", async () => {
    const { client, recorder } = makeClient(happyPath);
    await client.run(GOOD_QUERY, { precheck: true });
    expect(recorder.paths).toEqual(["/xql/validate", "/xql/run"]);
  });

  it("lets precheck be turned off per call", async () => {
    const { client, recorder } = makeClient(happyPath, { precheck: true });
    await client.run(GOOD_QUERY, { precheck: false });
    expect(recorder.paths).toEqual(["/xql/run"]);
  });

  it("spends no run call when the API omits error detail", async () => {
    // The point of precheck is not spending quota on a query the API already
    // called invalid, detail or no detail.
    const { client, recorder } = makeClient(responder(200, { valid: false }), {
      precheck: true,
    });
    await expect(client.run(GOOD_QUERY)).rejects.toThrow(XQLError);
    expect(recorder.paths).toEqual(["/xql/validate"]);
  });

  it("reads the rate limit from run headers", async () => {
    const { client } = makeClient(happyPath);
    expect(client.rateLimit).toBeNull();
    await client.run(GOOD_QUERY);
    expect(client.rateLimit?.remaining).toBe(687);
    expect(client.rateLimit?.limit).toBe(1500);
    expect(client.rateLimit?.resetAt?.toISOString()).toBe(RESET_HEADER);
  });

  it("reports quota state from usage()", async () => {
    const { client } = makeClient(happyPath);
    const quota = await client.usage();
    expect([quota.tier, quota.limit, quota.remaining]).toEqual([
      "essential",
      1500,
      688,
    ]);
    expect(quota.exhausted).toBe(false);
    expect(quota.fractionUsed).toBeCloseTo(0.541, 3);
    expect(quota.resetAt?.toISOString()).toBe("2026-07-30T00:00:00.000Z");
  });

  it("reads an ISO time without an offset as UTC", async () => {
    const { client } = makeClient(
      responder(200, { tier: "free", resetAt: "2026-07-30T00:00:00" }),
    );
    const quota = await client.usage();
    expect(quota.resetAt?.toISOString()).toBe("2026-07-30T00:00:00.000Z");
  });
});

// ----------------------------------------------------------------- cancelling

describe("cancelling", () => {
  it("rejects with the signal's reason and does not retry", async () => {
    const controller = new AbortController();
    const reason = new Error("user navigated away");
    const { client, recorder } = makeClient(async () => {
      controller.abort(reason);
      throw new DOMException("aborted", "AbortError");
    });
    await expect(
      client.run(GOOD_QUERY, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(recorder.requests).toHaveLength(1);
  });

  it("does not start a request on an already-aborted signal", async () => {
    const { client, recorder } = makeClient(happyPath);
    await expect(
      client.usage({ signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(recorder.requests).toHaveLength(0);
  });

  it("turns a timeout into a TransportError", async () => {
    const { client } = makeClient(
      (request) =>
        new Promise<Response>((_, reject) => {
          // A fetch that only ends when its signal fires, as a hung
          // connection would.
          void request;
          setTimeout(
            () => reject(new DOMException("timed out", "TimeoutError")),
            20,
          );
        }),
      { timeout: 10, maxRetries: 0 },
    );
    const error = (await rejection(client.usage())) as TransportError;
    expect(error).toBeInstanceOf(TransportError);
    expect(error.message).toMatch(/timed out after 10ms/);
  });

  it("passes a signal to fetch on every attempt", async () => {
    const signals: unknown[] = [];
    const client = new Xcreener({
      apiKey: "test-key",
      fetch: async (_url, init) => {
        signals.push(init.signal);
        return json(200, { valid: true });
      },
    });
    await client.validate(GOOD_QUERY);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});

// --------------------------------------------------------------- key handling

const SECRET = "xcr_live_supersecret_abcd1234";

describe("key handling", () => {
  it("sends the key only as a bearer header", async () => {
    const { client, recorder } = makeClient(happyPath);
    await client.run(GOOD_QUERY);
    const request = recorder.last;
    expect(request.headers.authorization).toBe("Bearer test-key");
    // Never in the URL: query strings end up in access logs and proxy caches.
    expect(request.url).not.toContain("test-key");
    expect(request.body).not.toContain("test-key");
  });

  it("never exposes the key through any rendering of the client", () => {
    // Clients land in logs, REPL output and error-tracker breadcrumbs.
    const { client } = makeClient(happyPath, { apiKey: SECRET });
    expect(String(client)).not.toContain(SECRET);
    expect(JSON.stringify(client)).not.toContain(SECRET);
    expect(inspect(client, { showHidden: true, depth: 10 })).not.toContain(
      SECRET,
    );
    expect(Object.values(client).join(" ")).not.toContain(SECRET);
  });

  it.each([
    [400, SYNTAX_ERROR],
    [401, { error: "Unauthorized" }],
    [429, { error: "Daily API rate limit exceeded" }],
    [500, { error: "database connection failed" }],
  ])("never leaks the key into a %i error", async (status, payload) => {
    // Errors get logged and shipped to error trackers verbatim.
    const { client } = makeClient(responder(status, payload), {
      apiKey: SECRET,
      maxRetries: 0,
    });
    const error = await rejection(client.run(GOOD_QUERY));
    expect(error).toBeInstanceOf(XcreenerError);
    expect(inspect(error, { showHidden: true, depth: 10 })).not.toContain(
      SECRET,
    );
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });

  it("never leaks the key into a transport error", async () => {
    const { client } = makeClient(
      () => {
        throw new TypeError("fetch failed");
      },
      { apiKey: SECRET, maxRetries: 0 },
    );
    const error = await rejection(client.run(GOOD_QUERY));
    expect(inspect(error, { showHidden: true, depth: 10 })).not.toContain(
      SECRET,
    );
  });

  it("masks all but the last four in keyHint", async () => {
    const { client } = makeClient(happyPath, { apiKey: SECRET });
    expect(await client.keyHint()).toBe("...1234");
  });

  it("resolves a key provider on every request", async () => {
    // Supports rotation: regenerating a key invalidates the old one, so a
    // long-running process must be able to pick up the new one.
    const keys = ["first-key", "second-key"];
    const { client, recorder } = makeClient(happyPath, {
      apiKey: () => keys.shift() ?? "",
    });
    await client.validate(GOOD_QUERY);
    await client.validate(GOOD_QUERY);
    expect(recorder.requests.map((r) => r.headers.authorization)).toEqual([
      "Bearer first-key",
      "Bearer second-key",
    ]);
  });

  it("accepts an async key provider", async () => {
    const { client, recorder } = makeClient(happyPath, {
      apiKey: async () => "from-secret-manager",
    });
    await client.usage();
    expect(recorder.last.headers.authorization).toBe(
      "Bearer from-secret-manager",
    );
  });

  it("does not call the provider at construction", async () => {
    // A provider backed by a secret manager should be hit once per request,
    // not an extra time just because a client was built.
    const provider = vi.fn(() => "k");
    const { client } = makeClient(happyPath, { apiKey: provider });
    expect(provider).not.toHaveBeenCalled();
    await client.validate(GOOD_QUERY);
    expect(provider).toHaveBeenCalledOnce();
  });

  it("rejects an empty key from the provider", async () => {
    const { client } = makeClient(happyPath, { apiKey: () => "" });
    await expect(client.validate(GOOD_QUERY)).rejects.toThrow(/empty key/);
  });
});

// -------------------------------------------------------------------- runtime

describe("runtime", () => {
  it("refuses to run in a browser by default", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    expect(() => new Xcreener({ apiKey: "test-key" })).toThrow(/devtools/);
  });

  it("runs in a browser when explicitly allowed, without a User-Agent", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const { client, recorder } = makeClient(happyPath, {
      dangerouslyAllowBrowser: true,
    });
    await client.usage();
    expect(recorder.last.headers["user-agent"]).toBeUndefined();
  });

  it("exports a VERSION that matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
