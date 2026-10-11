/**
 * Typed objects returned by the client.
 *
 * Each one is built from the API's JSON by a static `fromJSON`, and each keeps
 * a frozen `raw` copy of the payload it was parsed from, so a field this
 * library does not know about yet is never lost.
 *
 * @module
 */

import {
  ColumnNotFoundError,
  XQLError,
  XQLPlanError,
  XQLSyntaxError,
} from "./errors.js";
import {
  asArray,
  asInt,
  asIntOrNull,
  asObject,
  asString,
  isObject,
  type JsonObject,
  parseTimestamp,
  snapshot,
} from "./internal/parse.js";

export type { JsonObject };

/**
 * Anything that renders itself to XQL text.
 *
 * Structural, so a future expression or builder layer satisfies it just by
 * having a `toXql()` method: it never has to import or extend anything from
 * here. That same method is what lets an expression object stand in for a
 * column key on {@link Match} and {@link ResultSet}.
 */
export interface SupportsXQL {
  toXql(): string;
}

/** A column key: the literal expression text, or an object that renders to it. */
export type ColumnKey = string | SupportsXQL;

/**
 * The shape of a match's columns, keyed by expression text.
 *
 * Pass your own to `run<C>()` to get typed values back. That is a type
 * assertion about what your query returns, not a runtime check.
 */
export type Columns = Record<string, unknown>;

/**
 * Normalise a column key.
 *
 * The API keys `columns` by the literal expression text (`"rsi(14)"`), so an
 * expression object only has to render canonically for a lookup to resolve.
 */
function columnKey(key: ColumnKey): string {
  if (typeof key === "string") return key;
  if (typeof key?.toXql === "function") return String(key.toXql());
  return String(key);
}

/** 1-based line and column, plus a 0-based character offset. */
export class Position {
  constructor(
    readonly line: number,
    readonly column: number,
    readonly offset: number,
  ) {}

  static fromJSON(data: unknown): Position | null {
    if (!isObject(data) || Object.keys(data).length === 0) return null;
    return new Position(
      asInt(data.line),
      asInt(data.column),
      asInt(data.offset),
    );
  }
}

/**
 * The `error` object from a 400 response.
 *
 * `position` is present for `type === "syntax"` and absent for
 * `type === "plan"`.
 */
export class XQLErrorDetail {
  constructor(
    readonly type: string,
    readonly message: string,
    readonly position: Position | null = null,
    readonly raw: JsonObject = {},
  ) {}

  static fromJSON(data: unknown): XQLErrorDetail {
    const obj = asObject(data);
    return new XQLErrorDetail(
      asString(obj.type, "unknown"),
      asString(obj.message),
      Position.fromJSON(obj.position),
      snapshot(obj),
    );
  }

  /** Build the matching error, without throwing it. */
  toError(query: string | null = null): XQLError {
    if (this.type === "syntax") {
      return new XQLSyntaxError(this.message, {
        line: this.position?.line ?? null,
        column: this.position?.column ?? null,
        offset: this.position?.offset ?? null,
        query,
        statusCode: 400,
      });
    }
    if (this.type === "plan") {
      return new XQLPlanError(this.message, { query, statusCode: 400 });
    }
    return new XQLError(this.message, { query, statusCode: 400 });
  }
}

/** A query that parsed and planned. See {@link ValidationResult}. */
export class ValidationSuccess {
  readonly valid = true;
  readonly error = null;

  constructor(readonly query: string) {}

  /** Always `null` for a valid query. */
  get message(): null {
    return null;
  }

  /** Does nothing for a valid query, and returns it for chaining. */
  throwIfInvalid(): this {
    return this;
  }
}

/** A query the API rejected. See {@link ValidationResult}. */
export class ValidationFailure {
  readonly valid = false;

  constructor(
    /** The API's error object, or `null` if it sent none. */
    readonly error: XQLErrorDetail | null,
    readonly query: string,
  ) {}

  /** The raw error message from the API, unparaphrased. */
  get message(): string | null {
    return this.error?.message ?? null;
  }

  /** The matching {@link XQLError}, built but not thrown. */
  toError(): XQLError {
    if (this.error) return this.error.toError(this.query);
    return new XQLError(
      "Query reported invalid, but the API returned no error detail.",
      { query: this.query, statusCode: 400 },
    );
  }

