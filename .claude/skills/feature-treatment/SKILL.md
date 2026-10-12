---
name: feature-treatment
description: Ship a finished c2c-conv feature branch the full way - rebase onto master, run a max-effort multi-agent review with c2c-conv's lenses (the gate, writing to the pane, tmux traps, the wire and its four consumers, limits), fix everything confirmed as new layers, update the brain/ knowledge base, pass the gate with real tmux, fast-forward master, cut a release, and remove the worktree. Use when the user says "feature treatment", "treat this branch", "review and merge this feature", or names a worktree or branch to ship.
---

# Feature treatment

The pipeline a finished feature branch goes through before it lands:
**rebase -> max review -> fix -> update the brain -> gate -> merge -> release ->
clean up**. Nothing merges without an adversarial review and a green gate.

The branch comes from the argument. If none is given, `wt list` and pick the
non-master worktree under `<main checkout>.worktrees/`; ask if more than one is
a candidate. Work inside that worktree. Paths are absolute, since `wt switch`
cannot move the agent's shell and worktrees nest by branch name:

```bash
MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
WT="$MAIN.worktrees/<branch>"
```

## 1. Rebase onto master

The branch has no PR (the remote is Forgejo, and work lands on master by
fast-forward), so it may be rewritten unless it has been pushed and someone
reviewed it; then merge `master` in instead, or ask.

```bash
cd "$WT" && git branch --show-current && git fetch origin && git rebase origin/master
```

Use the `resolving-merge-conflicts` skill on conflicts. Then check the size
rule: `git diff --name-only origin/master...HEAD | wc -l` must be at most 149.
Over it, stop and propose a split along a seam (ringmaster side first, then the
web client; or one subsystem per branch) before reviewing anything.

## 2. Max-effort review (parallel finders)

Diff: `git diff origin/master...HEAD -- . ':(exclude)pnpm-lock.yaml'`.

Spawn independent finder agents in one message, each over the same diff with a
different lens. Scale to the feature, 4-6 is typical. Give each the relevant
`CLAUDE.md` section(s) and brain leaves by name so it reviews against the rules
rather than rediscovering them.

- **Correctness** - line by line: inverted conditions, off-by-one, a missing
  `await` on a tmux call, swallowed errors, a promise chain racing the outbox,
  state that outlives a bozo's connection (trust, typing, the whiteface holder),
  a reply shape the CLI printer, the browser or zavatta does not expect.
- **The gate and security** - every new path from a bozo to the pane goes
  through `Policy` and then the `Outbox`, never `tmux.submit` directly. Checks
  live in the ringmaster, not the UI: open a raw socket in your head and send
  the message. Keys stay on `ALLOWED_KEYS` and yolo-or-whiteface. A new control
  command: is it in `WHITEFACE_COMMANDS`, and should it be (does it carry a
  secret, end the session, or cut the asking socket)? Zavatta gains no host
  tool. Tokens never reach a log, a notice, the roster or a non-whiteface bozo;
  comparisons stay `timingSafeEqualString`. `policy:queued` and the pending list
  go to the whiteface alone.
- **tmux and the pane** - text sent with `-l --`; every write behind the
  injection guard (prompt, draft, settle); no `run-shell` that can print; every
  `display-message` through `notify` (doubled `#`); state read from the plain
  capture but the draft from the coloured one (ghost suggestions); anything that
  changes tmux options before or after `new-session` for a reason
  (`history-limit`). Would the integration test catch it if it broke?
- **The wire** - `types/protocol.d.ts` is the contract for four consumers: the
  ringmaster, the bigtop envelope, `web/` and zavatta. A new message is declared
  there, validated at runtime on receipt (it came from an untrusted socket),
  handled or deliberately ignored by every consumer, and passes through the
  bigtop unchanged. A new list goes whole, not as deltas. Old spellings and
  aliases (`ALIASES`, `broker`, `spectator`, `ring`) still resolve.
- **Limits and lifetime** - anything a bozo can grow is capped (`MAX_TEXT`,
  `MAX_PENDING`, `MAX_OUTBOX`, `MAX_BOZOS`, `MAX_F2F_TEXT`, frame size) and the
  cap is in the brain's limits table. Timers and listeners are cleared on
  disconnect and on stop. Broadcast rates stay bounded (presence and typing
  only on change, throttled).
- **Tests and reuse** - new branches without a test; logic that could be a pure
  function with a unit test but is buried in the ringmaster; a tmux behaviour
  that only the integration test can pin and is not pinned; helpers re-implemented
  (`holdText`, `normalize`, `#pickBozo`, the alias resolver).

Each finder returns JSON findings `{file, line, severity, summary,
failure_scenario}`, verified by quoting the line, most severe first, and fixes
nothing. Optionally run one sweep finder over the merged list that hunts only
for gaps.

## 3. Fix what is confirmed

Re-verify each claim against the code before acting; finders produce plausible
wrong items too. Fix every confirmed correctness or gate finding and the
worthwhile quality ones. Real but out of scope goes to `TODO.md` in its format
(a section with size, *Why*, *Risk* and *Touches*, or one line under "Drift and
small fixes"), not dropped.

Fixes land as **new layers on top**, one kind of work per commit, each leaving
the tree green: `[<branch>] fix(<area>): ...`. Do not fold them into the
feature commits.

## 4. Update the brain

Apply the `brain` skill's maintain checklist to what the branch changed: new
rules into `CLAUDE.md`, a new or changed feature into `brain/features/` (plus
its index and `brain/BRAIN.md` rows), wire, gate or tmux changes into
`brain/architecture/`, new terms into `brain/glossary.md`, a decision with real
alternatives into `brain/decisions.md` (next `NNNN`), `README.md` for anything a
user types or reads, and a `CHANGELOG.md` `[Unreleased]` entry for anything a
user sees. Commit as its own `[<branch>] docs(...)` layer so it ships in the
same merge.

## 5. Gate

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test        # needs tmux on PATH
```

If the change touches the pane, the injection path or the host bindings, also
run it for real: `mise run local` in a scratch directory, connect a browser to
the printed link, and exercise the change against a live claude, including a
dialog and a drafted prompt box. Every expensive bug here lived where unit tests
cannot reach. Re-count files against the 149 limit after the fixes.

## 6. Merge

```bash
git -C "$MAIN" status --short          # the main checkout must be clean, on master
git -C "$MAIN" merge --ff-only <branch>
```

The rebase made this a fast-forward. If the main checkout is dirty or on another
branch, stop and ask rather than stashing the user's work. Do not push: the user
pushes deliberately, and the release step stops before pushing too.

## 7. Release

Run the `release` skill. Pick the bump by its pre-1.0 rule (minor only when an
existing checkout breaks), not by "feature = minor". Skip only if the user says
to batch it with the next one.

## 8. Clean up

```bash
wt remove <branch>
```

## Done when

The feature is on master, the brain reflects it, the gate was green, a tag is
ready (unless skipped), and the worktree is gone. Report the commits, the
version and why it is that size, one line on what the review caught, and that
nothing is pushed yet.
