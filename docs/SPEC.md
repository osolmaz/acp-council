# acp-jury specification

## TL;DR

acp-jury is an LLM jury whose members are coding agents. It asks them one question and records how they vote. Each member
is a real agent (Claude Code, Codex, Pi) that reads the folder with its own tools. acp-jury talks to them over
the Agent Client Protocol (ACP). The members never talk to each other directly: every message goes through one
board, and the runtime decides who sees what and when. There are two modes. In `blind`, each member votes alone.
In `discuss`, each member votes alone first, and then the members talk about the items they disagree on until
they agree or a round limit is reached. A person makes the final decision; the jury advises.

A user names members once, in a user configuration folder, and names juries (a mode, members and rules) in a
repository or in the user folder. Then `acp-jury run <jury> --dir <folder>` runs it.

## Goals

- One command and one TypeScript API: a question, a read-only folder, the items to vote on, a vote schema and a
  set of members.
- Members that are agents, not chat completions, so they can open long Word files, spreadsheets and PDFs.
- Two ways to combine members: blind votes, and a discussion after the blind votes.
- Named, versioned jury configurations, so a project runs the same jury every time.
- Full records of every run, so a run can be audited, resumed and replayed.
- A small core that follows the acpx architecture without depending on acpx: the runtime owns sessions, records
  and replay; the agents own the reasoning.

## Non-goals

- Not a general agent framework or workflow engine.
- Not for tasks that change files. Members advise; they do not edit the folder they review.
- Not a benchmark runner.
- No web interface in the first version.

## Terms

| Term | Meaning |
| --- | --- |
| jury | a named configuration: a mode, members and rules |
| member | one agent with one model, such as Claude Code with Claude Opus 5.5 |
| agent profile | how acp-jury starts a built-in agent: its pinned adapter, and how it runs clean and read-only |
| question | the prompt that the jury answers |
| item | one thing that the jury votes on; a question with no item list has one item, `answer` |
| folder | the read-only material that the members read |
| board | the list of every member message in a run |
| message | one post on the board, with its sender, its text and its vote |
| round | one step in which every member takes one turn |
| turn | one ACP prompt to one member and its full answer, plus at most one nudge |
| vote | a choice and a reason for each item, checked against the run's schema |
| split | an item on which the votes do not meet the run's rule |
| mode | the rules that decide how many rounds there are, who sees which message, and what each round asks |
| result | the counted votes, the splits and the full board, for a person to decide on |

## Architecture

```text
     acp-jury run <jury> --dir <folder>             (src/cli)
                     |
          config: user + repo levels                (src/config)   members.json, juries/<name>.json
                     |
                  runJury                           (src/run)      run folder, seats, round loop, records
            /        |          \
   mode rules    jury state    seats                (src/domain)   blind | discuss, counting, prompts, report
                     |
              member sessions                       (src/acp)      process, ACP session, permissions, file reads
                     | ACP over stdio (JSON-RPC)
      +--------------+---------------+
 claude-agent-acp    codex-acp      pi-acp          (src/agents)   one profile per built-in agent
   (Claude Code)      (Codex)        (Pi)
```

The modules and what each one owns:

| Module | Owns | Depends on |
| --- | --- | --- |
| `src/domain` | pure jury logic: types, vote checks, counting, the round state machine, the mode rules, prompts and the report | nothing |
| `src/config` | the two configuration levels, file schemas and jury resolution | nothing |
| `src/agents` | the agent registry: one `AgentProfile` per built-in agent, and the launch plan of a member | `config` |
| `src/acp` | `AgentProcess` (the adapter process and its process group), `AcpSession` (initialize, session, options, prompt, cancel), the client handlers, the permission policy and reads inside the member's folder | `agents`, `util` |
| `src/run` | `runJury`: the run folder (`RunStore`), the members' private copies (`Workspace`), seats (`Member`), the turn protocol (prompt, then one nudge), the `RoundLoop`, limits, resume and outputs | all of the above |
| `src/cli` | the command line | `config`, `run` |

`slophammer.yml` enforces these boundaries.

