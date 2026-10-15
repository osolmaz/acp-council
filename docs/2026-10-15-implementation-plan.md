---
title: acp-council implementation plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-10-15
---

# acp-council implementation plan

## TL;DR

Build the [specification](SPEC.md) in seven milestones, M0 to M6. Each milestone ends with tests that pass
without model calls, except the smoke tests of real adapters. The stack follows Onur's TypeScript defaults
(`ts-defaults`). The first real use is a `discuss` review of the 123 planted defects of the Legal Benchmarks
execution-version pilot by Claude Opus 5.5 and GPT-6 Astra.

## Stack

- TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `noUncheckedSideEffectImports`), with `tsc --noEmit`
  as the gate and `tsc` for emit.
- Node.js 22 LTS, ES modules, `pnpm`, a committed lockfile, and `pnpm audit` in CI.
- `@agentclientprotocol/sdk` (1.8.0) for ACP, wrapped in `src/acp/` so that its types do not spread through the
  rest of the code.
- `zod` v4 for the configuration, board messages and votes. The caller's JSON Schema for a vote becomes a zod
  schema through `z.fromJSONSchema()`, so there is one validator.
- `commander` for the CLI.
- Plain `async` code, no `effect`: acp-council is a CLI and a small library, and plain `async` is clearer here.
- `vitest` for tests, against a scripted fake ACP agent.
- `eslint` with `typescript-eslint` strict type-checked rules, and `prettier`.
- Slophammer with `slophammer-ts`, pinned in CI, and `github-sane-defaults` on the repository.

## Milestones

### M0: repository standards

- `package.json`, `tsconfig.json`, eslint and prettier configuration, and `AGENTS.md` with the commands an agent
  must run before finishing: type check, lint, format check, tests and Slophammer.
- `slophammer.yml` and a CI workflow that runs all of these and `pnpm audit`.
- Done when CI passes on an empty `src/index.ts` and its test.

### M1: ACP client and the fake agent

- `src/acp/client.ts`: start an adapter, `initialize`, `session/new`, `session/prompt`, `session/cancel` on time
  limit, record every `session/update` to `events.ndjson`.
- `src/acp/policy.ts`: the `read` and `exec` permission policies, and read-only file access inside the member's
  folder.
- `test/fake-agent.ts`: an ACP agent that replays a script, so every later milestone tests without models.
- Done when the tests cover a normal turn, a time limit, a denied write, a crashed adapter and a malformed update.

### M2: board, `blind` mode, votes and records

- `src/board.ts`: append-only `board.jsonl`, visibility per round, anonymous labels.
- `src/vote.ts`: items, the vote schema check, one nudge, `no_result`.
- `src/modes/blind.ts`, `src/count.ts`: one blind round, counting by `unanimous` or `majority`, splits.
- `src/run.ts`: the run folder, `run.json`, `result.json`, `report.md`, resume by run ID.
- `src/cli.ts`: `acp-council run --mode blind` and `acp-council show`.
- Done when a blind run of three fake members gives the expected result, and a rerun after a stop resumes
  without repeating saved turns.

### M3: real adapters

- Pin the latest `claude-agent-acp` and `codex-acp`, and `pi-acp`. On 2026-10-16 these are 0.91.0 (with Claude
  Code 2.1.300), 2.2.2 (with Codex 0.160) and 0.0.34.
- Run each member clean, through each adapter's own options, without copying any credential.
- One smoke test per adapter, run by hand and not in CI: a one-line question about a one-file folder.
- Done when Claude Code with Opus 5.5, Codex with GPT-6 Astra and Pi with a Hugging Face router model each
  answer the smoke test, and `run.json` records each adapter version.

### M4: `discuss`

- `src/modes/discuss.ts`: a blind first round, then discussion rounds on the open items only, closing each item
  when its votes meet the rule, and stopping when no item is open or at `--rounds` (default 5, lowest 5).
- Keep each member's blind and final vote per item, and each change of vote with its reason.
- Done when fake-agent tests cover agreement after the blind round (no discussion), agreement in round 2, a split
  left at the round limit, a changed vote with its reason, and a member with `no_result` in one round.

### M5: limits and backup

- Per-run limits: rounds, turns, time, and token totals from the adapters' reports.
- A key scan before any upload, and a backup hook.
- Done when tests cover a stop at each limit and a blocked upload.

### M6: first use

- Review the 123 planted defects of the Legal Benchmarks execution-version pilot (`legalbenchmarks/dev`,
  `datasets/execution-version`) with the `top` tier, Claude Opus 5.5 and GPT-6 Astra, in `discuss` mode: keep,
  fix or drop for each defect and its rubric item. The blind round gives the blind result, and the discussion
  covers only the splits.
- Score the blind votes and the final votes on the Legal Benchmarks defect eval, which holds a person's decisions
  on flagged defects, before choosing a default mode for that project.

## Risks

- The adapters change fast. Pinning keeps runs repeatable; each version bump gets a smoke test.
- `pi-acp` 0.0.34 is built on ACP SDK 0.26, and acp-council uses SDK 1.8. The Pi smoke test checks that they work
  together.
- Running members clean may not be possible for every adapter without copying credentials. The run then records
  the member as not clean, and we raise it with the adapter's maintainers.
- Discussion can push members to agree on a wrong answer. Keeping each blind vote makes this visible.
- Long folders cost time and tokens per member. Limits per run stop a runaway run.
