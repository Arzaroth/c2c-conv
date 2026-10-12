# History

The mirror shows the current screen, so a bozo who joins late has no idea what
came before. The **history** tab is the conversation from the first turn, as
readable turns: what was asked, what claude said, and which tools it reached for.

## Where it comes from

`src/transcript.ts` tails Claude Code's session JSONL at
`~/.claude/projects/<cwd-slug>/<session-id>.jsonl`. The transcript is flushed per
message, so turns arrive while a turn is still running.

**Finding the right file.** A project directory holds a transcript per session,
so the newest file would grab any other session sharing the cwd. Instead the
pane's pid leads to Claude Code's live-session descriptor at
`~/.claude/sessions/<pid>.json`, which carries the `sessionId` and `cwd` that
name the file. tmux may run the pane command through a shell, so the pane pid's
children are checked too.

**What is kept** (`toEntry`). User and assistant turns, with tool calls reduced
to their names. Meta and sidechain (subagent) records are skipped. Tool results
are dropped: they carry whole files and command
output, and a user-role record holding a `tool_result` is not something a person
said. Bozos see all of it in the mirror; this is about readability, not
concealment. The ringmaster keeps the last 500 entries (`MAX_HISTORY`) and sends
them as `transcript:history` on join, then `transcript` per new entry.

## Never load-bearing

The format is undocumented and drifts between CLI versions
([../decisions.md](../decisions.md#0002-the-pane-is-the-source-of-truth)).
Locating retries rather than failing, every parse is wrapped, and if any of it
breaks the mirror is unaffected and the tab stays empty.

Zavatta's `c2c_history` reads the same entries ([zavatta.md](zavatta.md)).

## Sources

- `src/transcript.ts` (`descriptorFor`, `childPids`, `locate`, `transcriptPath`, `toEntry`)
- `src/ringmaster.ts` (`MAX_HISTORY`), `web/client.ts` (history panel)
- `test/transcript.test.ts`
