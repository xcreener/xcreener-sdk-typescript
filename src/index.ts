/**
 * TypeScript client for the XCREENER XQL HTTP API. Strings in, typed objects
 * out.
 *
 * ```ts
 * import { Xcreener } from "@xcreener/sdk";
 *
 * const xc = new Xcreener(); // reads XCREENER_API_KEY
 *
 * const matches = await xc.run(`
 *   market = "CRYPTO"
 *   timeframe = h1
 *   columns = [rsi(14), volume]
 *   sort = volume desc
 *   limit = 5
 *   rsi(14) < 30 and close > d::sma(200)
 * `);
 *
 * for (const match of matches) {
 *   console.log(match.symbol, match.value("rsi(14)"));
 * }
 * ```
 *
 * @packageDocumentation
 */

export {
  type ApiKeyLike,
  type ApiKeyProvider,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  type FetchInitLike,
  type FetchLike,
  type FetchResponseLike,
  type QueryLike,
  type RequestOptions,
  type RunOptions,
  Xcreener,
  type XcreenerOptions,
} from "./client.js";
export {
  AuthenticationError,
  ColumnNotFoundError,
  type ColumnNotFoundErrorOptions,
  QuotaExceeded,
  type QuotaExceededOptions,
  TransportError,
  UpstreamError,
  XcreenerError,
  type XcreenerErrorOptions,
  XQLError,
  type XQLErrorOptions,
  type XQLErrorType,
  XQLPlanError,
  XQLSyntaxError,
  type XQLSyntaxErrorOptions,
} from "./errors.js";
export {
  type ColumnKey,
  type Columns,
  Explanation,
  type HeadersLike,
  type JsonObject,
  Match,
  Plan,
  Position,
  Quota,
  RateLimit,
  ResultSet,
  Source,
  type SupportsXQL,
  ValidationFailure,
  type ValidationResult,
  ValidationSuccess,
  XQLErrorDetail,
} from "./models.js";
export { VERSION } from "./version.js";
