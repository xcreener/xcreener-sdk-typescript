# Changelog

## Unreleased

## 0.1.0 (2026-10-11)

First public release. A TypeScript port of
[xcreener-sdk-python](https://github.com/xcreener/xcreener-sdk-python) 0.1.0,
with the same behaviour and the differences the language forces.

### Added

- `Xcreener`, the client, covering all four endpoints: `validate()`,
  `explain()`, `run()` and `usage()`. Every call returns a Promise and accepts
  an `AbortSignal`. Queries are sent as raw request bodies, never
  JSON-wrapped.
- Typed results as classes built by `fromJSON`: `ValidationResult`,
  `Explanation`, `ResultSet`, `Match`, `Quota`, `RateLimit`. Each keeps a
  frozen `raw` copy of the payload it was parsed from, so an unrecognised
  field is never dropped.
- `run<C>()` takes an optional column shape, so `match.value("rsi(14)")` is
  typed as whatever the query's `columns` pragma returns.
- An error hierarchy under `XcreenerError` that separates a wrong query
  (`XQLError`, `XQLSyntaxError`, `XQLPlanError`) from a wrong account
  (`AuthenticationError`, `QuotaExceeded`) from a wrong server
  (`UpstreamError`, `TransportError`). Every class sets `name`, and every
  error carries `statusCode` and the API's unmodified `rawMessage`.
- `XQLSyntaxError` renders a caret excerpt under the reported column in its
  `message`, and `XQLPlanError` exposes `requiredBars` / `maxBars` /
  `timeframe` so the lookback ceiling can be handled without matching on
  message text.
- `ValidationResult` is a union of `ValidationSuccess` and
  `ValidationFailure`, narrowed on `valid`. An invalid query resolves rather
  than rejects, since checking is the point of the call;
  `throwIfInvalid()` converts it when an error is what you wanted.
- `run(q, { precheck: true })`, and the client-level `precheck` default,
  spend a free `validate()` first so a malformed query costs no quota.
- `rateLimit` reads quota state from the last run's response headers, with no
  extra request.
- API keys accepted as a string or as a function, sync or async, the latter
  resolved per request so rotation needs no new client. The key lives in a
  private field and never appears in `console.log`, `JSON.stringify`, or any
  error this package throws; `keyHint()` gives a masked form.
- Pasted keys are trimmed and checked for stray whitespace, which turns a
  misleading 401 into a message saying the key does not need regenerating.
- `Match.value()` throws `ColumnNotFoundError` naming the columns that were
  returned and pointing at the `columns` pragma; `Match.get()` returns
  `undefined` instead.
- `ResultSet.toObjects()` for logging, tables and serialisation.
- `SupportsXQL`, a structural interface, so anything with a `toXql()` method
  works as a query or a column key without importing from this package.
- Retries for 5xx and transport failures only, with exponential backoff and
  jitter. A 400 parses identically on a retry and a 429 has not refilled, so
  neither is retried. A call cancelled through the caller's own signal is
  never retried either.
- Construction in a browser page is refused unless
  `dangerouslyAllowBrowser: true` is passed, since the key would be readable
  by anyone with devtools.
- Zero runtime dependencies. ES module with bundled type declarations,
  checked by `publint` and `arethetypeswrong` before every publish.

### Not ported

- `to_pandas()`. There is no single dataframe library to target in
  JavaScript; `toObjects()` feeds any of them.
- The context-manager protocol. `fetch` holds no connection pool for the
  client to close.
