# c2c-conv 🤡

*clown to clown conversation*

Share one Claude Code session with a second person. They watch it live, and when
you let them, they talk to it as if they were you.

Not a screen share. Bozo messages land in the session as genuine typed input:
`origin: {kind: "human"}`, `promptSource: "typed"`, no wrapper, no tag. Claude
cannot tell the difference. See [docs/FEASIBILITY.md](docs/FEASIBILITY.md) for
how that was verified.

## The names

It is a circus, but the names are load-bearing rather than decorative:

| name | what it is |
|---|---|
| **bigtop** | the tent everyone gathers in: the rendezvous server both sides dial out to |
| **ringmaster** | runs one shared session: holds the mode, gates what reaches the ring |
| **bozo** | your guest. The premise is clown to clown, so there are two of you |
| **the gallery** | the cheap seats. A bozo watches and can heckle, but cannot act |
| **yolo** | the other mode. A bozo in yolo types as you do, with your permissions |
| **f2f** | farce-to-farce: the lane between the clowns. Claude never hears it |
| **the outbox** | what is cleared to send and waiting for the session to be free |
| **HOINK** | the greeting. A bozo hoinks its name, the ringmaster hoinks back |

`yolo` kept its name on purpose. The circus word for it was `ring`, which reads
as a place rather than a warning, and this is the mode where someone else runs
commands as you. A name that says "this is dangerous" is worth more than a
consistent metaphor.

Borrowed vocabulary is left alone: tmux panes, websockets and transcripts keep
their real names, because renaming terms owned by the tools underneath makes the
code harder to map onto them.

`--broker`, `c2c broker`, `mode spectator` and `mode ring` still work as aliases.

## Requirements

`tmux`, `node >= 20`, `pnpm`, and `claude` on PATH. Nothing ships as a
runtime dependency: `pnpm install` fetches TypeScript, vite and xterm, the
build folds xterm into the page, and none of them is present by the time
anything runs. A bozo's browser loads nothing from a CDN.

## Build and install

The source is TypeScript, so there is a compile step. `src/`, `bigtop/` and
`test/` build to `dist/`; vite bundles `web/` to `dist/web`, which is what the
ringmaster serves to a browser. `dist/` is gitignored.

```sh
mise trust && mise run install     # pnpm install, build, then symlink ~/.local/bin/c2c
c2c --version                      # 0.3.1 (99ebb92), and which checkout it points at
```

`mise tasks` lists the rest: `deps`, `build`, `test`, `check`, `host`, `local`,
`bigtop`, `zavatta`, `status`, `invite`, `stop`, `uninstall`, `docker:build`,
`docker:host`. Everything that runs code builds first, so there is no
stale-`dist/` trap.

`mise run check` type-checks both builds without emitting. There is no separate
lint step: the compiler is the lint step.

Without mise, `pnpm install && pnpm run build` then
`ln -s "$PWD/dist/src/cli.js" ~/.local/bin/c2c`, or `pnpm link --global`, or just
run `node dist/src/cli.js` wherever the docs say `c2c`.

Because it is normally a symlink into a checkout, `c2c --version` reports the
commit as well as the release, and marks it `-dirty` when the working tree has
changes - so you can tell what is actually installed.

[CHANGELOG.md](CHANGELOG.md) says what each release changed, and which ones
break an existing checkout.

## Use

```sh
c2c host                       # start a shared session and attach to it
```

**Which directory.** The session starts in your current directory, so `cd` to
the project first. Or point at it: `c2c host --cwd ~/Repos/thing`.

**Which model, and any other claude flag.** Everything after `--` is handed to
`claude` untouched:

```sh
c2c host -- --model opus
c2c host --cwd ~/Repos/thing -- --model opus --permission-mode plan
c2c host -- --append-system-prompt "keep answers short"
```

Arguments are quoted properly on the way through, so ones containing spaces
survive.

That prints an invite. By default the ringmaster binds loopback, so your bozo arrives
over ssh:

