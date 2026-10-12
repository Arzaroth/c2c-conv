---
name: release
description: Cut a c2c-conv release, the whole shebang - pick the bump by the project's pre-1.0 rule (minor only when an existing checkout breaks), docs sweep (CHANGELOG, README, TODO, CLAUDE.md, brain/), bump package.json, full local gate with tmux, [master] chore(release) commit with a prose body, annotated vX.Y.Z tag, then push only when told. Use when the user says "cut a release", "release 0.3.3", "ship a version", or "the whole release shebang" in this repository.
---

# Cutting a c2c-conv release

There is no release task and no release workflow: the bump is by hand and a
release is a commit plus an annotated tag on `master`. The value of this skill
is the bump rule, the docs sweep, and knowing that CI never sees the release
commit before it is pushed.

## 1. Pre-flight

- On `master`, tree clean, up to date with `origin/master` (Forgejo; GitHub is a
  push mirror). Feature work for this release is merged.
- Previous version: `git describe --tags --abbrev=0` (tags are `vX.Y.Z`).
  Check that `package.json`'s version has a tag: a `chore(release)` commit
  without its tag means an earlier release was never tagged
  (`git log --oneline --grep 'chore(release)'` against `git tag`). Say so and
  ask whether to tag it before cutting the next one.
- **Pick the bump by the CHANGELOG header's rule**, not by "feature = minor".
  Pre-1.0, **a minor marks a change that breaks an existing checkout**: a
  dropped or renamed command, flag, ctl subcommand, mode spelling or alias; an
  output something might parse changing shape (`c2c ctl status`); an install
  path, state-dir layout or `compose.yaml` contract moving. Everything additive
  is a patch, including new protocol messages: the client and the ringmaster
  ship from the same checkout, so a new message never meets an old peer.

## 2. Docs sweep (against `git log v<last>..HEAD`)

- **`CHANGELOG.md` `[Unreleased]`** covers every user-visible change since the
  tag. Entries are added per change, so this is a completeness check: walk
  `git log v<last>..HEAD --oneline` and match each behaviour commit to an entry.
  Keep a Changelog categories (Added / Changed / Fixed / Removed). Entries are
  prose that says what the user sees, bold lead-in for a headline feature, in
  the voice of the ones already there. Anything that changes rather than adds
  goes under **Changed** and says what someone relying on the old behaviour
  will find.
- **`README.md`**: new commands, flags, ctl subcommands, MCP tools, the
  Commands table, and the `c2c --version` example line, which quotes the
  version.
- **`TODO.md`**: its opening paragraph names the version it is grounded in and
  what was done since; move it to the new version and tick or drop shipped items.
- **`CLAUDE.md` / `brain/`**: run the `brain` skill's audit scoped to what the
  release touched.
- Commit anything here as its own layer, `[master] docs(release): ...`, before
  the bump.

## 3. Bump

The version lives in `package.json` `version` only (`src/version.ts` reads it at
runtime; `test/version.test.ts` asserts the format, not the value). Afterwards
`git grep -nF '<old>' -- ':!CHANGELOG.md' ':!pnpm-lock.yaml'` should show only
prose that legitimately names the old version.

`CHANGELOG.md`: rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD` and open a
fresh empty `## [Unreleased]` above it.

## 4. Gate (all green before the commit)

```bash
pnpm install --frozen-lockfile
pnpm check     # both TypeScript builds
pnpm test      # builds, bundles, runs everything including the real-tmux test
```

`tmux` must be on PATH: the integration test fails rather than skipping without
it. CI runs the same steps, but only after the push, so this is the gate the
release commit gets before it is public. Then smoke the built CLI:
`node dist/src/cli.js --version` prints the new version.

## 5. Commit and tag

```bash
git commit -am "[master] chore(release): x.y.z" -m "<body>"
git tag -a vx.y.z -m "c2c-conv x.y.z - <theme>"
```

The body is short prose, not a copy of the changelog. It opens by saying why the
bump is a patch or a minor under the pre-1.0 rule, then calls out anything that
**changed rather than appeared** - an output, a default, a behaviour someone may
rely on. End with the Co-Authored-By trailer. Read
`git log -1 --format=%B v<last>` and `git tag -n9 v<last>` for the tone. The tag
message is one line: `c2c-conv x.y.z - ` and the theme, the features named
plainly.

## 6. Push (only when told)

The user pushes deliberately, one batch at a time. Stop after tagging and report
what is ready. When they say to push:

```bash
git push origin master --follow-tags
```

Then CI runs on the GitHub mirror once Forgejo syncs it:
`gh run list -R Arzaroth/c2c-conv -L 1` and
`gh run watch -R Arzaroth/c2c-conv <id> --exit-status`. If it goes red, fix on
master in a new commit and cut the next patch; never move a pushed tag.

## Done when

The release commit and annotated tag exist on master, the gate was green, the
docs match, and either the push happened and CI is green, or the user has been
told the release is ready to push. Report the version, why it is a patch or a
minor, and the one-line theme.