### Agent profiles

A built-in agent is an `AgentProfile` in `src/agents/`: its pinned adapter package, and a function that returns
how a member session runs under a permission level. A member that gives only a `command` is a custom agent; its
session runs with no profile settings and is recorded as clean `unknown`.

| Agent | Adapter (latest on 2026-10-16) | Runs clean by | Read-only by |
| --- | --- | --- | --- |
| `claude` | `@agentclientprotocol/claude-agent-acp@0.91.0` (Claude Code 2.1.300) | `settingSources: []`: no user or project settings, CLAUDE.md files or skills | only the `Read`, `Grep` and `Glob` tools |
| `codex` | `@agentclientprotocol/codex-acp@2.2.2` (Codex 0.160) | not possible without copying the login: Codex reads its home folder, which holds both the login and the user's instructions, so the member is recorded as not clean | Codex's own `read-only` sandbox mode; commands are allowed, because Codex reads files with shell commands and its sandbox blocks writes and network access |
| `pi` | `pi-acp@0.0.34` | a wrapper that starts `pi` with `--no-extensions --no-skills --no-context-files --no-prompt-templates`; a member can name extension files to load, such as a model provider | only the `read`, `grep`, `find` and `ls` tools |

Every adapter version bump needs a smoke test with the real agent.

### ACP session

- Built on the official TypeScript SDK, `@agentclientprotocol/sdk`, which acpx also uses. No dependency on acpx.
- `AgentProcess` starts the adapter in its own process group, so that stopping it also stops the agent it started.
- `AcpSession` sends `initialize`, opens a session with `session/new` in the member's folder, and sets the model and
  other options with `session/set_config_option`. A model is given as its ID with the version, such as
  `claude-opus-5-5`. acp-jury sends the ID as is and lets the agent resolve it: the Claude adapter, for example,
  lists Opus 5.5 under the value `opus` and maps `claude-opus-5-5` to it. `run.json` records the requested ID and
  the value and name that the agent reports. An ID that the agent refuses fails the start with the list of offered
  values. Turns use `session/prompt`; a turn past its time limit gets `session/cancel`, and an agent that does not
  stop is stopped with its process.
- File system: the client advertises read access only, inside the member's folder. Writes fail.
- Permissions: read and search tools are allowed, plus commands under the `exec` permission level or when the agent
  profile allows them. Everything else is refused. A refusal uses an option that does not cancel the turn when the
  agent offers one, such as Codex's `decline` over `cancel`.
- Every `session/update` and every permission decision goes to the member's `events.ndjson`.

### Sessions and seats

- Each member has one persistent ACP session for the whole run, so a turn sends only what is new.
- When an adapter stops, the member's next turn opens a new session, which gets the question, the items and every
  board message it may see again, including the member's own earlier messages.
- Each member gets its own copy of the folder. The original folder is never changed.
- All members of a round run in parallel, up to a concurrency limit, and none of them sees the others' text from
  the same round. A round ends when every turn in it has ended, with an answer, an error or a timeout.
- A turn cannot be interrupted. ACP has no way to add a message to a running turn, so new messages wait for the
  member's next turn.

### Board

The board is the only channel between members. It is derived from the saved turns, so a resumed run rebuilds the
same board with the same message IDs. `board.jsonl` holds one message per line:

```json
{
  "id": "m0007",
  "round": 2,
  "from": "member:B",
  "refs": [],
  "body": "item-2: I change my vote to yes. Member A is right: the file says this on line 40.",
  "vote": {"item-2": {"choice": "yes", "reason": "..."}},
  "createdAt": "2026-10-15T20:31:04Z"
}
```

- `body` is the member's reply without its vote block, and `vote` is the vote that counted.
- Members see each other only by anonymous labels (`member:A`, `member:B`), so that no member defers to a known
  model. The map from labels to models is in `run.json`, outside what members see.

### Delivery

At the start of a member's turn, the runtime sends one prompt with the question and the items (first turn of a
session only), every board message the member may see that is new to its session, and the mode's instruction for
the round.

## Modes

