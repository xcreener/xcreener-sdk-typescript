/**
 * Every failure mode the client can throw, and what to do about each.
 *
 *     export XCREENER_API_KEY=...
 *     node examples/handling-errors.ts
 */

import {
  AuthenticationError,
  QuotaExceeded,
  TransportError,
  UpstreamError,
  Xcreener,
  XQLPlanError,
  XQLSyntaxError,
} from "@xcreener/sdk";

// `[1]` is a parse error: offsets need a literal minus, as in `[-1]`.
const BAD_SYNTAX = `
market = "CRYPTO"
timeframe = h1
rsi(14)[1] < 30
`;

// Parses fine, but 365 daily bars exceeds the 300-bar lookback ceiling.
// The weekly form, `w::highest(high, 52)`, is the one that plans.
const BAD_PLAN = `
market = "CRYPTO"
timeframe = h1
close > d::highest(high, 365)
`;

const GOOD = `
market = "METALS"
timeframe = d
symbols = ["XAUUSD", "XAGUSD"]
columns = [close, rsi(14)]
sort = rsi(14) desc
close >= w::highest(high, 52)
`;

/** validate() reports rather than throws: checking is the point of it. */
async function checkFirst(xc: Xcreener, query: string): Promise<void> {
  const result = await xc.validate(query);
  console.log(result.valid ? "valid" : `invalid: ${result.message}`);
}

async function runAndReport(xc: Xcreener, query: string): Promise<void> {
  try {
    const matches = await xc.run(query);
    const symbols = matches.symbols.join(", ") || "none";
    console.log(`${matches.length} matches: ${symbols}`);
  } catch (error) {
    if (error instanceof XQLSyntaxError) {
      // message renders the offending line with a caret under the column.
      console.log(`Could not parse the query:\n${error.message}`);
    } else if (error instanceof XQLPlanError) {
      if (error.isLookbackCeiling) {
        console.log(
          `Needs ${error.requiredBars} bars of ${error.timeframe}, ` +
            `the ceiling is ${error.maxBars}. Use a coarser timeframe.`,
        );
      } else {
        console.log(`Could not plan the query: ${error.message}`);
      }
    } else if (error instanceof QuotaExceeded) {
      // validate() and explain() keep working while run() is exhausted, so
      // iterating on the query is still free until the reset.
      console.log(
        `Out of runs for today. Resets at ${error.resetAt?.toISOString()}.`,
      );
    } else if (error instanceof AuthenticationError) {
      console.log(
        "Key rejected. Check XCREENER_API_KEY. A key that was working " +
          "yesterday usually means it was regenerated somewhere else.",
      );
    } else if (error instanceof UpstreamError) {
      // Already retried before reaching here, so this is a real outage.
      console.log("The query planned but the server could not serve it.");
    } else if (error instanceof TransportError) {
      console.log(`Never reached the API: ${error.message}`);
    } else {
      throw error;
    }
  }
}

const xc = new Xcreener();

for (const [label, query] of [
  ["syntax error", BAD_SYNTAX],
  ["plan error", BAD_PLAN],
  ["valid query", GOOD],
] as const) {
  console.log(`\n--- ${label} ---`);
  await checkFirst(xc, query);
  await runAndReport(xc, query);
}