  /**
   * Throw the matching {@link XQLError}.
   *
   * An invalid result always throws, even when the API supplied no error
   * object to build a specific error from. Returning quietly here would let
   * `run({ precheck: true })` spend the metered call it exists to save.
   */
  throwIfInvalid(): never {
    throw this.toError();
  }
}

/**
 * Outcome of `/xql/validate`.
 *
 * A failed validation is a *normal outcome* here, not an exception: checking
 * is the entire point of the call. Narrow on `valid`:
 *
 * ```ts
 * const result = await xc.validate(query);
 * if (!result.valid) console.log(result.message);
 * ```
 *
 * Call `throwIfInvalid()` if you would rather have the error.
 */
export type ValidationResult = ValidationSuccess | ValidationFailure;

/** One timeframe's data requirement, as reported by the planner. */
export class Source {
  constructor(
    readonly timeframe: string,
    readonly series: readonly string[],
    readonly minLookback: number,
  ) {}

  static fromJSON(data: unknown): Source {
    const obj = asObject(data);
    return new Source(
      asString(obj.timeframe),
      Object.freeze(asArray(obj.series).map((s) => asString(s))),
      asInt(obj.minLookback),
    );
  }
}

/** The data-requirements manifest for a query. */
export class Plan {
  constructor(
    readonly market: string,
    readonly sources: readonly Source[],
    readonly raw: JsonObject = {},
  ) {}

  static fromJSON(data: unknown): Plan {
    const obj = asObject(data);
    return new Plan(
      asString(obj.market),
      Object.freeze(asArray(obj.sources).map((s) => Source.fromJSON(s))),
      snapshot(obj),
    );
  }

  get timeframes(): string[] {
    return this.sources.map((s) => s.timeframe);
  }

  /**
   * Largest bar requirement across sources. The 300-bar ceiling applies per
   * timeframe, so this is a headroom indicator, not the check itself.
   */
  get maxLookback(): number {
    return this.sources.reduce((max, s) => Math.max(max, s.minLookback), 0);
  }
}

/**
 * Outcome of `/xql/explain`: the plan plus a mechanical description.
 *
 * `explanation` renders the query back in near-XQL prose (for example
 * "Matches when rsi(14) < 30"). It is a sanity check on what the query does,
 * not a trader-facing translation.
 */
export class Explanation {
  constructor(
    readonly plan: Plan,
    readonly explanation: string,
    readonly raw: JsonObject = {},
  ) {}

  static fromJSON(data: unknown): Explanation {
    const obj = asObject(data);
    return new Explanation(
      Plan.fromJSON(obj.plan),
      asString(obj.explanation),
      snapshot(obj),
    );
  }

  toString(): string {
    return this.explanation;
  }
}

/** One instrument that satisfied the query. */
export class Match<C extends Columns = Columns> {
  constructor(
    readonly symbol: string,
    /** Column values keyed by the literal expression text. */
    readonly columns: Readonly<C>,
  ) {}

  static fromJSON<C extends Columns = Columns>(data: unknown): Match<C> {
    const obj = asObject(data);
    return new Match<C>(
      asString(obj.symbol),
      Object.freeze({ ...asObject(obj.columns) }) as C,
    );
  }

  /**
   * A column's value. Throws {@link ColumnNotFoundError} if the query did not
   * return that column, with a message pointing at the `columns` pragma.
   */
  value<K extends keyof C & string>(key: K): C[K];
  value(key: SupportsXQL): unknown;
  value(key: ColumnKey): unknown {
    const name = columnKey(key);
    if (!Object.hasOwn(this.columns, name)) {
      throw new ColumnNotFoundError({
        symbol: this.symbol,
        column: name,
        available: Object.keys(this.columns).sort(),
      });
    }
    return this.columns[name];
  }

  /** A column's value, or `undefined` if the query did not return it. */
  get<K extends keyof C & string>(key: K): C[K] | undefined;
  get(key: SupportsXQL): unknown;
  get(key: ColumnKey): unknown {
    const name = columnKey(key);
    return Object.hasOwn(this.columns, name) ? this.columns[name] : undefined;
  }

  /** Whether the query returned this column. */
  has(key: ColumnKey): boolean {
    return Object.hasOwn(this.columns, columnKey(key));
  }

  /** `{ symbol, ...columns }`, a plain object for logging or serialising. */
  toObject(): { symbol: string } & C {
    return { symbol: this.symbol, ...this.columns } as { symbol: string } & C;
  }
}

