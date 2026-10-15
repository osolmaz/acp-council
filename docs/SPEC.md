# acp-council specification

## TL;DR

acp-council asks a council of coding agents one question about a folder and records how they answer. Each member
is a real agent (Claude Code, Codex, Pi) that reads the folder with its own tools. acp-council talks to them over
the Agent Client Protocol (ACP). The members never talk to each other directly: every message goes through one
board, and the runtime decides who sees what and when. There are two modes. In `blind`, each member votes alone.
In `discuss`, each member votes alone first, and then the members talk about the items they disagree on until
they agree or a round limit is reached. A person makes the final decision; the council advises.

## Goals

- One command and one TypeScript API: a question, a read-only folder, the items to vote on, a vote schema and a
  set of members.
- Members that are agents, not chat completions, so they can open long Word files, spreadsheets and PDFs.
- Two ways to combine members: blind votes, and a discussion after the blind votes.
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
| council | the members of one run and the rules they follow |
| member | one agent with one model, such as Claude Code with Claude Opus 5.5 |
| tier | a named set of members in the configuration, such as `top` |
| question | the prompt that the council answers |
| item | one thing that the council votes on; a question with no item list has one item |
| folder | the read-only material that the members read |
| board | the append-only list of every message in a run |
| message | one post on the board, with its sender, its text and its vote |
| round | one step in which every member takes one turn |
| turn | one ACP prompt to one member and its full answer |
| vote | a choice and a reason for each item, checked against the run's schema |
| split | an item on which the votes do not meet the run's rule |
| mode | the rules that decide who sees what, and when the run ends: `blind` or `discuss` |
| result | the counted votes, the splits and the full board, for a person to decide on |

## Architecture

```text
      question, items, folder, schema, members, mode
                           |
                     +-----v------+
                     |    mode    |  blind | discuss
                     +-----+------+
                           | which items are open, who sees what, stop or go on
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
- The adapters are `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp` and `pi-acp`, at
  their latest versions. The configuration pins the exact version that passed the smoke test, and every version
  bump needs a new smoke test. On 2026-10-16 the latest versions are `claude-agent-acp` 0.91.0, which bundles
  Claude Code 2.1.300 and so accepts Claude Opus 5.5; `codex-acp` 2.2.2, which bundles Codex 0.160; and `pi-acp`
  0.0.34.
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
- All members of a round run in parallel, up to a concurrency limit, and none of them sees the others' text from
  the same round. A round ends when every turn in it has ended, with an answer, an error or a timeout.
- A turn cannot be interrupted. ACP has no way to add a message to a running turn, so new messages wait for the
  member's next turn.

### Board

The board is the only channel between members. It is `board.jsonl`, one message per line:

```json
{
  "id": "m0007",
  "round": 2,
  "from": "member:B",
  "refs": ["m0003"],
  "body": "item-2: I change my vote to yes. Member A is right: the file says this on line 40.",
  "vote": {"item-2": {"choice": "yes", "reason": "..."}},
  "created_at": "2026-10-15T20:31:04Z"
}
```

- `from` is a member label or `runtime`. The runtime posts the question, the items and each round's instruction.
- A message from round 1 is hidden from the other members until the run ends in `blind`, or until round 1 ends in
  `discuss`. After round 1 of `discuss`, every message is public to all members.
- Members see each other only by anonymous labels (`member:A`, `member:B`), so that no member defers to a known
  model. The map from labels to models is in the run metadata, outside what members see.

### Delivery

At the start of a member's turn, the runtime sends one prompt with the question and the items (first turn only),
every message the member may see that is new since its last turn, and the instruction for this turn.

## Modes

| Mode | Rounds | What members see | Ends when | Output |
| --- | --- | --- | --- | --- |
| `blind` | one | nothing from other members | the round ends | each item agreed or split |
| `discuss` | one blind round, then discussion rounds | after round 1, every message | no item is split, or the round limit | each item agreed or split, with each member's blind and final votes |

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

This follows multi-agent debate (Du et al., 2023, arXiv:2305.14325; Chan et al., 2023, ChatEval,
arXiv:2308.07201). Discussion can make a member drop a correct view to follow the others, so the result always
keeps each member's blind vote next to its final vote.

## Items and votes

- The caller gives the items as a JSON list of `{"id", "text"}`. A run with no item list has one item, `answer`.
- The caller gives a JSON Schema for one item's vote. Each vote has a `choice` and a `reason`; the schema can
  limit the choices, such as `yes` or `no`, and add fields.
- Every turn ends with one JSON block that maps each open item to its vote. It must validate. An invalid block
  gets one nudge in the same session; if it is still invalid, the turn records `no_result`, and the member has no
  vote on those items in that round.
- Counting is in code and compares `choice`. The rule is set per run: `unanimous` (the default) or `majority`.
  An item with a tie, a missing vote or votes that do not meet the rule is a split. A split always goes to a
  person; the council never closes it by itself.

## Records and replay

Each run has its own folder:

```text
runs/<run id>/
  run.json            question, items, mode, members, label map, versions of acp-council and every adapter, input hashes
  board.jsonl         every message
  members/<label>/
    events.ndjson     every ACP session/update of the member
    turns/<n>.json    each turn: prompt, answer, vote, tokens, time, stop reason
  result.json         per item: agreed or split, blind and final votes per member, each change of vote
  report.md           the same, for a person
