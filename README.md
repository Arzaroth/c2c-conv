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

`tmux`, `node >= 20`, and `claude` on PATH. No dependencies to install.

## Build and install

There is nothing to build: no dependencies, no compile step. Installing means
putting `c2c` on your PATH.

```sh
mise trust && mise run install     # symlinks ~/.local/bin/c2c
c2c --version                      # 0.1.0 (38c6eba), and which checkout it points at
```

`mise tasks` lists the rest: `test`, `check`, `host`, `local`, `bigtop`,
`zavatta`, `status`, `invite`, `stop`, `uninstall`.

Without mise, `ln -s "$PWD/src/cli.js" ~/.local/bin/c2c`, or `npm link`, or just
run `node src/cli.js` wherever the docs say `c2c`.

Because it is normally a symlink into a checkout, `c2c --version` reports the
commit as well as the release, and marks it `-dirty` when the working tree has
changes - so you can tell what is actually installed.

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
`node bigtop/server.js --port 8080`. Your bozo opens
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
c2c ctl status            # who is connected, what is waiting
c2c ctl approve 3         # release a specific message
c2c ctl deny 3
```

## Headless: web only, nobody at the terminal

```sh
c2c host --no-attach --yolo --tunnel
```

Nothing is attached, and the whole session is driven from the browser. A bozo
can send messages, and because the keypad works in yolo it can answer the
session's own questions too - permission prompts, `/model`, plan approval - so
no terminal is needed at any point.

**Headless implies yolo, and that is not an accident.** The approval keys are
tmux bindings that need an attached client, so a detached gallery session is one
where nothing can ever be released except from `c2c ctl` on the machine itself.
c2c says so if you start detached without `--yolo`.

Which means the link is the whole security boundary: anyone holding it runs
commands as you, unwatched. Use `--token` you chose, keep it tight, and
`c2c stop` when you are done.

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
| `c2c ctl <status\|list\|mode\|approve\|deny\|approve-all\|deny-all>` | host control |
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

## Letting an AI join

A second agent can join as a bozo, under exactly the same gate as a person:

```jsonc
// .mcp.json, or wherever your client keeps MCP servers
{ "mcpServers": { "c2c": { "command": "node", "args": ["/path/to/c2c-conv/src/cli.js", "mcp"] } } }
```

It gets five tools: `c2c_screen` (the session right now, as plain text),
`c2c_history` (the conversation, including turns from before it joined),
`c2c_status`, `c2c_send` and `c2c_press`.

There is deliberately **no tool to approve, deny or change the mode.** An agent
that could release its own messages would not be a bozo, it would be an unlocked
door. Those stay with the host, on the tmux keys and the unix socket, reachable
only by whoever is at the machine. In gallery mode an agent's messages queue for
you like anyone else's, and it cannot answer a permission prompt at all.

Point it at a remote session with `--url wss://.../bozo?room=...&t=...`.

## If a message gets held

Bozo messages are held rather than injected when the session is not ready for
them, and you get a tmux notice saying which:

- **you have an unsent draft** in the prompt box, so injecting would splice the
  bozo's words into your half-typed line
- **the pane is a dialog**, so the text would go nowhere and the trailing Enter
  would confirm whatever is highlighted
- **the pane is in tmux copy mode**, where text is read as copy-mode commands
  rather than typed into claude (press `q` to leave it)

Clear or send your draft, or answer the dialog, and the bozo can resend.

## Status

v0. Works end to end. Rough edges are listed in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#open-work).
