/**
 * Run a batch of screens without blowing the daily quota.
 *
 * Only `run` is metered. `validate`, `explain` and `usage` are free, so this
 * checks every query for free first and stops before it runs out of runs.
 *
 *     export XCREENER_API_KEY=...
 *     node examples/quota-aware-batch.ts
 */

import { QuotaExceeded, Xcreener } from "@xcreener/sdk";

const SCREENS: Record<string, string> = {
  "oversold in uptrend": `
    market = "CRYPTO"
    timeframe = h1
    columns = [rsi(14), volume]
    sort = volume desc
    limit = 5
    rsi(14) < 30 and close > d::sma(200)
  `,
  "golden cross this week": `
    market = "CRYPTO"
    timeframe = d
    let x = crossover(ema(50), ema(200))
    columns = [close, rsi(14), x]
    sort = rsi(14) desc
    limit = 20
    x or x[-1] or x[-2]
  `,
  "bollinger squeeze": `
    market = "FOREX"
    timeframe = h1
    columns = [bb_upper(20, 2), bb_lower(20, 2), atr(14)]
    sort = atr(14) asc
    limit = 10
    (bb_upper(20, 2) - bb_lower(20, 2)) / bb_mid(20, 2) < 0.01
  `,
};

// Leave a few runs in the tank for ad-hoc work later in the day.
const RESERVE = 5;

const xc = new Xcreener();

// Free: reject bad queries before any of them costs a run.
const runnable: Array<[string, string]> = [];
for (const [name, query] of Object.entries(SCREENS)) {
  const result = await xc.validate(query);
  if (result.valid) {
    runnable.push([name, query]);
  } else {
    console.log(`skipping "${name}": ${result.message}`);
  }
}

const quota = await xc.usage();
const budget = Math.max(quota.remaining - RESERVE, 0);
console.log(
  `\n${quota.remaining}/${quota.limit} runs left on ${quota.tier}, ` +
    `spending at most ${budget}`,
);
if (budget < runnable.length) {
  console.log(
    `Only running the first ${budget} of ${runnable.length} screens.`,
  );
}

for (const [name, query] of runnable.slice(0, budget)) {
  try {
    const matches = await xc.run(query);
    const symbols = matches.isEmpty ? "nothing" : matches.symbols.join(", ");
    console.log(`\n${name}: ${symbols}`);
  } catch (error) {
    if (error instanceof QuotaExceeded) {
      // The reserve is a guess, the header is the truth.
      console.log(`\nStopped early: ${error.message}`);
      break;
    }
    throw error;
  }
}

// Read from the last run's headers, so this costs no extra request.
if (xc.rateLimit) console.log(`\n${xc.rateLimit.remaining} runs left.`);
