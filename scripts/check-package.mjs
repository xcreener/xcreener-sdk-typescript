// Validates the package as it would be published: publint on the manifest,
// then arethetypeswrong on a real tarball.
//
// This packs the tarball itself instead of using `attw --pack`. Under
// `npm publish --dry-run`, npm exports npm_config_dry_run=true to every script
// it runs, so the `npm pack` that attw runs internally reports a filename but
// never writes the file, and attw fails with ENOENT. Packing here, into a
// temporary directory with dry-run forced off, works the same whether this
// runs on its own, from prepublishOnly, or under a dry-run publish.

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = { ...process.env, npm_config_dry_run: "false" };
const dir = mkdtempSync(join(tmpdir(), "xcreener-sdk-pack-"));

try {
  execSync("publint --strict", { stdio: "inherit", env });

  const output = execSync(`npm pack --json --pack-destination "${dir}"`, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [{ filename }] = JSON.parse(output);
  const tarball = join(dir, filename);

  execSync(`attw "${tarball}" --profile esm-only`, { stdio: "inherit", env });
} catch (error) {
  // The failing tool has already printed why; just carry its exit status.
  process.exitCode = typeof error.status === "number" ? error.status : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
