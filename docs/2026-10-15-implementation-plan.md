---
title: acp-jury implementation plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-10-15
---

# acp-jury implementation plan

## TL;DR

Build the [specification](SPEC.md) in seven milestones, M0 to M6. Each milestone ends with tests that pass
without model calls, except the smoke tests of real adapters.

Status on 2026-10-16: M0 to M6 are implemented, with 76 tests on a scripted fake agent, and smoke tests with Claude
Code, Codex and Pi pass. See [Status](#status).

## Stack

- TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `noUncheckedSideEffectImports`), with `tsc --noEmit`
  as the gate and `tsc` for emit.
- Node.js 22 LTS, ES modules, `pnpm`, a committed lockfile, and `pnpm audit` in CI.
- `@agentclientprotocol/sdk` (1.8.0) for ACP, wrapped in `src/acp/` so that its types do not spread through the
  rest of the code.
- `zod` v4 for the configuration, board messages and votes. The caller's JSON Schema for a vote becomes a zod
  schema through `z.fromJSONSchema()`, so there is one validator.
- `commander` for the CLI.
- Plain `async` code, no `effect`: acp-jury is a CLI and a small library, and plain `async` is clearer here.
- `vitest` 4.1 for tests, against a scripted fake ACP agent. Not Vitest 5: the Stryker Vitest runner does not
  activate mutants under Vitest 5, which made the mutation gate pass nothing.
- StrykerJS for mutation tests on the core logic in `src/domain`.
- `eslint` with `typescript-eslint` strict type-checked rules, and `prettier`.
- Slophammer with `slophammer-ts`, pinned in CI, and `github-sane-defaults` on the repository.

## Milestones

### M0: repository standards

- `package.json`, `tsconfig.json`, eslint and prettier configuration, and `AGENTS.md` with the commands an agent
  must run before finishing: type check, lint, format check, tests and Slophammer.
- `slophammer.yml` and a CI workflow that runs all of these and `pnpm audit`.
- Done when CI passes on an empty `src/index.ts` and its test.

### M1: ACP session and the fake agent

- `src/agents/`: the registry, with one `AgentProfile` per built-in agent and the launch plan of a member.
- `src/acp/process.ts`: `AgentProcess`, the adapter process in its own process group.
- `src/acp/session.ts`: `AcpSession`: `initialize`, `session/new`, `session/set_config_option`, `session/prompt`,
  and `session/cancel` on time limit.
- `src/acp/client-app.ts`, `permissions.ts`, `filesystem.ts`: the client handlers, the permission policy and reads
  inside the member's folder; every `session/update` goes to `events.ndjson`.
- `test/fake-agent.ts`: an ACP agent that replays a script by round, so every later milestone tests without models.
- Done when the tests cover a normal turn, a time limit, a denied write, a crashed adapter and a failed start.

### M2: board, `blind` mode, votes and records

- `src/domain/`: vote checks, counting by `unanimous` or `majority`, the round state machine, the `ModeRules` of
  `blind`, prompts and the report.
- `src/run/`: `RunStore` (the run folder), `Workspace` (private copies), `Member` (a seat and its session), the turn
  protocol (one nudge, then `no_result`), the derived board, `RoundLoop`, and resume by run ID.
- `src/cli/`: `acp-jury run` and `acp-jury show`.
- Done when a blind run of three fake members gives the expected result, and a rerun after a stop resumes
  without repeating saved turns.

### M3: configuration levels

- `src/config/`: `members.json` and `juries/<name>.json` at the user level (`~/.acp-jury`,
  `ACP_JURY_HOME`, `--config-dir`) and the repo level (the nearest `.acp-jury`), where the repo file wins and
  files are never merged; jury overrides for one run, checked again; `acp-jury juries`.
- Done when tests cover both levels, a repo file that replaces a user file, overrides, and broken files.

### M4: real adapters

- Pin the latest `claude-agent-acp` and `codex-acp`, and `pi-acp`. On 2026-10-16 these are 0.91.0 (with Claude
  Code 2.1.300), 2.2.2 (with Codex 0.160) and 0.0.34.
- Run each member clean, through each adapter's own options, without copying any credential.
- One smoke test per adapter, run by hand and not in CI.
- Done when Claude Code with Opus 5.5, Codex with GPT-6 Astra and Pi with a Hugging Face router model each
  answer the smoke test, and `run.json` records each adapter version.

### M5: `discuss`

- The `discuss` `ModeRules`: a blind first round, then discussion rounds on the open items only, closing each item
  when its votes meet the rule, and stopping when no item is open or at `rounds` (default 5, lowest 5).
- Keep each member's blind and final vote per item, and each change of vote with its reason.
- Done when fake-agent tests cover agreement after the blind round (no discussion), agreement in round 2, a split
  left at the round limit, a changed vote with its reason, and a member with `no_result` in one round.

### M6: limits and backup

- Per-run limits: rounds, turn time, run time, and token totals from the adapters' reports.
- A key scan before any backup, and a backup hook.
- Done when tests cover a stop at each limit and a blocked backup.

## Status

Smoke tests on 2026-10-16, with a one-file Python folder and yes-or-no items, through the built CLI:

- `blind` with Claude Code (Opus 5.5), Codex (GPT-6 Astra, low effort) and Pi (DeepSeek V4.1 Flash through the
  Hugging Face router): all three answered, agreed on the two code items, and split on one item that asked whether
  the member got standing instructions from the user. Claude Code and Pi said no, Codex said yes. This matches the
  clean flags in `run.json`: Claude Code and Pi run clean, Codex does not.
- `discuss` with the same three members on that split item: six rounds, every member kept its true answer, and the
  item went to a person at the round limit. A run took 2 minutes 42 seconds.
- Findings that changed the code: Codex reads files with shell commands, so its profile allows commands inside
  its own read-only sandbox, and a refusal now prefers Codex's `decline` over `cancel`, which ended the turn. Pi
  gets Hugging Face models from an extension, so a Pi member can name the extensions to load.

## Risks

- The adapters change fast. Pinning keeps runs repeatable; each version bump gets a smoke test.
- `pi-acp` 0.0.34 is built on ACP SDK 0.26, and acp-jury uses SDK 1.8. The Pi smoke test passed with them.
- Codex cannot run clean without copying its login. The run records Codex members as not clean.
- Discussion can push members to agree on a wrong answer. Keeping each blind vote makes this visible.
- Long folders cost time and tokens per member. Limits per run stop a runaway run.
