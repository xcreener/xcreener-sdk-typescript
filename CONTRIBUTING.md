# Contributing

## Development

```bash
git clone https://github.com/xcreener/xcreener-sdk-typescript
cd xcreener-sdk-typescript
npm ci

npm test            # no API key and no network needed
npm run typecheck   # src, tests and examples
npm run lint        # Biome: lint, formatting and import order
npm run format      # apply Biome's fixes
npm run check       # all three of the above
```

The test suite runs entirely against an in-memory `fetch`, so it never spends
quota and never needs a key. Type-level behaviour (the `ValidationResult`
narrowing, typed columns) is asserted with `expectTypeOf` and
`@ts-expect-error`, which `npm run typecheck` enforces.

Node 20.19 is the floor. CI runs the suite on 20, 22 and 24, so avoid APIs
newer than Node 20 in `src/`; `@types/node` is pinned to 20.x to make the
typechecker catch them.

### Running the examples

The examples import the package by name, which resolves to `dist/` through
the package's own `exports`, so build first:

```bash
npm run build
export XCREENER_API_KEY=...
node examples/oversold-in-uptrend.ts   # Node 22.18+ runs .ts directly
npx tsx examples/oversold-in-uptrend.ts   # any other version
```

### Checking the package itself

```bash
npm run build
npm run check:package   # publint + arethetypeswrong
npm pack --dry-run      # the exact file list that would ship
```

## Releasing

The version lives in `package.json`, and `src/version.ts` mirrors it so the
client can put it in its `User-Agent`. `npm version` keeps them in step:

1. In [CHANGELOG.md](CHANGELOG.md), retitle the top section to the new
   version and today's date, open a fresh `## Unreleased` above it, and
   commit.
2. `npm version 0.1.1` (or `patch` / `minor` / `major`). This bumps
   `package.json`, rewrites `src/version.ts` through the `version` script,
   commits both, and tags `v0.1.1`.
3. `git push --follow-tags`.

The publish workflow refuses to continue if the tag does not match
`package.json`, runs the full check suite, builds, validates the package with
publint and arethetypeswrong, installs the packed tarball into an empty
project to prove it imports, and publishes that same tarball via trusted
publishing. There is no npm token anywhere in the process. A version with a
prerelease suffix (`0.2.0-beta.1`) is published under the `next` dist-tag, so
it never becomes what `npm install @xcreener/sdk` picks.

Publishing rights, the trusted-publisher setup, and the dry-run rehearsal
path are in [MAINTAINING.md](MAINTAINING.md).