A mode is a `ModeRules` object with three rules: the last round it plays, whether a member sees a message, and the
instruction for a round.

| Mode | Rounds | What members see | Ends when | Output |
| --- | --- | --- | --- | --- |
| `blind` | one | nothing from other members | the round ends | each item agreed or split |
| `discuss` | one blind round, then up to `rounds` discussion rounds | after round 1, every message from the rounds that have ended | no item is split, or the round limit | each item agreed or split, with each member's blind and final votes |

### `blind`

Each member gets the question and the items and votes on every item without seeing the other members. Code
counts the votes. The literature calls this a panel or jury (Verga et al., 2024, "Replacing Judges with Juries",
arXiv:2404.18796).

### `discuss`

1. Round 1 is the same as `blind`. Its votes are each member's blind votes.
2. An item whose votes meet the run's rule is closed. If no item is open, the run ends.
3. In each later round, each member reads the messages of the last round, posts a reply, and votes again on every
   open item. A member can keep or change its vote. A changed vote must give its reason.
4. After each round, items whose votes meet the rule close.
5. The run ends when no item is open or when the round limit is reached. Each member's last vote on an item is its
   final vote. An item that is still split goes to a person, with every reason from the board.

The round limit (`rounds`) is the most discussion rounds after the blind round. The default is 5, and the lowest
value is 5.

This follows multi-agent debate (Du et al., 2023, arXiv:2305.14325; Chan et al., 2023, ChatEval,
arXiv:2308.07201). Discussion can make a member drop a correct view to follow the others, so the result always
keeps each member's blind vote next to its final vote.

## Items and votes

- The caller gives the items as a JSON list of `{"id", "text"}`. IDs use letters, digits, `_`, `.` and `-`, and
  must be unique. A run with no item list has one item, `answer`.
- The caller gives a JSON Schema for one item's vote. Each vote has a `choice` and a `reason`; the schema can
  limit the choices, such as `yes` or `no`, and add fields, which the result keeps.
- Every turn ends with one fenced JSON block that maps each open item to its vote. A vote on an item that is not
  open is ignored. A block that is missing, not JSON, or has a missing or invalid vote gets one nudge in the same
  session; if the answer is still invalid, the turn records `no_result`, and the member has no vote that round.
- Counting is in code and compares `choice`. The rule is set per jury: `unanimous` (the default) or
  `majority` (more than half of all members). An item with a tie, a missing vote or votes that do not meet the rule
  is a split. A split always goes to a person; the jury never closes it by itself.

## Limits

