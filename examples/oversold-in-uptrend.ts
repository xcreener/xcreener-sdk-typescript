/**
 * Screen crypto for oversold names still in a daily uptrend.
 *
 *     export XCREENER_API_KEY=...
 *     node examples/oversold-in-uptrend.ts
 *
 * Validate and explain are unmetered, so this script checks and inspects the
 * query for free and only then spends a single metered run call.
 */

import { QuotaExceeded, Xcreener, XQLError } from "@xcreener/sdk";

const QUERY = `
market = "CRYPTO"
timeframe = h1
columns = [rsi(14), volume]
sort = volume desc
limit = 5
rsi(14) < 30 and close > d::sma(200)
`;

// The column shape this query returns. A type assertion, not a runtime check.
type Columns = { "rsi(14)": number; volume: number };

const xc = new Xcreener();

const check = await xc.validate(QUERY);
if (!check.valid) {
  console.log(`Invalid query: ${check.message}`);
  process.exit(1);
}

const plan = await xc.explain(QUERY);
console.log(plan.explanation);
for (const source of plan.plan.sources) {
  console.log(`  ${source.timeframe}: ${source.minLookback} bars of history`);
}

try {
  const matches = await xc.run<Columns>(QUERY);

  if (matches.isEmpty) {
    console.log("\nNothing matches right now.");
  } else {
    console.log(`\n${matches.length} matches:`);
    for (const match of matches) {
      const rsi = match.value("rsi(14)").toFixed(1);
      const volume = Math.round(match.value("volume")).toLocaleString("en-US");
      console.log(`  ${match.symbol.padEnd(12)} rsi ${rsi}  vol ${volume}`);
    }
  }

  const remaining = xc.rateLimit?.remaining;
  if (remaining != null) console.log(`\n${remaining} runs left today.`);
} catch (error) {
  if (error instanceof QuotaExceeded || error instanceof XQLError) {
    console.log(error.message);
  } else {
    throw error;
  }
}
