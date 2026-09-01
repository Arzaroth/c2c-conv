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

That prints a guest link. The relay binds to loopback, so get your guest there
over ssh or tailscale:

```sh
ssh -N -L 7331:127.0.0.1:7331 you@your-machine
```

They open `http://127.0.0.1:7331/?t=<token>` and see your session live.

## The two modes

Guests start as **spectators**. They see everything, and anything they send waits
for you:

```
c2c ctl status            # who is connected, what is waiting
c2c ctl approve 3         # release message #3 into the session
c2c ctl deny 3
```

You get a tmux notice in your pane whenever something queues up, so you do not
have to watch a second window.

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
| `c2c host [-s NAME] [-p PORT] [--cwd DIR] [-- args]` | start a shared session |
| `c2c attach [-s NAME]` | reattach your terminal |
| `c2c ctl <status\|list\|mode\|approve\|deny\|approve-all\|deny-all>` | host control |
| `c2c stop [-s NAME]` | tear it down |

Runs on its own tmux server (`-L c2c`), so it will not touch your existing tmux.

## Status

v0. Works end to end. Rough edges are listed in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#open-work) - the notable ones are
input arbitration when both people type at once, and guests joining mid-session
only getting the visible screen rather than full scrollback.