/**
 * Outcome of `/xql/run`: an ordered, iterable collection of matches.
 *
 * Order is meaningful. It reflects the query's own `sort` and `limit`, or
 * scan order when the query omits `sort`. An empty result set means the query
 * is valid and nothing currently matches, which is not an error.
 */
export class ResultSet<C extends Columns = Columns>
  implements Iterable<Match<C>>
{
  readonly matches: readonly Match<C>[];
  readonly raw: JsonObject;

  constructor(matches: Iterable<Match<C>>, raw: JsonObject = {}) {
    this.matches = Object.freeze([...matches]);
    this.raw = raw;
  }

  static fromJSON<C extends Columns = Columns>(data: unknown): ResultSet<C> {
    const obj = asObject(data);
    return new ResultSet<C>(
      asArray(obj.results).map((m) => Match.fromJSON<C>(m)),
      snapshot(obj),
    );
  }

  get length(): number {
    return this.matches.length;
  }

  get isEmpty(): boolean {
    return this.matches.length === 0;
  }

  [Symbol.iterator](): Iterator<Match<C>> {
    return this.matches[Symbol.iterator]();
  }

  /** The match at `index`. Negative indexes count from the end. */
  at(index: number): Match<C> | undefined {
    return this.matches.at(index);
  }

  /** A new result set over part of this one, sharing the same `raw`. */
  slice(start?: number, end?: number): ResultSet<C> {
    return new ResultSet(this.matches.slice(start, end), this.raw);
  }

  get symbols(): string[] {
    return this.matches.map((m) => m.symbol);
  }

  /** Column keys present, in first-match order. */
  get columnNames(): string[] {
    const first = this.matches[0];
    return first ? Object.keys(first.columns) : [];
  }

  /** One column's values across every match, in result order. */
  column<K extends keyof C & string>(key: K): Array<C[K] | undefined>;
  column(key: SupportsXQL): unknown[];
  column(key: ColumnKey): unknown[] {
    const name = columnKey(key);
    return this.matches.map((m) =>
      Object.hasOwn(m.columns, name) ? m.columns[name] : undefined,
    );
  }

  /** Every match as `{ symbol, ...columns }`. */
  toObjects(): Array<{ symbol: string } & C> {
    return this.matches.map((m) => m.toObject());
  }

  toString(): string {
    return `ResultSet(${this.length} matches: ${this.symbols.slice(0, 5).join(", ")})`;
  }
}

/** Outcome of `GET /usage`. Free to call, and works at 429. */
export class Quota {
  constructor(
    readonly tier: string,
    readonly limit: number,
    readonly used: number,
    readonly remaining: number,
    readonly resetAt: Date | null = null,
    readonly raw: JsonObject = {},
  ) {}

  static fromJSON(data: unknown): Quota {
    const obj = asObject(data);
    return new Quota(
      asString(obj.tier),
      asInt(obj.limit),
      asInt(obj.used),
      asInt(obj.remaining),
      parseTimestamp(obj.resetAt),
      snapshot(obj),
    );
  }

  get exhausted(): boolean {
    return this.remaining <= 0;
  }

  get fractionUsed(): number {
    return this.limit ? this.used / this.limit : 0;
  }
}

/** Anything with a case-insensitive `get`, or a plain header record. */
export type HeadersLike =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | undefined>>;

function readHeader(headers: HeadersLike, name: string): string | null {
  if (typeof headers.get === "function") {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const record = headers as Readonly<Record<string, string | undefined>>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name && value !== undefined) return value;
  }
  return null;
}

/**
 * Quota state read from the headers on the last `/xql/run` response.
 *
 * Cheaper than a `usage()` call, because every run already carries it.
 */
export class RateLimit {
  constructor(
    readonly remaining: number | null = null,
    readonly resetAt: Date | null = null,
    readonly limit: number | null = null,
  ) {}

  /** `null` when none of the three rate-limit headers is present. */
  static fromHeaders(headers: HeadersLike): RateLimit | null {
    const remaining = readHeader(headers, "x-ratelimit-remaining");
    const reset = readHeader(headers, "x-ratelimit-reset");
    const limit = readHeader(headers, "x-ratelimit-limit");
    if (remaining === null && reset === null && limit === null) return null;
    return new RateLimit(
      asIntOrNull(remaining),
      parseTimestamp(reset),
      asIntOrNull(limit),
    );
  }
}
