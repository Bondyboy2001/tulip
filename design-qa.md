# Attachment composer design QA

Reference: `codex-clipboard-3c121c45-946a-4218-83d3-dc934e7c6404.png`

Implementation checked in the installed `/Applications/Tulip.app` at the current Copilot panel width and dark theme.

## Comparison

- Placement: attachment card appears at the top-left of the composer, above the message field.
- PDF: red PDF document icon, truncated filename, secondary PDF label, and a direct remove button are visible.
- Image: the composer shows a 48 by 48 pixel thumbnail with a direct remove button and no filename or path text.
- Text field: remains empty after attaching; neither attachment type exposes its filesystem path.
- Layout: cards wrap inside the composer and do not displace the model or send controls beyond the panel edge.
- Accessibility: the attachment group and each remove button have descriptive labels.

No P0, P1, or P2 visual differences remain. The implementation uses Tulip's existing type, colour tokens, control sizing, and focus treatment rather than copying the reference application's surrounding chrome.

final result: passed