```sh
ssh -N -L 7331:127.0.0.1:7331 you@your-machine
```

They open `http://127.0.0.1:7331/?t=<token>` and see your session live.
`c2c invite` reprints the instructions at any time.

## Getting a bozo in from anywhere

Three rungs, all carrying the same client and the same guarantees. Pick by what
your network allows:

```sh
c2c host                                   # loopback, bozo forwards a port
c2c host --tunnel                          # public URL via cloudflared
c2c host --bind 100.64.0.39                # serve a tailnet address directly
c2c host --bigtop wss://bigtop.example.com --room standup
```

`--tunnel` is the quickest way to share with someone right now: cloudflared
connects out, so there is nothing to deploy and nothing to forward, and you get
a `https://...trycloudflare.com` link to send. It needs the `cloudflared` binary - from your package manager, or `npm i
cloudflared` which c2c will pick up out of `node_modules/.bin`.
The link is **public** - the token is the only thing protecting it - and the
tunnel dies with the session rather than outliving it.

The bigtop rung has both sides dial *out*, so it works when neither machine can
reach the other. Run one anywhere with `c2c bigtop`, or
`node dist/bigtop/server.js --port 8080`. Your bozo opens
`https://bigtop.example.com/r/standup?t=<token>` and installs nothing.

Details and wire protocol in [docs/TRANSPORTS.md](docs/TRANSPORTS.md).

## The two modes

Bozos start in **the gallery** - the cheap seats. They see the whole show and can
heckle, but nothing they shout reaches the ring until you let it. Anything they
send waits for you, and you handle it without leaving the session:

| key | |
|---|---|
| `prefix + a` | release the next waiting message |
| `prefix + d` | drop it |
| `prefix + y` | toggle gallery / yolo |

The status bar carries the state the whole time, so you are never guessing:

```
c2c gallery | 1 bozo | 2 waiting (prefix+a approve, prefix+d deny)
```

This is deliberate. Gallery is both the default and the safe mode, and if
approving meant switching to another terminal to type a command, people would
just leave the session in ring instead. A safe path that is annoying is not a
safe path.

There is a full CLI too, for scripting or a second window:

```
c2c ctl status            # who is connected, what is waiting, what is going in
c2c ctl approve 3         # release a specific message
c2c ctl deny 3
c2c ctl cancel o2         # pull one back out of the outbox
c2c ctl kick 01a8c1a0     # show one bozo the door
```

## Headless: web only, nobody at the terminal

```sh
c2c host --no-attach --tunnel
```

Nothing is attached and the whole session runs from the browser. Because there
are no prefix keys to press, a detached session mints a second link:

```
  your own link, which makes you the whiteface (keep it to yourself):
    https://....trycloudflare.com/?t=<bozo token>&w=<whiteface token>
```

The **whiteface** is the clown who runs the ring. Open that link and you get
release, drop and the mode switch in the browser, so the gallery still works
with nobody at a terminal - you approve from your phone if you like. Bozos get
the ordinary link without the `w=`.

The whiteface token is a **separate secret** from the share link on purpose:
handing someone the session must not hand them control of it. Only one bozo
holds the role at a time, the queue is shown to them alone, and every host
action is checked in the ringmaster rather than the UI - a bozo opening its own
socket and asking to approve is refused just the same.

If you would rather have no gate at all, `--yolo` starts wide open. Then the
link is the whole security boundary: anyone holding it runs commands as you,
unwatched.

## In a container

```sh
cd ~/my-project
mise run docker:build                                  # once
C2C_UID=$(id -u) C2C_GID=$(id -g) docker compose -f ~/repos/c2c-conv/compose.yaml up
```

The image has node, tmux, claude and cloudflared. The container runs one
headless session for the directory you started it from, over a tunnel, and
prints the bozo link and your whiteface link in its log. `docker stop` ends the
session the way `c2c stop` does.

It gets three things from outside, all in [compose.yaml](compose.yaml):

