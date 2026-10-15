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
| `blind` | Every member votes alone, and code counts the votes. |
| `discuss` | Every member votes alone first. Then the members talk about the items they disagree on, and vote again, until they agree or a round limit is reached. Items that are still split go to a person. |

## Planned interface

```bash
acp-council run --mode discuss --members top --dir ./folder --question question.md --items items.json --schema vote.json
```

The first members are Claude Code, Codex and Pi.

## License

[MIT](LICENSE)
