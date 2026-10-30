# RiskPilot

RiskPilot is a small command line tool for explainable test impact analysis. Give it a Git repository and two revisions, and it tells you which Vitest and Playwright test files the change can affect, why each one was chosen, and when it is not safe to choose at all.

The analysed repository is only read. RiskPilot reads both revisions straight from Git objects, so it never touches the working tree.

## Requirements

Node.js 24. There are no runtime dependencies; TypeScript runs directly through Node type stripping.

    npm install

## Usage

    node src/cli.ts <repo> <base> [head] [--merge-base] [--config <file>] [--json] [--output <file>] [--markdown <file>]

The head revision defaults to HEAD. With --merge-base, the comparison starts at the merge base of base and head, which is what a pull request changes. Without --config, RiskPilot reads riskpilot.config.json from the head revision when it exists. A change to that file triggers the full suite, because new mappings cannot vouch for themselves.

    node src/cli.ts ../the-unsaid-app HEAD~1 HEAD --config examples/the-unsaid.riskpilot.json
    node src/cli.ts ../my-app main feature/cart --merge-base --output impact.json --markdown impact.md

Exit codes: 0 on success, 1 on an error such as an unknown revision, an invalid config or no merge base, 2 on invalid arguments. On an error, the --output file contains {"status": "error", "error": "..."} and the --markdown file says the analysis failed, so a failure is never mistaken for a selection. A successful JSON result has "status": "ok".

## Continuous integration

RiskPilot runs in observation mode in the CI of The Unsaid: a pull request job recommends test files and explains them, while every existing job still runs every test. The job:

- checks out the pull request head with full history and RiskPilot at a pinned, reviewed commit SHA, without persisted credentials;
- installs nothing and runs no pull request code, because RiskPilot has no runtime dependencies and only reads Git objects;
- runs the CLI with --merge-base against the base and head SHAs of the pull request;
- publishes the Markdown summary as the job summary and uploads the JSON, Markdown and text reports as an artifact;
- fails visibly when analysis fails, and fails if the analysed checkout was changed.

See .github/workflows/ci.yml in The Unsaid for the job. It reports selected versus total test files only; nothing is skipped yet, so it saves no time.

## How a decision is made

Each changed file is classified in this order:

1. Full suite trigger: dependency manifests, lockfiles, tsconfig, Vitest, Vite and Playwright configs. Everything runs.
2. Test file: a changed test is selected. A deleted test needs nothing.
3. Explicit mapping: config rules that connect files to tests that reach them without imports, such as a page and the Playwright spec that visits it.
4. Import dependency: every test whose import graph reaches the file, through relative imports and tsconfig path aliases.
5. Ignored: matches an ignore pattern (documentation by default) and no test imports it. No test impact.

If a file is explained by none of these, the result falls back to the full suite. That covers an unmapped code file no test imports, an unmapped non code file such as CSS, and a deleted source file. A rename is checked against both its old and new path. When in doubt, RiskPilot runs more, not less.

Uncertainty in the import graph is handled conservatively. A file has an incomplete graph when one of its imports cannot be resolved, or when it loads modules through a computed path such as import(name), require(name) or import.meta.glob. A bare import only counts as an npm package when the root package.json declares it, or when it is a Node built in, so an alias RiskPilot could not read is treated as unresolved rather than ignored. Any test that reaches an incomplete file is selected whenever the decision relies on mappings or imports, with the reason "selected conservatively".

The output lists the decision, the fallback reasons, every changed file with its classification, every selected test with its reasons (for example "imports src/money.ts through src/cart.ts"), and the Vitest and Playwright commands to run.

## Configuration

A JSON file. Every list extends the defaults.

    {
      "ignore": [".github/**"],
      "fullSuiteTriggers": ["next.config.ts"],
      "aliases": { "@/*": ["src/*"] },
      "mappings": [
        {
          "name": "Wall route",
          "changed": ["src/app/wall/**", "src/modules/confessions/**"],
          "tests": ["tests/e2e/wall.spec.ts"],
          "reason": "these browser tests visit /wall"
        }
      ]
    }

Patterns support "**", "*" and "?". A pattern without a slash matches the file name in any folder. Aliases are read from the root tsconfig.json automatically; the aliases field is only needed when that file contains comments.

See examples/the-unsaid.riskpilot.json for a complete mapping of a Next.js application.

## Development

    npm run typecheck
    npm test
    npm run verify

Tests use the built in node:test runner. test/cli.e2e.test.ts builds a temporary Git repository and runs the real CLI against it.

## Limitations

- Imports are found with regular expressions. Imports inside comments count, which only selects more tests. Computed imports are detected but not followed; the tests that reach them are selected conservatively.
- Only the root tsconfig.json and root package.json are read. Aliases from an extended tsconfig, project references and workspace packages are not followed; their imports count as unresolved, which selects more tests rather than fewer.
- Test files are discovered by name (.test or .spec). Tests matched by a custom Vitest include or Playwright testMatch with other names are not discovered, so they are never selected individually. A change to those config files does trigger the full suite.
- Dependencies outside the import graph, such as Vitest setup files, global setup, environment variables and fixtures read at runtime, are only covered by the fallback for untraced files or by explicit mappings. A wrong or too narrow mapping is trusted as written.
- Tests that read files from disk (fixtures, snapshots, source scanners) are invisible to the import graph and need mappings.
- Selection works at file level, not at test case level.
- The diff compares the two revisions directly. For a pull request, pass the merge base as the base revision.
- Deleted and unmapped files always trigger the full suite, even when the real impact is small.
