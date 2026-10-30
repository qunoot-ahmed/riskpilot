# CLAUDE.md

RiskPilot is a minimal test impact analysis CLI for Vitest and Playwright projects. Keep it small and explainable.

## Commands

    npm run verify      typecheck plus all tests
    npm test            node:test on test/**/*.test.ts
    node src/cli.ts <repo> <base> [head] [--config file] [--json] [--output file]

## Layout

- src/cli.ts: argument parsing and wiring. The only module with side effects at import.
- src/git.ts: all Git access. Reads revisions with ls-tree and cat-file, never the working tree.
- src/analyze.ts: pure decision logic. Takes a snapshot, changes and config; returns the result.
- src/imports.ts, src/discover.ts, src/glob.ts, src/config.ts: small helpers used by analyze.
- src/report.ts: text and JSON output.
- examples/the-unsaid.riskpilot.json: mappings for the reference application.

## Rules

- Node 24 runs the TypeScript directly. Use erasable syntax only (no enums, no parameter properties) and import local files with the .ts extension.
- Strict TypeScript. No runtime dependencies; add a dev dependency only when clearly necessary.
- Safety first: anything that cannot be explained must fall back to the full suite, and every selection must carry a reason.
- Never modify an analysed repository. For demos, clone it into a temporary folder.
- Out of scope for now: dashboards, web apps, databases, AI agents, plugin systems, CI integration, benchmarking.
- Writing rules for Markdown: no backticks and no em or en dashes. Use indented code blocks.
- Do not commit or push without approval.
