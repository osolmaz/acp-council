# acp-council specification

## TL;DR

acp-council asks a council of coding agents one question about a folder and records how they answer. Each member
is a real agent (Claude Code, Codex, Pi) that reads the folder with its own tools. acp-council talks to them over
the Agent Client Protocol (ACP). The members never talk to each other directly: every message goes through one
board, and the runtime decides who sees what and when. The modes are rules over that board: a blind panel vote,
an open discussion, a debate with sides, and a cross-family check. A person makes the final decision; the council
advises.

## Goals

- One command and one TypeScript API: a question, a read-only folder, an output schema and a set of members.
- Members that are agents, not chat completions, so they can open long Word files, spreadsheets and PDFs.
- Several ways to combine members: independent votes, discussion until agreement, and debate.
- Full records of every run, so a run can be audited, resumed and replayed.
- A small core that follows the acpx architecture without depending on acpx: the runtime owns sessions, records
  and replay; the agents own the reasoning.

## Non-goals

- Not a general agent framework or workflow engine.
- Not for tasks that change files. Members advise; they do not edit the folder they review.
- Not a benchmark runner. Grading of benchmark answers stays in Harbor.
- No web interface in the first version.

## Terms

| Term | Meaning |
| --- | --- |
| council | the members of one run and the rules they follow |
| member | one agent with one model, such as Claude Code with Claude Opus 5.5 |
| family | the model's maker, such as Anthropic or OpenAI; the check mode needs it |
| tier | a named set of members in the configuration, such as `top` |
| question | the prompt that the council answers |
| folder | the read-only material that the members read |
| board | the append-only list of every message in a run |
| message | one post on the board, with its sender, its recipients and an optional vote |
| round | one step in which some or all members take one turn |
| turn | one ACP prompt to one member and its full answer |
| vote | the structured part of a message, checked against the run's schema |
| mode | the rules that decide who speaks, who sees what, and when the run ends |
| result | the counted votes, the splits and the full board, for a person to decide on |

## Architecture

```text
          question, folder, schema, members, mode
                           |
                     +-----v------+
                     |    mode    |  panel | discuss | debate | check
                     +-----+------+
                           | who speaks next, who sees what, stop or go on
                     +-----v------+
                     |   board    |  board.jsonl, visibility rules, anonymous labels
                     +-----+------+
                           | one turn: visible messages since the last turn + instruction
                     +-----v------+
                     |  sessions  |  one persistent ACP session per member, timeouts, records
                     +-----+------+
                           | ACP over stdio (JSON-RPC)
           +---------------+---------------+
     claude-agent-acp   codex-acp       pi-acp
       (Claude Code)     (Codex)         (Pi)
```

### ACP client

- Built on the official TypeScript SDK, `@agentclientprotocol/sdk`, which acpx also uses. No dependency on acpx.
- The first adapters are `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp` and `pi-acp`.
  The configuration pins each adapter version. A Claude adapter must bundle a Claude Code version that supports
  the requested model; for example, Claude Opus 5.5 needs Claude Code 2.1.280 or newer.
- The client starts each adapter as a child process, sends `initialize`, opens a session with `session/new` in
  the member's working folder, and sends turns with `session/prompt`. It records every `session/update`
  notification. It sends `session/cancel` only when a turn reaches its time limit.
- File system: the client advertises read access only, inside the member's working folder. Writes outside it fail.
- Permissions: the client answers `session/request_permission` with a policy. The default policy allows read and
  search tools and denies the rest. The `exec` policy also allows commands, so that a member can parse a Word
  file with a script; the member then works in a disposable copy of the folder, never in the original.
- Clean members: a member runs without the user's global instructions, skills or extensions, through each
  adapter's own options. acp-council never copies a credential into a new place. If an adapter cannot run clean
  without that, the run records the member as not clean.

### Sessions

- Each member has one persistent ACP session for the whole run, so a turn sends only what is new.
- Each member gets its own copy of the folder. The original folder is never changed.
- Members in the same round run in parallel, up to a concurrency limit. A round ends when every turn in it has
  ended, with an answer, an error or a timeout.
- A turn cannot be interrupted. ACP has no way to add a message to a running turn, so new messages wait for the
  member's next turn.

### Board

The board is the only channel between members. It is `board.jsonl`, one message per line:

```json
{
  "id": "m0007",
  "round": 2,
  "from": "member:B",
  "to": ["all"],
  "kind": "critique",
  "refs": ["m0003"],
  "body": "Item D18 is valid: Section 10.4 is the data clause, and the draft points to 10.5.",
  "vote": {"D18": {"choice": "keep", "reason": "..."}},
  "created_at": "2026-10-15T20:31:04Z"
}
```

- `to` is `all` (public), one member, a group, or `moderator`. The runtime shows a member only the messages
  addressed to it, to a group it is in, or to `all`. Direct messages stay on the board, so a person can audit
  everything.
- Members see each other only by anonymous labels (`member:A`, `member:B`), so that no member defers to a known
  model. The map from labels to models is in the run metadata, outside what members see.
- `kind` is one of `answer`, `critique`, `question`, `reply`, `statement`, `vote`, `summary` and `system`.

