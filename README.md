# bumpcheck

Prove whether a dependency bump breaks the code that imports it.

Dependabot or Renovate opens a pull request bumping `zod` from 3 to 4. bumpcheck
reads the type declarations of both versions and your source, then reports
three kinds of facts, each with a file and line:

- a symbol you import was removed,
- a call you make no longer typechecks against the new declarations,
- a symbol you import changed, and whether your uses still typecheck.

Anything it cannot prove is listed as "could not be checked". It never guesses
and it never says "safe".

```
$ bumpcheck zod 3.23.8 4.1.12 --repo ./my-app

zod 3.23.8 -> 4.1.12
You import 3 symbols from zod. 2 breaks in 2 symbols, 1 changed but still typechecks. Behavior not checked.

BREAKS
  ZodError  Property 'errors' does not exist on type 'ZodError<unknown>'.
    src/schema.ts:15:25  (TS2339)
  ZodTypeAny  Property 'typeName' does not exist on type '$ZodTypeDef'.
    src/schema.ts:21:22  (TS2339)
```

In the common case the whole output is one line:

```
You import 5 symbols from axios. None changed. Behavior not checked.
```

## Install

```
npm install -g bumpcheck
```

Requires Node 20 or newer and `npm` on your PATH. bumpcheck fetches both
versions of the bumped package into its own cache. Run it with the repo's
other dependencies installed: types from them, such as a tRPC wrapper around
react-query, are part of what can break. Without `node_modules` the report
says how many imports could not be resolved.

Each run analyzes one project root under that directory's `tsconfig.json`.
`--since` picks the right directory for each bumped `package.json`. Nested
packages that share a `package.json` but have their own `tsconfig.json` are
not yet discovered. A `tsconfig.json` that only lists `references`, as Vite
templates do, is followed: the referenced projects are analyzed as one program
with the first one's options, and the report says so.

## Use

```
bumpcheck <package> <from> <to> [--repo <dir>] [--format text|markdown|json]
```

Exit code is 1 when at least one break is found, 0 otherwise, 2 on error.
Pass `--no-fail` to always exit 0.

`--format markdown` produces a pull request comment. `--format json` emits the
full report, documented in [src/types.ts](src/types.ts), for other tools.

## In a pull request

`bumpcheck --since <ref>` finds every direct dependency whose version changed
between a git ref and HEAD, in any `package.json` in the repo, and checks each
one in its own directory. That makes the CI step one line, and it works for
repos with more than one project, such as an API at the root and a web app in
`web/`.

```yaml
name: bumpcheck
on:
  pull_request:
    paths: ['**/package.json', '**/package-lock.json']
permissions:
  contents: read
  pull-requests: write
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci --ignore-scripts
      - name: bumpcheck
        id: run
        run: |
          npx bumpcheck --since origin/${{ github.base_ref }} --format markdown --json-out report.json > comment.md \
            || echo "failed=1" >> "$GITHUB_OUTPUT"
          unknown=$(node -p 'const r=[].concat(require("./report.json")); r.reduce((n,x)=>n+x.summary.unknown+x.summary.unanalyzed,0)' 2>/dev/null || echo 0)
          if [ "$unknown" != "0" ]; then
            echo "::warning title=bumpcheck::$unknown import(s) could not be checked; see the pull request comment"
          fi
      - uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: bumpcheck
          path: comment.md
      - name: Fail on breaks
        if: steps.run.outputs.failed == '1'
        run: exit 1
```

The job fails when any package reported a break, after the comment is
posted. Imports that could not be checked keep the job green and add a
warning annotation, so a green check means "no proven break", not "safe".
If more than one project needs `npm ci`, add a step per directory.

## How it works

1. Both versions are installed with `npm install --ignore-scripts` into a
   per-version cache. When the package's own dependencies are also installed
   in your repo at a version that satisfies its declared range, those copies
   are used, as npm's dedupe would. Otherwise two copies of a shared type
   such as `@nestjs/common` would disagree with each other.
2. Two TypeScript programs are built over your repo, identical except that
   every import of the package resolves to one version or the other.
3. Every import of the package is collected: named, default, namespace
   member access, `require()` destructuring, subpaths, and type-only imports.
4. Each imported symbol's declaration is tokenized and compared between
   versions. Comments and formatting do not count.
5. Type errors are collected in the importing files for both programs. Errors
   present only with the new version are the breaks. Your pre-existing errors
   cancel out.
6. Each break is attributed to an imported symbol by the error message, the
   import binding in the failing expression, or a type declared under that
   import. The report says which.

If your repo has a `tsconfig.json`, its options are used, so a break is a
break under your own settings. Without one, bumpcheck uses strict defaults with
`checkJs` so plain JavaScript repos are analyzed too.

## What it does not do

- It does not check runtime behavior. A function with the same signature can
  still behave differently. The footer of every report says so.
- It does not analyze packages that ship no type declarations. The report says
  so instead of reporting zero breaks.
- It does not follow dynamic `import()`, `export * from`, or a namespace
  passed around as a value. Those appear under "not analyzed".
- It does not fix anything, read changelogs, or decide whether to merge.

## Accuracy

[corpus/](corpus/) pins real Dependabot pull requests from public repos at
their base commit and runs bumpcheck on each bump. A `--oracle` mode then
installs the new version into the checkout and runs the repo's own `tsc`; the
new errors it reports are the ground truth.

Results so far, from [corpus/results.md](corpus/results.md). Four of the
pull requests needed a human to change code before merging, which tests the
case that matters: does the tool stay quiet when it should not?

| bump | bumpcheck | tsc oracle | what the human changed |
|---|---|---|---|
| zod 3.23.8 → 4.6.5, 36-file API merged without CI | 79 breaks | 84 new errors | nothing; the repo has not compiled since |
| zod 3.25.76 → 4.6.7, MCP server | 6 breaks | 6 new errors | the schema the 6 test errors pointed at |
| react-query 4 → 5, 20-hook app | 20 breaks | 28 new errors | 16 hunks, 13 of them at reported lines |
| react-query 4 → 5, Electron app | 3 breaks | 3 new errors | 1 of the 3 sites; the other 2 landed via a separate PR |
| msw 1 → 2, tests outside tsconfig | 0, with a note that 1 importing file is outside tsconfig | 0 | the test files tsc does not see |
| 6 bumps that needed no code changes | 0 breaks each | 0 new errors each | nothing |

Every gap between the two columns is TypeScript's "implicitly has an 'any'
type" follow-on errors, which bumpcheck folds into the root error on the
same statement. On root causes the lists match, file and line.

Two lessons from the corpus are now part of the tool: run with the repo's
dependencies installed, because types from other packages carry the bumped
package's types, and say so when files that import the package sit outside
the tsconfig.

Eleven cases is a start, not a statistic. Add one with a pull request URL and
a base commit in [corpus/cases.json](corpus/cases.json) and run
`npx tsx corpus/run.ts --oracle`.

## Status

Early. npm with TypeScript declarations is the only ecosystem. The report
schema is versioned and will stay backwards compatible within a major.

## Development

```
npm install
npm test
npm run dev -- zod 3.23.8 4.1.12 --repo ../some-app
```

Tests run offline against fixture packages in `test/fixtures`. Add a case by
planting a change in `demo-lib-v2` and a use in `consumer`, then asserting the
exact file and line.

## License

Apache-2.0
