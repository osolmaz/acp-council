<p align="center"><img src="assets/banner.svg" alt="acp-council" width="100%"></p>

<p align="center">
  <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/Built%20with-Claude%20Code-D97757?style=flat-square" alt="Built with Claude Code"></a>
  <img src="https://img.shields.io/badge/status-spec-5E5D59?style=flat-square" alt="Status: spec">
  <img src="https://img.shields.io/badge/license-MIT-141413?style=flat-square" alt="License: MIT">
</p>

# acp-council

Ask a council of coding agents one question about a folder, and get their votes, their discussion and a full
record of the run.

Each member is a real agent, such as Claude Code, Codex or Pi, that reads the folder with its own tools. acp-council
talks to the members over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). Members never talk to
each other directly: every message goes through one board, and the runtime decides who sees what and when. A
person makes the final decision; the council advises.

## Status

Specification stage. Nothing is implemented yet.

- [Specification](docs/SPEC.md)
- [Implementation plan](docs/2026-10-15-implementation-plan.md)

## Modes

| Mode | What happens |
| --- | --- |
| `panel` | Every member answers blind, and code counts the votes. |
| `discuss` | A blind first round, then public rounds until the votes agree or a round limit is reached. |
| `debate` | Members argue for and against each item in turn, optionally cross-examine each other in private, and a moderator or a person decides. |
| `check` | Each item of an earlier result goes to a member of a model family that did not raise it. |

## Planned interface

```bash
acp-council run --mode panel --members top --dir ./task --question question.md --schema vote.json
```

The first members are Claude Code, Codex and Pi.

## License

[MIT](LICENSE)
