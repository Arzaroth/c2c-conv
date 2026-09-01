# c2c-conv 🤡

*clown to clown conversation*

Share one Claude Code session with a second person. They watch it live, and when
you let them, they talk to it as if they were you.

Not a screen share. Guest messages land in the session as genuine typed input:
`origin: {kind: "human"}`, `promptSource: "typed"`, no wrapper, no tag. Claude
cannot tell the difference. See [docs/FEASIBILITY.md](docs/FEASIBILITY.md) for
how that was verified.

## Requirements

`tmux`, `node >= 20`, and `claude` on PATH. No npm install, no dependencies.

## Use

```sh
c2c host                       # start a shared session and attach to it
c2c host -- --model opus       # anything after -- goes to claude
```

That prints an invite. By default the relay binds loopback, so your guest arrives
over ssh:

```sh
ssh -N -L 7331:127.0.0.1:7331 you@your-machine
```

They open `http://127.0.0.1:7331/?t=<token>` and see your session live.
`c2c invite` reprints the instructions at any time.

## Getting a guest in from anywhere

Three rungs, all carrying the same client and the same guarantees. Pick by what
your network allows:

```sh
c2c host                                   # loopback, guest forwards a port
c2c host --bind 100.64.0.39                # serve a tailnet address directly
c2c host --broker wss://broker.example.com --room standup
```

The broker rung has both sides dial *out*, so it works when neither machine can
reach the other. Run one anywhere with `c2c broker`, or
`node broker/server.js --port 8080`. Your guest opens
`https://broker.example.com/r/standup?t=<token>` and installs nothing.

Details and wire protocol in [docs/TRANSPORTS.md](docs/TRANSPORTS.md).

## The two modes

Guests start as **spectators**. They see everything, and anything they send waits
for you. You handle it without leaving the session:

| key | |
|---|---|
| `prefix + a` | release the next waiting message |
| `prefix + d` | drop it |
| `prefix + y` | toggle spectator / yolo |

The status bar carries the state the whole time, so you are never guessing:

```
c2c spectator | 1 guest | 2 waiting (prefix+a approve, prefix+d deny)
```

This is deliberate. Spectator is both the default and the safe mode, and if
approving meant switching to another terminal to type a command, people would
just leave the session in yolo instead. A safe path that is annoying is not a
safe path.

There is a full CLI too, for scripting or a second window:

```
c2c ctl status            # who is connected, what is waiting
c2c ctl approve 3         # release a specific message
c2c ctl deny 3
```

## When the session asks a question

Claude asks things with arrow-key menus: permission prompts, `/model`, plan
approval. The guest client notices and shows a keypad, so a guest can drive the
menu rather than watching helplessly while their text sits held.

**Spectators cannot answer.** Not just a greyed-out button: the relay refuses the
keypress, because answering a permission dialog is a side effect and spectator
mode means no side effects. Only yolo unlocks it.

When you trust them, elevate:

```sh
c2c ctl mode yolo         # guest messages go straight in
c2c ctl mode spectator    # back to the gate
```

**In yolo mode your guest can run arbitrary commands as you.** A prompt can ask
for anything, so there is no version of "prompts only, no approvals" that is also
safe. Elevate for people you would hand your actual keyboard to.

## Commands

| | |
|---|---|
| `c2c host [-s NAME] [-p PORT] [--bind ADDR] [--broker URL] [--room NAME] [--cwd DIR] [-- args]` | start a shared session |
| `c2c attach [-s NAME]` | reattach your terminal |
| `c2c invite [-s NAME]` | reprint the guest instructions |
| `c2c ctl <status\|list\|mode\|approve\|deny\|approve-all\|deny-all>` | host control |
| `c2c stop [-s NAME]` | tear it down |
| `c2c broker [-p PORT] [--bind ADDR]` | run a rendezvous broker |

Runs on its own tmux server (`-L c2c`) with a clean config, so it will not touch
your existing tmux - and the prefix inside a c2c session is always `C-b`, even if
you use something else in your own setup.

## History

The mirror shows the current screen, so a guest who joins late has no idea what
came before. The **history** tab fills that in: the conversation so far, from the
first turn, as readable turns rather than replayed ANSI - what was asked, what
Claude said, and which tools it reached for.

It is built from Claude Code's own session transcript, which is an undocumented
file format, so it is treated as strictly optional. If it cannot be read the
mirror is unaffected and the tab simply stays empty.

## If a message gets held

Guest messages are held rather than injected when the session is not ready for
them, and you get a tmux notice saying which:

- **you have an unsent draft** in the prompt box, so injecting would splice the
  guest's words into your half-typed line
- **the pane is a dialog**, so the text would go nowhere and the trailing Enter
  would confirm whatever is highlighted
- **the pane is in tmux copy mode**, where text is read as copy-mode commands
  rather than typed into claude (press `q` to leave it)

Clear or send your draft, or answer the dialog, and the guest can resend.

## Status

v0. Works end to end. Rough edges are listed in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#open-work).
