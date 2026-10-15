<p align="center"><img src="assets/banner.svg" alt="acp-council" width="100%"></p>

# acp-council

Ask a council of coding agents one question about a folder, and get their votes, their discussion and a full
record of the run.

Each member is a real agent, such as Claude Code, Codex or Pi, that reads the folder with its own tools.
acp-council talks to the members over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). Members
never talk to each other directly: every message goes through one board, and acp-council decides who sees what and
when. A person makes the final decision; the council advises.

## Modes

| Mode | What happens |
| --- | --- |
| `blind` | Every member votes alone, and code counts the votes. |
| `discuss` | Every member votes alone first. Then the members talk about the items they disagree on, and vote again, until they agree or a round limit (at least 5) is reached. Items that are still split go to a person. |

## Requirements

- Node.js 22.18 or newer, and pnpm.
- Each agent you use, installed and logged in: Claude Code, Codex, or Pi with the providers you need.
  acp-council starts each agent's ACP adapter with `npx` and never copies a login.

## Install

```bash
git clone https://github.com/osolmaz/acp-council
cd acp-council
pnpm install
pnpm run build
pnpm link --global
```

## Set up a council

Name your members once, in `~/.acp-council/members.json`:

```json
{
  "opus": { "agent": "claude", "model": "opus" },
  "astra": { "agent": "codex", "model": "gpt-6-astra", "options": { "reasoning_effort": "high" } }
}
```

`model` is a value from the agent's model list, or its display name. When the value is wrong, the error lists the
models that the agent offers.

Then name a council in your repository, in `.acp-council/councils/review.json`, so that everyone runs the same one:

```json
{ "mode": "discuss", "members": ["opus", "astra"], "schema": "review.schema.json" }
```

`review.schema.json`, next to it, is the JSON Schema for one item's vote:

```json
{
  "type": "object",
  "properties": { "choice": { "enum": ["yes", "no"] }, "reason": { "type": "string" } },
  "required": ["choice", "reason"]
}
```

Either level can hold either file. When both levels have a file with the same name, the repository file wins.
The [specification](docs/SPEC.md#configuration) lists every field.

## Run it

```bash
acp-council run review --dir ./folder --question question.md --items items.json
```

`items.json` lists what the council votes on:

```json
[
  { "id": "bug", "text": "The function returns the mean of a non-empty list." },
  { "id": "empty", "text": "Calling it with an empty list raises an exception." }
]
```

Without `--items`, the council votes once, on the item `answer`. Each member works in its own copy of the folder;
the folder itself never changes.

```bash
acp-council show .acp-council/runs/<run id>   # print the report
acp-council councils                           # list the councils and where each one comes from
```

Flags such as `--mode`, `--members`, `--rounds` and `--rule` change a council for one run. A rerun with the same
`--run-id` resumes a stopped run and skips the turns that are already saved.

## What a run leaves

Each run has its own folder, by default under the `runs/` folder next to the council's configuration:

| File | Contents |
| --- | --- |
| `report.md` | the split items first, then the agreed items, with every member's blind and final vote and reason |
| `result.json` | the same, as data, with the stop reason |
| `board.jsonl` | every message the members posted |
| `run.json` | the question, the resolved council, which label is which model, adapter versions and input hashes |
| `members/<label>/` | each turn's prompts and answers, every ACP event, and the adapter's error output |

Members see each other only as `member:A`, `member:B` and so on.

## Clean members

acp-council runs each member without your own instructions, skills and extensions when the agent allows it, and
records in `run.json` when it does not:

| Agent | Clean | How |
| --- | --- | --- |
| Claude Code | yes | no setting sources: no settings, CLAUDE.md files or skills |
| Pi | yes | no extensions, skills, context files or prompt templates; a member can list the extension files to load |
| Codex | no | Codex keeps the login and your instructions in the same folder, and acp-council does not copy logins |

## Use it from TypeScript

```ts
import { configDirs, resolveCouncil, runCouncil } from "acp-council";

const dirs = await configDirs({ cwd: process.cwd(), env: process.env });
const council = await resolveCouncil("review", dirs);
const { result } = await runCouncil({ council, folder: "./folder", question: "Is it correct?", outDir: "./runs" });
```

## Development

See [AGENTS.md](AGENTS.md) for the checks to run, and [docs/SPEC.md](docs/SPEC.md) for the design.

## License

[MIT](LICENSE)
