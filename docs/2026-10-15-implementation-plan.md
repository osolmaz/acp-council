---
title: acp-council implementation plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-10-15
---

# acp-council implementation plan

## TL;DR

Build the [specification](SPEC.md) in six milestones. Each milestone ends with tests that pass without model calls,
except the smoke tests of real adapters. The first real use is a review of the 123 planted defects of the
Legal Benchmarks execution-version pilot by Claude Opus 5.5 and GPT-6 Astra.

## Stack

- TypeScript on Node 22, ES modules, `pnpm`.
- `@agentclientprotocol/sdk` for ACP; `ajv` for JSON Schema; no other runtime dependency without a reason.
- Tests with `node:test`, against a scripted fake ACP agent.
- Slophammer with `slophammer-ts`, pinned in CI, and `github-sane-defaults` on the repository.

## Milestones

### M0: repository standards

- `package.json`, `tsconfig.json`, `AGENTS.md` with the commands an agent must run before finishing.
- `slophammer.yml` and a CI workflow that runs `slophammer-ts`, the type check and the tests.
- Done when CI passes on an empty `src/index.ts` and its test.

### M1: ACP client and the fake agent

- `src/acp/client.ts`: start an adapter, `initialize`, `session/new`, `session/prompt`, `session/cancel` on time
  limit, record every `session/update` to `events.ndjson`.
- `src/acp/policy.ts`: the `read` and `exec` permission policies, and read-only file access inside the member's
  folder.
- `test/fake-agent.ts`: an ACP agent that replays a script, so every later milestone tests without models.
- Done when the tests cover a normal turn, a time limit, a denied write, a crashed adapter and a malformed update.

### M2: board, `panel` mode, votes and records

- `src/board.ts`: append-only `board.jsonl`, visibility by `to`, anonymous labels.
- `src/vote.ts`: JSON Schema check, one nudge, `no_result`.
- `src/modes/panel.ts`, `src/count.ts`: one blind round, counting by `majority`, `unanimous` or threshold, splits.
- `src/run.ts`: the run folder, `run.json`, `result.json`, `report.md`, resume by run ID.
- `src/cli.ts`: `acp-council run --mode panel` and `acp-council show`.
- Done when a panel of three fake members gives the expected result, and a rerun after a stop resumes without
  repeating saved turns.

### M3: real adapters

- Pin `claude-agent-acp`, `codex-acp` and `pi-acp`. Pick a `claude-agent-acp` version whose bundled Claude Code
  supports Claude Opus 5.5 (2.1.280 or newer).
- Run each member clean, through each adapter's own options, without copying any credential.
- One smoke test per adapter, run by hand and not in CI: a one-line question about a one-file folder.
- Done when Claude Code with Opus 5.5, Codex with GPT-6 Astra and Pi with a Hugging Face router model each
  answer the smoke test, and `run.json` records each adapter version.

### M4: `discuss` and `debate`

- Rounds with a barrier, and round-robin with a rotating order.
- `discuss`: blind first round, public rounds, stop at agreement or the round limit; keep first and final votes.
- `debate`: sides per item, round-robin, closing statements, optional private cross-examination, and a moderator
  or a person at the end.
- Done when fake-agent tests cover agreement in round 2, no agreement by the limit, a changed vote, a direct
  message that only its recipient sees, and rotation of the speaking order.

### M5: `check`, backup and limits

- `check`: each item goes to a member of a family that did not raise it.
- A key scan before any upload, and a backup hook.
- Per-run limits: rounds, turns, time, and token totals from the adapters' reports.
- Done when tests cover a check with no member of another family (recorded, not hidden), a blocked upload, and a
  stop at each limit.

### M6: first use

- Review the 123 planted defects of the Legal Benchmarks execution-version pilot (`legalbenchmarks/dev`,
  `datasets/execution-version`) with the `top` tier, Claude Opus 5.5 and GPT-6 Astra, in `panel` mode: keep, fix
  or drop for each defect and its rubric item.
- Run `discuss` on the splits only, and compare first and final votes.
- Score `panel` and `discuss` on the Legal Benchmarks defect eval, which holds a person's decisions on flagged
  defects, before choosing a default mode for that project.

## Risks

- The adapters change fast. Pinning keeps runs repeatable; each version bump gets a smoke test.
- Running members clean may not be possible for every adapter without copying credentials. The run then records
  the member as not clean, and we raise it with the adapter's maintainers.
- Discussion can push members to agree on a wrong answer. Keeping each first, blind vote makes this visible.
- Long folders cost time and tokens per member. Limits per run stop a runaway run.
