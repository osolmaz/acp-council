# AGENTS.md

acp-council asks a council of coding agents one question about a folder, over the Agent Client Protocol. The design
is in [docs/SPEC.md](docs/SPEC.md).

## Before you finish

Run all of these and make them pass:

```sh
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run coverage
pnpm run build
pnpm run mutate
npx --yes slophammer-ts@0.5.0 dry .
npx --yes slophammer-ts@0.5.0 check .
```

The tests use the scripted fake agent in `test/fake-agent.ts` and make no model calls. Do not add tests that call a
real model.

## Rules

- TypeScript is strict. Do not use `any`, unchecked casts or non-null assertions. Parse unknown input with `zod` at
  the boundary: configuration files, saved records and agent replies.
- Each function stays at complexity 8 or less. Coverage stays at 85% or more.
- Keep the module boundaries in `slophammer.yml` and the design in [docs/SPEC.md](docs/SPEC.md#architecture):
  `src/domain` is pure council logic with no IO, and modes are `ModeRules` in `src/domain/modes.ts`; `src/config`
  reads the configuration; `src/agents` holds one profile per built-in agent; `src/acp` owns the adapter process
  and the ACP session; `src/run` runs a council and writes the records; `src/cli` is the command line.
- Add or change a dependency only with a reason. Pin exact versions and commit the lockfile.
- Pin adapter versions in the agent profiles in `src/agents/`. Bump one only after a smoke test with the real agent.
- acp-council never copies a credential. A member that cannot run clean without one is recorded as not clean.
- Keep the repository free of project-specific content. It is a general tool.

## Cover

`assets/cover.svg` is generated. Change `scripts/make_cover.py`, then run it with the Yodel Grotesk fonts from
`osolmaz/yodel-grotesk` and DejaVu Sans Mono:

```sh
uv run --with fonttools --with uharfbuzz --with pillow python scripts/make_cover.py <yodel-grotesk fonts> <dejavu fonts>
```

The terminal in the cover shows the output of a real run, made before the tool was renamed from acp-jury; only the
command and the report folder show the new name. Replace it only with the output of another real run.

Slophammer standards apply: <https://github.com/osolmaz/slophammer/blob/main/docs/AGENT_ENTRYPOINT.md>.
