# Slash menu consistency QA

- Reference: attached 840 x 794 screenshot of the previous `/` menu.
- Compared state: empty Markdown line with `/` typed, first command selected, Catppuccin theme at 2x display scale.
- Comparison target: Tulip's command palette in the same theme and display scale.
- Installed capture: `/tmp/tulip-menu-verify.Vu9fm4/menu-consistent-installed.png` from Tulip 0.1.181.

## Checks

- The menu uses the command palette's surface, one-pixel frame, 10px radius, and two-part shadow.
- Its list uses the palette's six-pixel inset, interface typeface, 13.5px labels, 7px by 11px row padding, and 6px row radius.
- The selected command uses the same `--accent-dim` fill as the selected palette row.
- Blocks and Embeds remain quiet labels within the shared palette treatment rather than separate terminal-style status bands.
- All eight commands remain visible in their existing Blocks and Embeds groups.
- Keyboard movement changes the active row from Code block to Table.
- The larger treatment is limited to `/`; `[[` note completion retains the existing compact menu.
- The menu remains inside the 1200 x 900 test window without clipping.

P0: none.

P1: none.

P2: none.

P3: none observed in the requested state.

final result: passed

---

# Kahoot-style flashcard QA

- Source visual truth: `/var/folders/zl/bz_5b3712836kh3lpj3l9w7m0000gn/T/codex-clipboard-Ye0Djq.png`.
- Implementation screenshot: `/Users/hb/projects/tulip/node_modules/.cache/flashcard-implementation.png`.
- Side-by-side evidence: `/Users/hb/projects/tulip/node_modules/.cache/flashcard-comparison.png`.
- Viewport: 455 x 809 CSS px, Chromium device scale factor 2.
- Source pixels: 455 x 809. Implementation pixels: 910 x 1618, displayed at its 455 x 809 CSS size for comparison.
- State: optional image present; second answer selected incorrectly; all answers resolved; feedback and explanation visible.

## Full-view comparison

- Typography: the question and answers use Tulip's sans interface face, with the same centered hierarchy and three-line question wrap as the reference.
- Spacing and layout: the image leads at full card width; question follows on white; four answers form a balanced two-column grid with tall touch targets. The implementation is intentionally an embedded note card rather than a full-screen phone view.
- Colors: the resolved correct answer uses bright Kahoot green and the incorrect answers use bright red; the selected answer has a clear white inset ring.
- Image quality: the supplied reference photograph stays sharp, fills the media region, and uses a cover crop without stretching.
- Copy: question and answer labels match the reference. Tulip shows explanatory feedback in place instead of a non-functional Next button because each Markdown card is independent.
- Interaction: choosing an answer disables all four choices, identifies every correct/incorrect choice, and reveals feedback and explanation. The renderer interaction test passed and the rendered QA page reported no console errors.

The full-view comparison keeps the question, answer labels, image crop, and state details legible, so a separate focused-region comparison was not needed.

## Comparison history

- First pass P1: the checked Markdown task inherited a strikethrough in Reading view. Fixed by neutralizing completed-task decoration inside quiz choices; the post-fix screenshot shows an undecorated correct answer.
- First pass P2: answer tiles were too shallow and colors were darker than the source. Fixed with taller 132px tiles and brighter green/red tokens; the post-fix side-by-side comparison matches the reference's visual weight.

## Remaining differences

- P3: the source uses circular check/cross badges and a Next button. Tulip omits the badges and replaces deck navigation with inline feedback, fitting independent cards embedded in notes.

final result: passed
