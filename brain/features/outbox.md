# The outbox

Being cleared to send is not being sent. Everything past the gate (straight
through in yolo, or released by the host in the gallery) lands in the outbox,
which delivers one message at a time and waits for the session to be free.

Everyone sees it, with their own place in the line and why the head is not
moving. The whiteface can pull one back (`cancel`, `cancel-all`) or move one to
the front (`bump`); so can `c2c ctl outbox|cancel|cancel-all|bump`.

## Why a message is waiting

One tmux notice per reason, not one per attempt:

| reason | | clears when |
|---|---|---|
| `busy` | the session is still working | the turn ends (in `through`, it goes in anyway) |
| `draft` | the host has unsent text in the prompt box, and injecting would splice into it | the host sends or clears the draft |
| `dialog` | the text would go nowhere and the Enter would confirm the highlighted option | someone answers the dialog |
| `copy-mode` | text would be read as copy-mode commands | the host presses `q` |
| `unknown` | the screen matched nothing known | the pane shows a prompt again |

Nobody has to resend: the queue drains on its own. Only a dead pane (`dead`), a
failed write (`error`) or a full outbox (50, `MAX_OUTBOX`, reported as `error`)
loses a message, and all three are loud on every surface.

A dim suggested prompt in an empty box is not a draft and does not hold anything
([../architecture/screen.md](../architecture/screen.md#ghost-suggestions)).

## drain and through

`c2c host --outbox drain` (default) waits for each turn to end before the next
message, so the order and cancellation stay with c2c. `--outbox through` types
into a working session and lets claude queue it in its own UI: faster, but
nothing can be cancelled once it is in. Even in `through`, a dialog or copy mode
holds the message.

Why it exists: [../decisions.md](../decisions.md#0004-a-cleared-message-is-never-dropped-for-being-busy).
Mechanics: [../architecture/gate.md](../architecture/gate.md#the-outbox).

## Sources

- `src/outbox.ts`, `src/ringmaster.ts` (`#deliver`, `#onOutboxEvent`, `holdText`)
- `web/client.ts` (outbox strip)
