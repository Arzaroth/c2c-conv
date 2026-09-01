# Feasibility

Investigated against Claude Code **2.1.251** on Linux. Everything below was verified
on a live session, not inferred from documentation.

## The requirement

A bozo must be able to (a) watch a Claude Code session in realtime and (b) send
messages that the session treats exactly as if the host had typed them.

Part (b) is the hard half. A message that arrives visibly second-class does not
meet the bar.

## Three candidate write paths

### 1. Keystroke injection into a PTY - chosen

Run `claude` inside tmux, deliver bozo text with `tmux send-keys`.

Verified by spike: started a real session in an isolated tmux server, injected a
prompt with `send-keys`, then inspected the resulting record in
`~/.claude/projects/<slug>/<session-id>.jsonl`:

```
type         : user
userType     : external
origin       : {'kind': 'human'}
promptSource : typed
cross-session wrapper : False
```

`origin: {kind: "human"}` with `promptSource: "typed"`. The injected prompt is
recorded as a human-typed message. This is byte-identical to the host typing it,
which is exactly the requirement.

The spike also drove the workspace-trust dialog with `Down` + `Enter`, confirming
that injection reaches modal dialogs and not just the prompt box. Permission
approval and prompt submission are therefore the same mechanism, which is what
makes the gallery/ring ladder cheap to implement.

### 2. stream-json bridge - viable, rejected for v0

`claude -p --input-format stream-json --output-format stream-json
--include-partial-messages --replay-user-messages` is a real bidirectional
protocol with token-level streaming, and both participants' messages enter as
genuine user turns.

Rejected because it replaces the interactive TUI outright. The host would have to
abandon `claude` and live inside our client, and we would own permission-prompt
rendering. Worth revisiting if we ever want a native web experience rather than a
mirrored terminal.

### 3. The local peer bus - disqualified

Claude Code sessions already talk to each other. Each interactive session writes
`~/.claude/sessions/<pid>.json` (carrying `messagingSocketPath`, `peerFeatures`,
`status`) plus a `<pid>.<hash>.key` holding a `peerToken`, and listens on
`$XDG_RUNTIME_DIR/cc-socks/<pid>.sock`. The wire format is newline-delimited JSON,
logged under the `[uds-messaging]` tag, with SO_PEERCRED verification of the
connecting process. This is what the `ListAgents` and `SendMessage` tools ride on.

It is disqualified for bozo input. Strings extracted from the binary show
inbound peer messages are wrapped in `<cross-session-message>`, and the receiving
session's own system prompt states that cross-session messages are **never user
intent**. A bozo message delivered this way arrives explicitly downgraded.

Still useful for out-of-band signalling between tooling. Not for the bozo.

## Read path

Two sources, both confirmed:

- **Pane bytes** via `tmux pipe-pane`. Token-level, includes the full TUI. This is
  the source of truth for the mirror.
- **Transcript JSONL** at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`,
  flushed per message rather than per turn (verified: the newest record was two
  seconds old while a turn was still running). Record types observed: `assistant`,
  `user`, `attachment`, `mode`, `permission-mode`, `last-prompt`, `ai-title`,
  `file-history-snapshot`.

The transcript is a structured enrichment stream, useful for rendering clean
messages instead of raw ANSI. It is **not** a public API and its shape will drift
between CLI versions, so it must never become load-bearing.

## Not to be confused with

`claude --remote-control` already ships and drives local sessions from
claude.ai or mobile. It is single-account, so it does not cover a second person.
c2c-conv is not redundant with it.

## Known limits carried into v0

- Blind injection is unsafe while a modal is up: the text goes nowhere and the
  trailing Enter confirms the highlighted option. Mitigated by the injection
  guard, see [ARCHITECTURE.md](ARCHITECTURE.md#security-model).
- Two writers on one PTY can interleave. Needs input arbitration.
- Bozo text containing newlines would submit mid-message, so newlines are
  collapsed to spaces before injection.
- In yolo mode a bozo has arbitrary code execution as the host. This is inherent
  to the requirement, not a fixable defect. It has to be loud in the UI.
