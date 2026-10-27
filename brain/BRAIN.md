# BRAIN - c2c-conv knowledge base

The map of the codebase, written so a developer or AI can understand c2c-conv
**without reading the source**. Start here, follow the links, stop when you have
the answer. Every leaf doc cites the real source files if you need to go deeper.

> Product: **c2c-conv** (*clown to clown conversation*) - share one interactive
> Claude Code session with other people, live. They watch the pane in a browser,
> and when the host lets them, they type into it as genuine human input. Stack
> snapshot in [stack.md](stack.md); the current version is `version` in
> `package.json`.

## How to use this

1. Know the topic? Jump straight to its file via the indexes below.
2. Have a question, not a topic? Scan **Find by question** first.
3. Need a term defined? See [glossary.md](glossary.md). The circus names are
   load-bearing; read it before renaming anything.
4. Want the "why" behind a design? See [decisions.md](decisions.md).
5. About to change something? The rules a change can break are in the repo's
   `CLAUDE.md`.

The brain is a tree: this file -> two folder indexes
([architecture/index.md](architecture/index.md),
[features/index.md](features/index.md)) -> leaf docs. Don't grep the whole tree;
use the indexes.

## Top-level docs

| Doc | What's here |
|---|---|
| [stack.md](stack.md) | Node, TypeScript, vite, xterm, pnpm, mise; why there are no runtime dependencies. |
| [operations.md](operations.md) | Build, the gate, CI, install, the container, deploying a bigtop, releases. |
| [glossary.md](glossary.md) | The circus vocabulary and the borrowed terms, with the synonyms to avoid. |
| [decisions.md](decisions.md) | The non-obvious decisions and their rationale, numbered. |

## Architecture (the how) - [architecture/index.md](architecture/index.md)

| Doc | What's here |
|---|---|
| [overview.md](architecture/overview.md) | Processes, components, data flow from the pane to a browser and back. Read first. |
| [tmux.md](architecture/tmux.md) | The isolated tmux server, the pane stream, host bindings, the status line, the traps. |
| [screen.md](architecture/screen.md) | Reading the pane: `classifyScreen`, `readPromptBox`, ghost suggestions, the injection guard. |
| [gate.md](architecture/gate.md) | `Policy` and `Outbox`: who may send what, and when it lands. |
| [protocol.md](architecture/protocol.md) | The hand-rolled websocket, the bozo message vocabulary, the control dispatcher, limits. |
| [transports.md](architecture/transports.md) | Loopback, `--bind`, `--tunnel`, the bigtop and its uplink protocol. |
| [security.md](architecture/security.md) | Tokens, the state dir, what each mode can do, rotate and kick. |
| [testing.md](architecture/testing.md) | The unit suite, the real-tmux integration test, CI. |

## Features (the what) - [features/index.md](features/index.md)

| Doc | What's here |
|---|---|
| [hosting.md](features/hosting.md) | `c2c host`, `attach`, `invite`, `stop`, passing flags to claude, `--version`. |
| [modes-and-trust.md](features/modes-and-trust.md) | Gallery and yolo, the prefix keys, the room default, per-bozo trust. |
| [keypad.md](features/keypad.md) | Answering claude's dialogs from the browser, and who may. |
| [outbox.md](features/outbox.md) | Cleared messages delivered one at a time; `drain` and `through`. |
| [f2f-lane.md](features/f2f-lane.md) | The chat lane between the clowns that claude never hears. |
| [circus.md](features/circus.md) | The roster: who is here, what each may do, presence, typing. |
| [whiteface.md](features/whiteface.md) | Running the gate from a browser, for headless sessions. |
| [history.md](features/history.md) | The readable conversation from the transcript JSONL. |
| [scrollback.md](features/scrollback.md) | A snapshot of the pane plus its history, separate from the mirror. |
| [zavatta.md](features/zavatta.md) | An AI agent as a bozo, over MCP, under the same gate. |
| [restart.md](features/restart.md) | A new ringmaster for a running session, after a hotfix or a crash, keeping every link. |
| [kick-and-rotate.md](features/kick-and-rotate.md) | Showing one bozo out, or killing every link handed out. |
| [container.md](features/container.md) | Running a headless session from the Docker image. |

## Find by question

| If you're asking... | Go to |
|---|---|
| How does a bozo message become a "human, typed" turn? | [decisions.md](decisions.md#0001-keystroke-injection-into-a-pty), [architecture/tmux.md](architecture/tmux.md) |
| Why mirror the pane instead of rendering the transcript? | [decisions.md](decisions.md#0002-the-pane-is-the-source-of-truth) |
| Why can a bozo's text never answer a permission prompt? | [architecture/screen.md](architecture/screen.md), [architecture/gate.md](architecture/gate.md) |
| Why is my message stuck, and what is it waiting for? | [features/outbox.md](features/outbox.md) |
| Why did a dim suggestion in the prompt box block the queue? | [architecture/screen.md](architecture/screen.md) |
| Why is the prefix always `C-b` inside a c2c session? | [architecture/tmux.md](architecture/tmux.md) |
| Why must a host binding never print? | [architecture/tmux.md](architecture/tmux.md#never-let-run-shell-print) |
| How do I let one person into the ring and not the other 29? | [features/modes-and-trust.md](features/modes-and-trust.md) |
| How does a headless host approve anything? | [features/whiteface.md](features/whiteface.md) |
| How do I share with someone outside my network? | [architecture/transports.md](architecture/transports.md) |
| What crosses the bigtop, and what does it see? | [architecture/transports.md](architecture/transports.md#the-bigtop) |
| What message types exist, and where are they declared? | [architecture/protocol.md](architecture/protocol.md) |
| How many bozos, how long a message, how big a frame? | [architecture/protocol.md](architecture/protocol.md#limits) |
| What can a bozo in yolo do to my machine? | [architecture/security.md](architecture/security.md) |
| How do I ship a hotfix without new links or losing the f2f lane? | [features/restart.md](features/restart.md) |
| How does an agent see what scrolled off the screen, or older turns? | [features/zavatta.md](features/zavatta.md) |
| I sent the link to the wrong person. Now what? | [features/kick-and-rotate.md](features/kick-and-rotate.md) |
| Why can an AI bozo not approve its own messages? | [features/zavatta.md](features/zavatta.md), [decisions.md](decisions.md#0010-zavatta-has-no-host-tools) |
| Why has the live mirror no scrollback? | [features/scrollback.md](features/scrollback.md) |
| Which transcript file belongs to this session? | [features/history.md](features/history.md) |
| What does CI run? How do I cut a release? | [operations.md](operations.md) |
| Why does a test only fail on a machine without tmux? | [architecture/testing.md](architecture/testing.md) |

## Maintaining the brain

This brain is **load-bearing documentation**: it must stay true to the code.
When a change makes a brain doc wrong, fix the doc in the same change. When you
discover the brain disagrees with reality, the code wins: correct the brain and
note it. The enforceable version of this rule lives in the repo's `CLAUDE.md`
("The brain (knowledge base)"). New feature -> new `features/<name>.md` + a row
in [features/index.md](features/index.md) + a row here. New subsystem -> an
`architecture/*.md` + rows in its index and here. New term ->
[glossary.md](glossary.md); new decision -> [decisions.md](decisions.md).
