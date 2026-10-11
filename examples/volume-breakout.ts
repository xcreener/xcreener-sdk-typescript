/**
 * Volume breakout screen, with typed columns and a table of results.
 *
 * Shows `let` bindings, ranking with `sort`/`limit`, and reading columns back
 * off each match.
 *
 *     export XCREENER_API_KEY=...
 *     node examples/volume-breakout.ts
 */

import { Xcreener } from "@xcreener/sdk";

// `let` names an intermediate expression so it can be reused in the body.
// Note that `columns` is what decides which values come back: the condition's
// own inputs are not surfaced automatically, so `volume` and `avgv` are listed
// explicitly even though the body already references both.
const QUERY = `
market = "CRYPTO"
timeframe = h4
let avgv = avg(volume, 20)
columns = [volume, avgv, rsi(14)]
sort = volume desc
limit = 10
volume > avgv * 2 and close > highest(high, 20)
`;

// Keys are the literal text in `columns`: the `let` name for a binding, the
// expression itself otherwise.
type Columns = { volume: number; avgv: number; "rsi(14)": number };

const xc = new Xcreener();
const matches = await xc.run<Columns>(QUERY);

if (matches.isEmpty) {
  console.log("No breakouts on this bar.");
} else {
  for (const match of matches) {
    const ratio = match.value("volume") / match.value("avgv");
    console.log(
      `${match.symbol.padEnd(12)} ${ratio.toFixed(1).padStart(5)}x avg volume` +
        `   rsi ${match.value("rsi(14)").toFixed(1).padStart(5)}`,
    );
  }

  // Column keys are the literal expression text, so this works for any
  // expression you put in `columns`, arithmetic included.
  console.log("\nvolume column:", matches.column("volume"));

  // Plain objects, ready for console.table, a CSV writer, or a dataframe lib.
  console.table(
    [...matches.toObjects()].sort((a, b) => a["rsi(14)"] - b["rsi(14)"]),
  );
}
