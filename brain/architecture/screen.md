# Reading the screen

Pane state and the host's draft both come from parsing a `capture-pane`.
`classifyScreen` and `readPromptBox` are pure functions with their own tests
(`test/screen.test.ts`), because every subtlety here was found the hard way.

## Pane states

`paneState` returns, in order of precedence:

| State | How |
|---|---|
| `dead` | `paneAlive` is false |
| `copy-mode` | `#{pane_in_mode}` is set: text would be read as copy-mode commands |
| `dialog` | `Enter to confirm` or `Esc to cancel / reject / go back` from the input box's top rule down, or anywhere when no box is drawn. Above the box it is transcript: a cancelled usage-limit countdown leaves `esc to cancel` there and once wedged the outbox |
| `busy` | `esc to interrupt` on screen: a turn is running |
| `prompt` | `readPromptBox` finds an input box |
| `unknown` | none of the above |

The ringmaster polls it every second and broadcasts changes as `state`; the
browser shows the [keypad](../features/keypad.md) on `dialog`.

## readPromptBox

- **The footer is not a signal.** It reads `? for shortcuts` when idle, but that
  disappears as soon as the host types a character, so footer-keyed detection
  reports `unknown` for any drafted pane. The box is identified structurally: a
  `❯` line directly under a rule of at least 20 `─`, within the last 8 lines.
- **Submitted turns are echoed with the same marker.** A bare-marker scan finds
  the last submitted message and reports it as a draft, so every follow-up would
  look like it splices into one. The rule above is what tells them apart, and
  the lowest marker in the window is the one checked: a slash command's echo is
  short enough to share the last 8 lines with the box, and taking the first
  marker read the pane as `unknown` and held the outbox for good.
- **No input box is `null`, not `''`.** The box vanishes briefly during
  redraws; conflating that with empty is what made the settle step necessary.

### Ghost suggestions

Claude paints a suggested prompt into the empty box in dim text (SGR 2), which
tab accepts. Nobody typed it and it is repainted after every turn, so reading it
as a draft wedged every queued message behind a line nobody wrote. The
characters are identical either way; only the colour differs. So `promptDraft`
is the one read that keeps its escapes (`capturePane`, with `-e`), and
`unpaint` removes dim runs before stripping the remaining SGR codes.

## The injection guard

`send-keys` of text plus `Enter` into a pane showing a modal types into nothing
and then confirms whatever option is highlighted. Found during the first
end-to-end run: an approved bozo message arrived while the workspace-trust
dialog was up, and the trailing Enter selected `No, exit` and killed the
session. The same mechanism would let an innocuous message confirm a permission
prompt, which would defeat the gallery.

So every text write goes through the outbox's `#deliver`
([gate.md](gate.md#the-outbox)):

1. **Wait for a prompt.** In `drain`, `waitForPrompt` polls every 250ms for up to
   15s while `busy`. In `through`, a `busy` pane is accepted (claude queues what
   is typed mid-turn); a dialog or copy mode never is.
2. **The draft guard.** `promptDraft` non-empty means the host has an unsent
   draft, and injecting would splice bozo words into it. Held with reason
   `draft`.
3. **Submit**, then **settle**: `send-keys` returns once tmux has queued the
   keys, well before claude renders them, so the next message would catch this
   one mid-render and be held as a phantom draft. `#settle` waits for the box to
   read empty twice running (5s cap, 1.5s in `through`, where a busy session may
   not draw the box at all). This cost two wrong fixes before the cause was
   clear.

Anything not `prompt` comes back as a retryable hold with the state as its
reason; `dead` and a thrown write are the only non-retryable outcomes.

What stays unhandled: the host starting to type in the same instant an injection
lands. That needs a lock the TUI does not offer.

## Sources

- `src/tmux.ts` (`classifyScreen`, `readPromptBox`, `unpaint`, `GHOST`,
  `paneState`, `promptDraft`, `waitForPrompt`)
- `src/ringmaster.ts` (`#deliver`, `#settle`, `#watchPaneState`)
- `test/screen.test.ts`, `test/tmux.integration.test.ts`
