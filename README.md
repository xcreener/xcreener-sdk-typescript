# xcreener-sdk-typescript

TypeScript client for the [XCREENER](https://xcreener.com) XQL HTTP API. Strings
in, typed objects out. Zero runtime dependencies.

```bash
npm install @xcreener/sdk
```

Runs on Node.js 20.19 or later, Bun, Deno, and edge runtimes such as
Cloudflare Workers: anywhere with a global `fetch`. It ships as an ES module;
on Node 20.19+ and 22.12+ CommonJS code can `require()` it too.

## Quickstart

```ts
import { Xcreener } from "@xcreener/sdk";

const xc = new Xcreener(); // reads XCREENER_API_KEY

const query = `
market = "CRYPTO"   # CRYPTO, FOREX, INDICES, COMMODITIES, METALS
timeframe = h1
let rsi14 = rsi(14)
columns = [rsi14, volume]
sort = volume desc
limit = 5

rsi14 < 30 and close > d::sma(200)
`;

for (const match of await xc.run(query)) {
  console.log(match.symbol, match.value("rsi14"), match.value("volume"));
}
```

Generate a key at [xcreener.com/account/api-key](https://xcreener.com/account/api-key).
The raw key is shown once, and generating a new one invalidates the old one
everywhere it is in use.

## The API key

The client takes it from the constructor, or falls back to
`$XCREENER_API_KEY`.

```ts
new Xcreener();                                   // $XCREENER_API_KEY
new Xcreener({ apiKey: "..." });                  // explicit, wins over the environment
new Xcreener({ apiKey: () => secrets.get("xc") }); // called per request, may be async
```

The function form is resolved on every request, so a rotated key is picked
up without building a new client. The key is never exposed through
`console.log`, `JSON.stringify`, or any error this package throws;
`await xc.keyHint()` gives a masked form that is safe to paste into a support
thread.

A pasted key with a stray newline or space is trimmed, and a key with
whitespace in the middle is rejected with a message saying it does not need
regenerating, rather than reaching the API as a confusing 401.

### Not in the browser

Constructing a client in a browser page throws by default, because any key
shipped to a browser is readable by anyone who opens devtools. Call the API
from a server you control. If the key is already meant to be visible to
whoever runs the page, pass `dangerouslyAllowBrowser: true`.

## The four calls

| Method              | Endpoint             | Metered | Resolves to        |
| ------------------- | -------------------- | ------- | ------------------ |
| `xc.validate(q)`    | `POST /xql/validate` | no      | `ValidationResult` |
| `xc.explain(q)`     | `POST /xql/explain`  | no      | `Explanation`      |
| `xc.run(q)`         | `POST /xql/run`      | **yes** | `ResultSet`        |
| `xc.usage()`        | `GET /usage`         | no      | `Quota`            |

Every call also accepts `{ signal }`, an `AbortSignal` that cancels the
request along with any retries still pending.

## Validation is a result, not an exception

Checking a query is the entire point of `validate`, so a failure resolves to a
value you narrow on rather than a rejection you have to catch. `run` and
`explain` reject on the same 400, because there it really is a bug.

```ts
const result = await xc.validate('market = "CRYPTO"\ntimeframe = h1\nrsi(14)[1] < 30');

if (!result.valid) {
  console.log(result.message);
  // Expected '-' (offset indexing uses the form [-N], e.g. [-1]) but found '1'
}

result.throwIfInvalid();
// XQLSyntaxError: line 3, column 9: Expected '-' (offset indexing uses the
// form [-N], e.g. [-1]) but found '1'
//
//     rsi(14)[1] < 30
//             ^
```

`ValidationResult` is a union of `ValidationSuccess` and `ValidationFailure`,
so inside `if (!result.valid)` TypeScript knows `result.error` and
`result.message` are the failure's.

## Errors

```
XcreenerError
├── AuthenticationError   401  key missing or unrecognized
├── QuotaExceeded         429  .resetAt .limit
├── XQLError              400  no data was fetched
│   ├── XQLSyntaxError         .line .column .offset, caret excerpt in .message
│   └── XQLPlanError           .requiredBars .maxBars .timeframe
├── UpstreamError         5xx  retried before throwing
├── TransportError             the request never completed; .cause has why
└── ColumnNotFoundError        match.value() on a column the query didn't return
```

Every error has `statusCode` and `rawMessage`. `message` is what gets printed,
so some classes decorate it (a caret excerpt, a reset time); `rawMessage` is
always the API's own words.

Plan errors parse themselves so you do not have to match on message text:

```ts
try {
  await xc.run('market = "CRYPTO"\ntimeframe = h1\nclose > d::highest(high, 365)');
} catch (error) {
  if (error instanceof XQLPlanError && error.isLookbackCeiling) {
    console.log(error.requiredBars, error.maxBars, error.timeframe); // 366 300 d
  }
}
```

Only 5xx and transport failures are retried. A 400 parses identically on a
retry, and a 429 has not refilled. A call you cancel through your own signal
rejects with the signal's reason, unwrapped, and is never retried.

## Results

`ResultSet` is an ordered, iterable collection of `Match`. The order is
meaningful: it reflects the query's own `sort` and `limit`. An empty result
set means the query is valid and nothing matches right now, which is not an
error.

```ts
const rs = await xc.run(query);

rs.symbols            // ["SOLUSDT", "ADAUSDT"]
rs.column("volume")   // [512044.2, 118642]
rs.columnNames        // ["rsi14", "volume"]
rs.at(0)?.value("rsi14") // 24.8
rs.isEmpty            // false
rs.toObjects()        // [{ symbol: "SOLUSDT", rsi14: 24.8, volume: 512044.2 }, ...]
```

Columns are keyed by exactly what you wrote in the `columns` pragma: `rsi14`
for the `let` binding above, `rsi(14)` had you listed the expression itself. A
condition's own inputs are not surfaced automatically, so if
`match.value("rsi14")` throws `ColumnNotFoundError`, the fix is almost always
adding it to `columns`. The error message says so. `match.get()` returns
`undefined` instead of throwing.

### Typed columns

Describe what your `columns` pragma returns and the values come back typed:

```ts
const rs = await xc.run<{ rsi14: number; volume: number }>(query);

const match = rs.at(0);
match?.value("rsi14");  // number
match?.value("sma50");  // type error: not a declared column
```

This is a type assertion about your query, not a runtime check.

## Quota

`validate` and `explain` are never metered. Only `run` counts against the
daily quota, so iterate for free and spend a run once the query does what you
want.

```ts
await xc.run(query, { precheck: true }); // free validate first; a bad query costs 0 quota
xc.rateLimit;                            // from the last run's headers, no extra request
await xc.usage();                        // free, and still answers at 429
```

Pass `new Xcreener({ precheck: true })` to make that the default in
development.

A query's syntax does not drift once it checks out, so there is nothing to
re-validate for a query that is fixed in your source: go straight to `run`.
It still throws `XQLSyntaxError` if the query is bad. All you trade away is
the guarantee that a malformed one costs zero quota, and you save a round
trip.

## Options

```ts
new Xcreener({
  apiKey: undefined,                  // or $XCREENER_API_KEY; string or () => string | Promise<string>
  baseUrl: "https://api.xcreener.com",
  timeout: 30_000,                    // milliseconds, per attempt
  maxRetries: 2,                      // 5xx and transport only
  precheck: false,
  fetch: undefined,                   // inject your own fetch
  dangerouslyAllowBrowser: false,
});
```

The client accepts anything with a `toXql()` method as well as a raw string,
both as a query and as a column key, so a future expression or builder layer
drops in without changing the transport.

## Coming from the Python SDK

The two packages mirror each other. The differences are the ones the
languages force:

| Python (`xcreener`)                 | TypeScript (`@xcreener/sdk`)                 |
| ----------------------------------- | -------------------------------------------- |
| `Xcreener(api_key=...)`             | `new Xcreener({ apiKey })`                   |
| synchronous calls                   | every call returns a Promise                 |
| `if not result:`                    | `if (!result.valid)`                         |
| `result.raise_for_error()`          | `result.throwIfInvalid()`                    |
| `match["rsi(14)"]` / `KeyError`     | `match.value("rsi(14)")` / `ColumnNotFoundError` |
| `rs[0]`, `rs[:3]`                   | `rs.at(0)`, `rs.slice(0, 3)`                 |
| `rs.to_dicts()`, `rs.to_pandas()`   | `rs.toObjects()`                             |
| `str(exc)`                          | `error.message`; `error.rawMessage` for the API's text |
| `timeout=30.0` (seconds)            | `timeout: 30_000` (milliseconds)             |
| `transport=httpx.Client(...)`       | `fetch: myFetch`                             |
| `xc.key_hint` property              | `await xc.keyHint()`, since the key may be async |
| `with Xcreener() as xc:`            | not needed: `fetch` holds no client to close |
| `to_xql()`                          | `toXql()`                                    |

## Contributing

Working on the SDK itself, running the test suite or cutting a release? See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
