# Document toolbar design QA

## Compared states

- Reference: the supplied dark-theme screenshot, Reading selected and Copilot absent.
- Implementation: installed `/Applications/Tulip.app`, Monokai theme, Reading selected and Copilot closed.
- Interaction state: installed app also checked with Copilot open.

## Visible comparison

- The compact pill, rose active state, neutral icons, and dark-theme hierarchy are preserved.
- The targets are larger and evenly spaced, with a quieter border and a clearer raised surface.
- Copilot is a fourth direct control, separated by a divider so it is not mistaken for a document view.
- Reading and Copilot each show a distinct active state; disabled view controls remain legible without competing.
- Icons are centred, uncropped, and aligned on one baseline. The control fits the existing document header without overlap.

## Interaction and accessibility

- Reading, Editing, and Raw retain their direct buttons and keyboard shortcuts.
- Copilot opens from the new button, focuses its composer, updates `aria-pressed`, and closes from the same button.
- Hover, keyboard focus, pressed, active, and disabled states share the same shape and motion language.
- The Copilot button is labelled and linked to its controlled panel with `aria-controls`.

## Result

No P0, P1, P2, or P3 issues remain in the checked states.

final result: passed
