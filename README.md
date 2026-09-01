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

## Install

There is nothing to build. Put `c2c` on your PATH with either:

```sh
npm link                       # symlinks c2c into your npm prefix
ln -s "$PWD/src/cli.js" ~/.local/bin/c2c
```

Or skip it entirely and run `node src/cli.js` wherever the docs say `c2c`.

## Use

```sh
c2c host                       # start a shared session and attach to it
c2c host -- --model opus       # anything after -- goes to claude
```

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
c2c host --bind 100.64.0.39                # serve a tailnet address directly
c2c host --bigtop wss://bigtop.example.com --room standup
```

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