- `turnTimeoutSec` (default 1800) limits each turn.
- `limits.maxRunSec` and `limits.maxTokens` (from the adapters' usage reports) are checked between rounds, so a
  round that has started always ends.
- The run's stop reason is `all_agreed`, `rounds_done`, `time_limit` or `token_limit`.

## Records and replay

Each run has its own folder:

```text
runs/<run id>/
  run.json            question, resolved jury, label map, member commands, clean flags, adapter versions, applied options, input hashes
  board.jsonl         every member message
  members/<label>/
    events.ndjson     every ACP session/update and permission decision of the member
    stderr.log        the adapter's standard error
    turns/<round>.json  the member's turn in that round: each prompt and answer, the vote, tokens, time, stop reason
  result.json         stop reason, and per item: agreed or split, blind and final votes per member, each change of vote
  report.md           the same, for a person
```

- A rerun with the same run ID skips turns that are already saved, so a stopped run resumes without paying again.
  A run folder that holds a run with other inputs (question, items, jury, members, schema or folder content)
  refuses to resume.
- Backup is a hook that the caller gives. Before it runs, a scan for keys blocks it when the run folder holds one.

## Configuration

There are two levels, as in Claude Code, Codex and Pi. Each level holds a different part of the configuration.

| Level | Folder | Holds | Why there |
| --- | --- | --- | --- |
| user | `~/.acp-jury/`, or `ACP_JURY_HOME`, or `--config-dir` | `members.json`: which agent, which model, options | members depend on the machine: installed CLIs, logins and provider keys |
| repo | the nearest `.acp-jury/` from the working folder upward | `juries/<name>.json`, with their vote schemas and default questions | a jury is part of how a project works, and goes into git |

- Both levels have the same layout, so either level can hold either file. When both levels have a file with the
  same name, the repo file wins. Files are never merged.
- A jury name has letters, digits, `_` and `-`, so files such as `review.schema.json` next to the juries are
  not juries. A jury can also be given as the path of a jury file.
- Runs go to `<level folder>/runs/<run id>`, next to the configuration that holds the jury, unless `--out`
  says otherwise. The runs folder gets a `.gitignore` that ignores everything.

`members.json`:

```json
{
  "claude-opus-5-5": { "agent": "claude", "model": "claude-opus-5-5" },
  "gpt-6-astra": { "agent": "codex", "model": "gpt-6-astra", "options": { "reasoning_effort": "high" } },
  "deepseek-v4.1-flash": {
    "agent": "pi",
    "model": "huggingface/deepseek-ai/DeepSeek-V4.1-Flash",
    "extensions": ["~/.pi/agent/npm/node_modules/pi-huggingface-oauth/index.ts"]
  }
}
```

| Field | Meaning |
| --- | --- |
| `agent` | `claude`, `codex` or `pi`: a built-in agent profile |
| `command` | the adapter command; it replaces the profile's `npx` command, for example to pin another adapter version, or makes a custom agent |
| `model` | the model ID with its version, such as `claude-opus-5-5`; the agent resolves it, and `run.json` records the ID and the model the agent reports |
| `options` | other session config options of the agent, by ID, such as a reasoning effort |
| `extensions` | Pi only: the extension files to load; every other extension stays off |

`juries/<name>.json`:

```json
{ "mode": "discuss", "members": ["claude-opus-5-5", "gpt-6-astra"], "rounds": 5, "rule": "unanimous", "schema": "review.schema.json", "question": "review.md" }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `blind` | `blind` or `discuss` |
| `members` | required | member names from `members.json` |
| `rounds` | 5 | the most discussion rounds after the blind round; at least 5 |
| `rule` | `unanimous` | `unanimous` or `majority` |
| `schema` | choice and reason | a JSON Schema file for one item's vote, relative to the jury file |
| `question` | none | a default question file, relative to the jury file |
| `permissions` | `read` | `read`, or `exec` to also allow commands |
| `turnTimeoutSec` | 1800 | the time limit of one turn |
| `concurrency` | 3 | the most members that work at the same time |
| `limits` | none | `maxRunSec` and `maxTokens` for the whole run |

## Interface

```bash
acp-jury run review --dir ./folder --question question.md --items items.json
acp-jury run review --dir ./folder --mode blind --members claude-opus-5-5,gpt-6-astra --rounds 8 --run-id my-run
acp-jury show <run folder>
acp-jury juries
```

`run` flags change a jury field for one run only, and the result is checked again, so `--rounds 3` fails.
The same operations are exported as a TypeScript API (`resolveJury`, `runJury`, `listJuries`), so that
other tools call acp-jury in code.

## Later

- Pull delivery: the board as an MCP server with `read_board()` and `post(message)` tools, so that a member can
  read and post during a turn.
- Direct messages from one member to another.
- A way to run Codex clean without copying its login.

## Prior art

| Project | What we take from it |
| --- | --- |
| [openclaw/acpx](https://github.com/openclaw/acpx) | The architecture: an agent registry, an ACP client on the official SDK, persistent sessions, permission policies, records, and `compare` (one prompt across agents) as the seed of `blind` |
| [karpathy/llm-council](https://github.com/karpathy/llm-council) | Anonymous peer review between members |
| [haizelabs/verdict](https://github.com/haizelabs/verdict) | Judge building blocks: ensembles and debate as composable units |
| [Enderfga/claw-orchestrator](https://github.com/Enderfga/claw-orchestrator) | A council that votes until consensus, and fan-out across engines |

No code is copied from these projects.

## Open questions

- How Codex can run clean without copying its login.
- Whether `exec` members need network access off, and how to enforce that without containers.
