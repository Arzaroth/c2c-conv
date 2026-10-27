# c2c-conv

Share one interactive Claude Code session with other people: they watch the
pane in a browser and, when the host lets them, type into it as genuine human
input. How it works is in `brain/` (start at `brain/BRAIN.md`); this file holds
the rules a change can break, each with the incident behind it.

## Develop

```bash
mise run check    # both TypeScript builds, no emit (the only lint)
mise run test     # build, then node --test over dist/test (needs tmux)
mise run local    # share a session here, loopback only
```

Work lands on `master` as layered `[<branch>] type(scope): ...` commits. Pushing
is the user's call. Releases: the `release` skill; a finished branch: the
`feature-treatment` skill.

## The gate is in the ringmaster

Every check on what a bozo may do (`Policy.submit`, `Policy.submitKey`,
`WHITEFACE_COMMANDS`, the whiteface claim) runs in the ringmaster, never only in
`web/`. A bozo can open its own websocket and send anything the protocol
declares, so a UI that hides a button guards nothing. Keys are refused in the
gallery for everyone but the whiteface. Zavatta exposes no approve, deny, mode,
trust or whiteface tool: an agent that could release its own messages collapses
the gate (`brain/decisions.md` 0010). A new control command decides explicitly
whether it belongs in `WHITEFACE_COMMANDS`; `status` (carries the token),
`stop`, `rotate` (its reply is the only copy of the new link) and `say` do not.

## Writing to the pane

The outbox is the only writer of text to the pane. Nothing calls `tmux.submit`
outside `Ringmaster#deliver`, which waits for a prompt, refuses to type over the
host's draft, and settles after each send. An approved message once arrived
while the workspace-trust dialog was up; its trailing Enter picked `No, exit`
and killed the session. A cleared message is never dropped for being busy: it
waits with its reason on it. Only a dead pane, a failed write or a full outbox
loses one, loudly
(`test/outbox.test.ts`).

Text goes through `send-keys -l --` so bozo input is never a key name
(`test/tmux.integration.test.ts` uses `C-u` because tmux sends anything else
literally anyway). Newlines are collapsed by `normalize()` before injection.

## Reading the pane

State comes from the plain `capture-pane`: with `-e` tmux wraps each word in its
own SGR pair and phrase matching never matches. The draft comes from the
coloured one: claude paints a dim suggestion into the empty box, and reading it
as a draft wedged every queued message behind a line nobody typed. The input box
is found structurally (a `❯` under a rule), never by the footer or a bare marker
(`test/screen.test.ts`).

## tmux

- The c2c server is `-L c2c -f /dev/null`. Do not load the host's config.
- A host binding never prints: `run-shell` output opens a view-mode pane, the
  next injected text was read as copy-mode keys, and `send-keys` hung forever.
  Keep the `>/dev/null 2>&1`, keep `copy-mode` as a pane state, keep the 10s
  timeout on every tmux call.
- Every `display-message` goes through `notify`, which doubles `#`: what it
  carries is a bozo's name or words, and tmux expands `#{...}`.
- `history-limit` is set before `new-session`; a pane ignores it afterwards.
- Bindings resolve `#{session_name}` at keypress: key tables are server-global.

## A restart keeps the session

`c2c restart` moves a running session to a new ringmaster through
`snapshot.json` (`brain/features/restart.md`). State a bozo would miss on
reconnect goes in `SessionSnapshot` and through a `restore()` that reapplies the
caps; per-bozo trust never does. A real stop kills cloudflared and removes the
snapshot; only a handover releases the tunnel, and SIGTERM is a real stop. A
message typed into the pane and not yet confirmed stays out of the snapshot, or
the next ringmaster types it twice.

## The ledger is a record, never a path

`ledger.sqlite` (`brain/features/ledger.md`) is written by the ringmaster as
things happen and read only by `c2c log`. Nothing waits on it: `Ledger.record`
never throws and `node:sqlite` is optional, because a full disk must cost the
record, not the session. It never holds the token.

## The f2f lane never reaches the pane

Not a flag on the submit path: the lane has no code path to `tmux` beyond
`notify`. Keep it that way (`brain/decisions.md` 0011).

## Anything a bozo can grow is capped

Frames, text, the pending queue, the outbox, the lane, bozos per session and per
room, bigtop rooms. A new collection a bozo can add to gets a cap and a row in
`brain/architecture/protocol.md`'s limits table. The 4GiB-declared-frame test
against a live ringmaster is the reason the frame cap exists.

## The wire

`types/protocol.d.ts` is the one contract, ambient for both builds, consumed by
the ringmaster, the bigtop, `web/` and zavatta. A new message is declared there,
checked at runtime on receipt, and handled by each consumer that can see it. The
bigtop passes bozo traffic through unchanged; there is one client. Old spellings
(`spectator`, `ring`, `broker`, `--broker`) keep working. Mode aliases live in
`ALIASES` (`src/policy.ts`) and are duplicated in `MODE_ALIASES` (`src/cli.ts`);
a new spelling goes in both until they are merged.

## No runtime dependencies

Everything in `package.json` is a dev dependency, the websocket is hand-rolled in
`src/ws.ts`, and xterm is bundled. Adding a runtime dependency is a decision for
`brain/decisions.md`, not a convenience.

## The brain (knowledge base)

`brain/` is the committed knowledge base describing how the app works:
architecture, features, decisions, glossary. It exists so a developer or AI can
understand the app **without reading the source**. `brain/BRAIN.md` is the entry
index - it links to the `architecture/` and `features/` sub-indexes, which link
to leaf docs. Read it before hunting for where something lives, and navigate via
the indexes rather than grepping the whole tree. The `brain` skill has the full
navigate / maintain / audit checklist.

- It is load-bearing: keep it TRUE to the code. When a change makes a brain doc
  wrong, fix the doc in the same change, as its own docs layer.
- The code is the source of truth. If the brain disagrees with reality, reality
  wins: correct the brain.
- New feature -> add `brain/features/<name>.md`, plus a row in
  `brain/features/index.md` and the features table in `brain/BRAIN.md`. New
  cross-cutting tech or subsystem -> add or update a `brain/architecture/*.md`.
- Capture the WHY in `brain/decisions.md` and new terms in `brain/glossary.md` as
  they happen - decisions not written down are lost.
- Don't restate code: link to source paths and cross-link sibling docs with
  relative markdown links. Match the existing dense, skimmable style, no
  em-dashes.