- **Your login.** `~/.claude` and `~/.claude.json` are bind-mounted, so log in
  on the host once. On macOS the login lives in the Keychain, so instead log in
  once from inside the container, which writes it into the mounted directory:
  `docker compose run --rm --entrypoint claude c2c`.
- **The project.** Mounted at the same path it has on the host, so the
  transcript and the workspace trust claude already recorded for it carry over.
- **The port.** Published on loopback only. Inside, c2c binds every interface
  and says so; the published port is the boundary that warning is about.

If claude asks whether to trust the folder, the session waits on that dialog.
Trust it on the host once and the container inherits the answer, or answer it
from the whiteface link: the keypad works for the whiteface in either mode.

`C2C_ARGS` replaces the default `--tunnel`: `C2C_ARGS="--tunnel --yolo"`, or
`--bigtop wss://...`. For the terminal, `docker compose exec c2c c2c attach`;
for the rest, `docker compose exec c2c c2c ctl status`.

The trust model shifts with the container: in yolo, a bozo now runs commands as
the container user over the mounted paths rather than as you over everything.

## How many bozos

Up to **30** at once, per session and per bigtop room. A clown car holds about
thirty; past that a shared terminal is a broadcast, and every bozo costs another
copy of the pane stream. The 31st is refused rather than quietly degrading
everyone else.

## When the session asks a question

Claude asks things with arrow-key menus: permission prompts, `/model`, plan
approval. The bozo client notices and shows a keypad, so a bozo can drive the
menu rather than watching helplessly while their text sits held.

**The gallery cannot answer.** Not just a greyed-out button: the ringmaster refuses the
keypress, because answering a permission dialog is a side effect and gallery
mode means no side effects. Only ring unlocks it.

When you trust them, elevate:

```sh
c2c ctl mode yolo         # bozo messages go straight in
c2c ctl mode gallery      # back to the cheap seats
```

**In the ring, your bozo can run arbitrary commands as you.** That is what the
name means: they are in the ring with you, and everything they do is real. A prompt can ask
for anything, so there is no version of "prompts only, no approvals" that is also
safe. Elevate for people you would hand your actual keyboard to.

## Commands

| | |
|---|---|
| `c2c host [-s NAME] [-p PORT] [--bind ADDR] [--bigtop URL] [--room NAME] [--cwd DIR] [-- args]` | start a shared session |
| `c2c attach [-s NAME]` | reattach your terminal |
| `c2c invite [-s NAME]` | reprint the bozo instructions |
| `c2c say <text>` | post a line to the f2f lane |
| `c2c ctl <status\|list\|mode\|approve\|deny\|approve-all\|deny-all>` | host control |
| `c2c ctl <outbox\|cancel ID\|cancel-all\|bump ID\|say TEXT>` | the outbox and the lane |
| `c2c ctl kick ID` | show one bozo the door |
| `c2c stop [-s NAME]` | tear it down |
| `c2c bigtop [-p PORT] [--bind ADDR]` | run a bigtop |

Runs on its own tmux server (`-L c2c`) with a clean config, so it will not touch
your existing tmux - and the prefix inside a c2c session is always `C-b`, even if
you use something else in your own setup.

## History

The mirror shows the current screen, so a bozo who joins late has no idea what
came before. The **history** tab fills that in: the conversation so far, from the
first turn, as readable turns rather than replayed ANSI - what was asked, what
Claude said, and which tools it reached for.

It is built from Claude Code's own session transcript, which is an undocumented
file format, so it is treated as strictly optional. If it cannot be read the
mirror is unaffected and the tab simply stays empty.

## Scrollback

The mirror is the pane, and the pane is what fits on screen. Everything above it
- the tool output, the diffs, the error you scrolled past - is in the **scrollback**
tab: a snapshot of the pane plus its history, which you can scroll, page through
and refresh.