### Delivery

- Push (first version): at the start of a member's turn, the runtime sends one prompt with the question (first
  turn only), every message the member may see that is new since its last turn, and the instruction for this
  turn.
- Pull (later): the runtime attaches the board to the session as an MCP server with `read_board()` and
  `post(message, to)` tools, so that a member can read and post during a turn.

### Turn order

- `rounds`: all members of a round write at the same time, blind to each other within the round. This is fair,
  because nobody sees the others' text before writing.
- `round-robin`: one member at a time, each seeing everything said before. This suits a debate, but the first
  speaker anchors the rest, so the order rotates between rounds.
- `async`: members post through the pull tools while the others work. Later.

## Modes

| Mode | Turn order | Visibility | Ends when | Output |
| --- | --- | --- | --- | --- |
| `panel` | one blind round | none until the end | the round ends | counted votes and splits |
| `discuss` | blind first round, then rounds | public | all votes agree, or the round limit | counted votes, with each change of vote and its reason |
| `debate` | round-robin with sides | public, plus optional private cross-examination | the round limit | the moderator's decision, or the transcript for a person |
| `check` | one round | each item and its sources | the round ends | agree, disagree or unsure per item, by a member of another family |

- `panel` is the default. The literature calls it a panel or jury (Verga et al., 2024, "Replacing Judges with
  Juries", arXiv:2404.18796).
- `discuss` and `debate` follow multi-agent debate (Du et al., 2023, arXiv:2305.14325; Chan et al., 2023,
  ChatEval, arXiv:2308.07201). Discussion can make a member drop a correct view to follow the others, so the result
  always keeps each member's first, blind vote next to its final vote.
- In `debate`, members argue for and against each item or claim. With cross-examination on, member A questions
  member B in a direct message, B answers, and both then post a public statement. A moderator member, or a person,
  decides after the closing statements.
- `check` takes items from an earlier result, such as flagged defects, and gives each to a member whose family
  did not raise it.

## Output schema and votes

- The caller gives a JSON Schema for the vote. Every turn ends with one JSON block that must validate. An invalid
  vote gets one nudge in the same session; if it is still invalid, the turn records `no_result`.
- Counting is in code. The rule is set per run: `majority`, `unanimous` or a threshold. A tie or a vote below the
  threshold is a `split`. A split always goes to a person; the council never closes it by itself.

## Records and replay

Each run has its own folder:

```text
runs/<run id>/
  run.json            question, mode, members, label map, versions of acp-council and every adapter, input hashes
  board.jsonl         every message
  members/<label>/
    events.ndjson     every ACP session/update of the member
    turns/<n>.json    each turn: prompt, answer, vote, tokens, time, stop reason
  result.json         counted votes, splits, first and final votes per member
  report.md           the same, for a person
```

- A rerun with the same run ID skips turns that are already saved, so a stopped run resumes without paying again.
- Before any upload, a scan for keys blocks the upload when it finds one. Backup is a hook; the first user backs
  up to its own bucket.

## Configuration

`council.json` names the members and tiers, the pinned adapter versions, the time limits and the concurrency:

```json
{
  "members": {
    "opus": {"agent": "claude", "model": "claude-opus-5-5", "family": "anthropic"},
    "astra": {"agent": "codex", "model": "gpt-6-astra", "family": "openai"},
    "pi-flash": {"agent": "pi", "model": "huggingface/deepseek-ai/DeepSeek-V4.1-Flash:novita", "family": "deepseek"}
  },
  "tiers": {"top": ["opus", "astra"]},
  "adapters": {
    "claude": "@agentclientprotocol/claude-agent-acp@<pinned>",
    "codex": "@agentclientprotocol/codex-acp@<pinned>",
    "pi": "pi-acp@<pinned>"
  },
  "timeouts": {"turnSec": 1800},
  "concurrency": 3
}
```

## Interface

```bash
acp-council run --mode panel --members top --dir ./task --question question.md --schema vote.json
acp-council run --mode discuss --members opus,astra,pi-flash --rounds 3 --dir ./task --question question.md --schema vote.json
acp-council show runs/<run id>
```

The same operations are exported as a TypeScript API, so that other tools call acp-council in code.

## Prior art

| Project | What we take from it |
| --- | --- |
| [openclaw/acpx](https://github.com/openclaw/acpx) | The architecture: an ACP client on the official SDK, persistent sessions, records, and `compare` (one prompt across agents) as the seed of `panel` |
| [karpathy/llm-council](https://github.com/karpathy/llm-council) | Anonymous peer review between members |
| [haizelabs/verdict](https://github.com/haizelabs/verdict) | Judge building blocks: ensembles, debate and verification as composable units |
| [Enderfga/claw-orchestrator](https://github.com/Enderfga/claw-orchestrator) | A council that votes until consensus, and fan-out across engines |

No code is copied from these projects.

## Open questions

- How each adapter runs clean without copying credentials: Claude Code settings sources, `CODEX_HOME`, and Pi's
  agent folder.
- Whether `exec` members need network access off, and how to enforce that without containers.
- Whether the moderator in `debate` is a member of the council or a separate member that does not vote.