```

- A rerun with the same run ID skips turns that are already saved, so a stopped run resumes without paying again.
- Before any upload, a scan for keys blocks the upload when it finds one. Backup is a hook that the caller gives.

## Configuration

`council.json` names the members and tiers, the pinned adapter versions, the time limits and the concurrency:

```json
{
  "members": {
    "opus": {"agent": "claude", "model": "claude-opus-5-5"},
    "astra": {"agent": "codex", "model": "gpt-6-astra"},
    "pi-flash": {"agent": "pi", "model": "huggingface/deepseek-ai/DeepSeek-V4.1-Flash:novita"}
  },
  "tiers": {"top": ["opus", "astra"]},
  "adapters": {
    "claude": "@agentclientprotocol/claude-agent-acp@0.91.0",
    "codex": "@agentclientprotocol/codex-acp@2.2.2",
    "pi": "pi-acp@0.0.34"
  },
  "timeouts": {"turnSec": 1800},
  "concurrency": 3
}
```

## Interface

```bash
acp-council run --mode blind --members top --dir ./folder --question question.md --items items.json --schema vote.json
acp-council run --mode discuss --members opus,astra --rounds 8 --dir ./folder --question question.md --items items.json --schema vote.json
acp-council show runs/<run id>
```

`--rounds` is the most discussion rounds after the blind round. The default is 5, and the lowest value is 5. The
limit stops a run in which the members never agree. The same operations are exported as a TypeScript API, so that
other tools call acp-council in code.

## Later

- Pull delivery: the board as an MCP server with `read_board()` and `post(message)` tools, so that a member can
  read and post during a turn.
- Direct messages from one member to another.

## Prior art

| Project | What we take from it |
| --- | --- |
| [openclaw/acpx](https://github.com/openclaw/acpx) | The architecture: an ACP client on the official SDK, persistent sessions, records, and `compare` (one prompt across agents) as the seed of `blind` |
| [karpathy/llm-council](https://github.com/karpathy/llm-council) | Anonymous peer review between members |
| [haizelabs/verdict](https://github.com/haizelabs/verdict) | Judge building blocks: ensembles and debate as composable units |
| [Enderfga/claw-orchestrator](https://github.com/Enderfga/claw-orchestrator) | A council that votes until consensus, and fan-out across engines |

No code is copied from these projects.

## Open questions

- How each adapter runs clean without copying credentials: Claude Code settings sources, `CODEX_HOME`, and Pi's
  agent folder.
- Whether `exec` members need network access off, and how to enforce that without containers.