It is deliberately a separate surface rather than scrollback on the live mirror.
The mirror renders a byte stream that positions its cursor relative to a fixed
grid, so anything that scrolls it puts every later redraw a row off. A snapshot
cannot do that: it is taken when you open the tab, and stops being live the
moment it arrives. `refresh` takes another one.

tmux keeps 10000 lines per pane, which is the ceiling on how far back it reaches.

## The f2f lane

*farce-to-farce.* Two people sharing a session could not, until now, say anything
to each other that did not go through claude. Every word a bozo typed was a
candidate prompt, so "wait, do not run that" had to either become a message to
the session or not be said at all.

The **f2f** tab is a chat lane between the clowns. Nothing in it is injected,
queued or transcribed - it never touches the pane, which is the whole point:
clown to clown is what claude hears, and this is not that.

The host has no browser panel, so their side is the terminal:

```sh
c2c say "on it, hands off the keyboard"
```

A bozo's line arrives in the pane as a tmux message. An unread count sits on the
tab for everyone else.

## The outbox

Being cleared to send is not the same as being sent. Everything past the gate -
straight through in yolo, or released by you in gallery - lands in the **outbox**,
which delivers one message at a time and waits for the session to finish the last
turn before starting the next.

Everyone can see it, along with their own place in the line, and why the head is
not moving (the session is working, you have a draft in the prompt box, a dialog
is up). The whiteface can pull one back out or move one to the front.

The point is that nothing is dropped for being busy. Before this, a message
arriving while claude was working was held and discarded with a notice, which is
the one failure this design cannot afford: everybody was told it was sent.

```sh
c2c host --outbox through
```

The other way: type into a working session and let claude do the queueing, so the
messages land in its own queue and show up in its UI. Faster, and nothing can be
cancelled once it is in. `drain` is the default.

## Letting an AI join

A second agent can join as a bozo, under exactly the same gate as a person:

```jsonc
// .mcp.json, or wherever your client keeps MCP servers
{ "mcpServers": { "c2c": { "command": "node", "args": ["/path/to/c2c-conv/dist/src/cli.js", "mcp"] } } }
```

It gets eight tools: `c2c_screen` (the session right now, as plain text),
`c2c_history` (the conversation, including turns from before it joined),
`c2c_status`, `c2c_send`, `c2c_press`, `c2c_wait`, and `c2c_say` / `c2c_f2f` for
the lane - an agent that cannot hear "wait, do not run that" is the reason the
lane exists.

`c2c_wait` blocks until the session does something worth coming back for: the
turn ends with nothing of the agent's still queued (`idle`), a question comes up
(`dialog`), claude answers (`reply`), or somebody speaks in the lane (`lane`).
Without it the only way to notice any of that is to ask for the screen in a
loop, which costs a whole screen every time round and still misses whatever
happened between two asks.

There is deliberately **no tool to approve, deny or change the mode.** An agent
that could release its own messages would not be a bozo, it would be an unlocked
door. Those stay with the host, on the tmux keys and the unix socket, reachable
only by whoever is at the machine. In gallery mode an agent's messages queue for
you like anyone else's, and it cannot answer a permission prompt at all.

Point it at a remote session with `--url wss://.../bozo?room=...&t=...`.

## If a message will not go in

It waits in the outbox, and everyone can see why. You get one tmux notice per
reason rather than one per attempt:

- **the session is still working**, so it waits for the turn to end (in
  `--outbox through` it goes in anyway and claude queues it)
- **you have an unsent draft** in the prompt box, so injecting would splice the
  bozo's words into your half-typed line
- **the pane is a dialog**, so the text would go nowhere and the trailing Enter
  would confirm whatever is highlighted
- **the pane is in tmux copy mode**, where text is read as copy-mode commands
  rather than typed into claude (press `q` to leave it)

Clear or send your draft, answer the dialog, and the queue drains on its own -
nobody has to resend. Only a dead pane or a failed write loses a message, and
both are loud on every surface.

## Status

v0. Works end to end. What is left, and why each thing is worth doing, is in
[TODO.md](TODO.md).
