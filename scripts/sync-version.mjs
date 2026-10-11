// Copies the version from package.json into src/version.ts.
//
// Runs from the `version` lifecycle script, so `npm version <x>` bumps both
// files in the same commit it tags. Run by hand after editing package.json
// directly: `node scripts/sync-version.mjs`.

import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
);
const target = new URL("src/version.ts", root);
const source = readFileSync(target, "utf8");
const updated = source.replace(
  /export const VERSION = "[^"]*";/,
  `export const VERSION = "${version}";`,
);

if (updated === source && !source.includes(`"${version}"`)) {
  console.error("Could not find the VERSION constant in src/version.ts");
  process.exit(1);
}
writeFileSync(target, updated);
console.log(`src/version.ts -> ${version}`);
