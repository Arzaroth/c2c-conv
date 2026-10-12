# The gate

Two objects decide what reaches the pane. `Policy` decides **whether** a bozo
may send something; `Outbox` decides **when** it lands. Both live only in the
ringmaster and are mutable only through the control dispatcher (the unix socket
or a whiteface), so a bozo can never self-promote.

## Policy

`src/policy.ts`.

- **Modes.** `gallery` (default) and `yolo`. `setMode` resolves aliases through
  `ALIASES` (`spectator` -> gallery, `ring` -> yolo), so the old spellings work
  wherever a mode is named, `trust` included. `toggle` is resolved by the
  control dispatcher before it reaches `setMode`.
- **Room default plus trust.** `#mode` is the room default; `trust(bozoId, mode)`
  pins one connection, `untrust` clears it (`default` or `clear`), `forget` drops
  it on disconnect so nothing lingers for an id nobody holds. `modeFor(bozoId)`
  is what every gate asks. Overrides are keyed by connection id, not name
  ([../decisions.md](../decisions.md#0009-trust-is-per-bozo-keyed-by-connection)).
- **`submit`** normalizes (whitespace collapsed, so a newline cannot submit
  mid-message), ignores empty text, rejects past `MAX_TEXT` (8000). In yolo it
  returns `send`; in the gallery it adds a `PendingEntry` (rejected past
  `MAX_PENDING`, 50) and returns `queued`.
- **`submitKey`** rejects anything outside `ALLOWED_KEYS` (arrows, Enter,
  Escape, Tab, BSpace, digits 1-9: no `C-c`, no control sequences) and refuses
  any key from a bozo not in yolo, unless the caller is the whiteface, which is
  the host and can always answer the pane.
- **Pending** entries are released by `approve`, `deny`, `approveAll`,
  `denyAll` (and `approve-next` / `deny-next` in the dispatcher).
- **Events** drive the broadcasts, the host notices and the status line:
  `queued` goes to the whiteface alone as `policy:queued`; `approved`,
  `denied`, `sent` and `key` are broadcast as `policy:*`; `mode` and `trust`
  reach each affected bozo as its own `policy:mode` and update the roster.

### Two channels

| | text | keys |
|---|---|---|
| pane at `prompt` | yes | yes |
| pane at `dialog` | **no**, held in the outbox | **yes**, that is the point |
| bozo in the gallery | queued for approval | **refused outright** |
| bozo in yolo | yes | yes |

Why: [../decisions.md](../decisions.md#0003-text-and-keys-are-two-channels-with-opposite-guards).
The gate is in the ringmaster, not the UI: a bozo opening its own websocket and
sending a raw key is refused the same.

## The outbox

`src/outbox.ts`. Everything the policy clears (`send` in yolo, `approve` in the
gallery) is added here; it is **the only writer of text to the pane**.

- One pump, one message at a time, head first. The ringmaster's `#deliver`
  ([screen.md](screen.md#the-injection-guard)) returns `ok`, a retryable hold
  with a `HoldReason`, or a non-retryable failure.
- A retryable hold waits `RETRY_MS` (400ms) and tries again, forever. The
  reason is stored on the entry and broadcast; the host is told once per change
  of reason, not per attempt.
- Non-retryable (`dead`, `error`) drops the entry loudly, on every surface.
- Capped at `MAX_OUTBOX` (50): a cleared message arriving at a full outbox is
  dropped at enqueue, reported as `policy:held` with `error` and a tmux notice.
- `cancel`, `cancelAll` and `bump` (move to the front) work on `waiting`
  entries; a `sending` one is already on the wire.
- The whole list is broadcast as `outbox` on every change, to everyone.
- **Modes** (`--outbox`): `drain` (default) waits for each turn to end, so order
  and cancellation stay ours; `through` types into a busy pane and lets claude
  queue it, faster, but nothing can be cancelled once it is in claude's queue.

Keys skip the outbox: they are single atomic keystrokes and should not wait out
a text injection.

## Sources

- `src/policy.ts` (`Policy`, `normalize`, `ALLOWED_KEYS`, `MAX_TEXT`,
  `MAX_PENDING`, `MAX_BOZOS`, `ALIASES`)
- `src/outbox.ts` (`Outbox`, `RETRY_MS`, `MAX_OUTBOX`, `OUTBOX_MODES`)
- `src/ringmaster.ts` (`#enqueue`, `#deliver`, `#onPolicyEvent`, `#onOutboxEvent`)
- `test/policy.test.ts`, `test/outbox.test.ts`
