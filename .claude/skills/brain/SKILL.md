---
name: brain
description: Use and maintain the brain/ knowledge base - the committed docs describing how c2c-conv works (architecture, features, decisions, glossary) - together with CLAUDE.md, which holds the rules a change can break. Invoke when the user asks how or where something works ("how does the outbox decide to wait", "where is the gate", "explain the bigtop", "why can't zavatta approve"), when onboarding, or when asked to update, audit or fix the brain after a change. Read brain/BRAIN.md first; navigate via the indexes, not a whole-tree grep.
---

# The brain

`brain/` is the committed knowledge base: how c2c-conv works, written so you can
answer without reading the source. Use it as the first stop for understanding,
and keep it true to the code. `CLAUDE.md` is its companion: the rules a change
can break, each with the incident that taught it.

## Navigating (to answer a question)

1. Open `brain/BRAIN.md` - the entry index. It has topic tables and a **Find by
   question** table.
2. Drill via the sub-indexes: `brain/architecture/index.md` (the how) and
   `brain/features/index.md` (the what). Don't grep the whole tree; the indexes
   are the routing layer.
3. Land on the leaf doc. It is self-contained and ends with a `## Sources` list
   of the real code paths - follow those only if the doc isn't enough or you
   suspect drift.
4. Terms -> `brain/glossary.md` (the circus names, each with the synonyms to
   avoid). Rationale / "why not the other way" -> `brain/decisions.md`
   (numbered `### NNNN`).
5. About to change code -> also read the matching `CLAUDE.md` section
   (`grep -n '^##' CLAUDE.md`): the gate, writing to the pane, tmux, the f2f
   lane, zavatta, limits, the wire.

Structure:

```
brain/BRAIN.md                 root index + find-by-question
brain/stack.md  operations.md  glossary.md  decisions.md
brain/architecture/index.md    overview tmux screen gate protocol
                               transports security testing
brain/features/index.md        hosting modes-and-trust keypad outbox f2f-lane
                               circus whiteface history scrollback zavatta
                               kick-and-rotate container
```

## Maintaining (after a change)

The brain is load-bearing and the rule is in `CLAUDE.md` ("The brain
(knowledge base)"). The code is the source of truth - if a doc disagrees with
reality, fix the doc.

- A change that makes a brain doc wrong fixes that doc **in the same change**,
  as its own `[<branch>] docs(brain): ...` layer on top of the behaviour commit
  (one kind of work per commit, each leaving the tree green).
- New feature -> add `brain/features/<name>.md`, then a row in
  `brain/features/index.md` and the features table in `brain/BRAIN.md` (and a
  Find-by-question row if it answers a new question). New cross-cutting
  subsystem -> add or update a `brain/architecture/*.md` and its index rows.
- New wire message -> `brain/architecture/protocol.md` (the tables mirror
  `types/protocol.d.ts`). New cap -> its Limits table. New `c2c ctl` command ->
  the dispatcher section there, and whether it is a whiteface command.
- New non-obvious decision -> `brain/decisions.md`, under its area: the
  decision, the why and the rejected alternatives. One with real alternatives
  gets the next `### NNNN` number; a smaller one is a bullet.
- New or renamed term -> `brain/glossary.md`: bold term, one definition, a link
  to its doc, and an `Avoid:` list. Circus names must explain the part; borrowed
  tmux / websocket / transcript vocabulary keeps its real name.
- New rule a future change could break -> a paragraph in the matching
  `CLAUDE.md` section stating the rule and the incident behind it, naming the
  test that asserts it; the brain doc links there rather than repeating it.
- Stack or toolchain change -> `brain/stack.md`; gate, task, CI, deploy or
  release change -> `brain/operations.md`.
- User-visible behaviour, flag or command -> also `README.md` and
  `CHANGELOG.md` `[Unreleased]`.
- Style: dense, skimmable, present tense, normal prose. No em-dashes.
  Cross-link siblings with relative markdown links. Cite source paths, symbol
  names and test files instead of restating code. End each leaf with
  `## Sources`.

What does **not** go in: anything git history already records, and a changelog
of how a rule came to be beyond the one incident that justifies it.

## Auditing (drift check on request)

When asked to verify the brain matches reality:

1. Scope it to the relevant leaf doc(s) - don't re-audit everything.
2. For each, read the `## Sources` paths and confirm the doc's claims still hold:
   symbol and test names (`git grep`), constants and their values (`MAX_*`,
   timings), file paths, message types against `types/protocol.d.ts`, CLI flags
   and `ctl` subcommands against `src/cli.ts` (`c2c` with no args prints usage),
   `WHITEFACE_COMMANDS`, zavatta's `TOOLS`.
3. Where they diverge, the code wins: correct the doc. Note what you changed.
4. If a subsystem moved or a feature shipped or was removed, update the indexes
   (`BRAIN.md`, the two `index.md`) too so navigation stays accurate.
5. Check links: every relative link and anchor resolves, and no doc points at a
   path that no longer exists.

For a broad audit, fan out read-only agents (one per architecture or feature
doc, plus one for the `CLAUDE.md` sections) that each diff their doc against
its `## Sources` and return `{doc, claim, reality, fix}`, then apply the fixes
yourself. A personal `docs-update` skill, where installed, can do the scoping;
this skill is the map it should follow here.
