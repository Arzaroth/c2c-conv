# The keypad

Claude asks things with arrow-key menus: permission prompts, `/model`, plan
approval, the workspace-trust dialog. When the pane state becomes `dialog`
([../architecture/screen.md](../architecture/screen.md#pane-states)) the browser
shows a keypad so a bozo can drive the menu rather than watch their text sit
held.

- The ringmaster accepts only `ALLOWED_KEYS`: arrows, Enter, Escape, Tab,
  `BSpace`, digits 1-9. Nothing else, so no `C-c` and no control sequences. The
  browser keypad offers the arrows, 1-3, Enter and Esc.
- **The gallery cannot answer.** The ringmaster refuses the key (`key:refused`),
  not just the UI: answering a permission dialog is a side effect, and gallery
  means no side effects.
- Yolo bozos and **the whiteface in either mode** may press keys: the whiteface is
  the host. This is how a headless or container host answers the trust dialog.
- Keys bypass the [outbox](outbox.md): a keystroke should not wait out a queued
  text injection.

Why text and keys are separate channels:
[../decisions.md](../decisions.md#0003-text-and-keys-are-two-channels-with-opposite-guards).

## Sources

- `src/policy.ts` (`submitKey`, `ALLOWED_KEYS`)
- `src/ringmaster.ts` (`#pressKey`, `#onGuestMessage`)
- `web/client.ts` (keypad), `web/index.html`
