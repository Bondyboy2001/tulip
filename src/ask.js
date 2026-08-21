/* ========================================================== asking
   The one question the app has to stop and ask — whether to throw something
   away — asked in the app's own dialog rather than the system's. A promise, so
   the caller reads the way `window.confirm` did.

   Its own module because it is a primitive, not a feature: the tree, the
   context menu, the overlays, the attachment sweep and the language keyboard
   all reach for it. It lived inside the attachment code, which is the one
   caller it had no more to do with than any other.
   ================================================================== */

/**
 * @param {object} el  the DOM registry — the dialog, its two buttons and its
 *                     two lines of text
 * @returns {{ask: (q: object) => Promise<boolean>, answer: (yes: boolean) => void,
 *            armed: () => boolean}}
 */
export function mountAsk (el) {
  let asking = null   // { settle, danger } while a question is on screen

  /**
   * @param {object} q
   * @param {string} q.title     the question, in as few words as it takes
   * @param {string} [q.detail]  the consequence, for the few that have one
   * @param {string} [q.go]      the label on the button that does it
   * @param {boolean} [q.danger] whether doing it destroys something — a trash,
   *                             a restart, a replace-all
   * @returns {Promise<boolean>}
   */
  function ask ({ title, detail = '', go = 'OK', danger = false }) {
    // A second question while one is up would strand the first one's caller.
    if (asking) answer(false)

    el.askTitle.textContent = title
    el.askDetail.textContent = detail
    el.askDetail.hidden = !detail
    el.askGo.textContent = go
    el.ask.hidden = false

    const returnTo = document.activeElement
    /* The filled action is the dialog's default: Return activates it wherever
       focus happens to be, while Escape remains the unambiguous way back.

       Except where doing it destroys something. Every platform's destructive
       alert lands on Cancel, for the reason this one has to as well: these
       dialogs arrive unbidden, mid-keystroke, and a reflex Return on a focused
       "Move to Trash" is the whole of the mistake. The filled styling stays on
       the destructive button — which action is which is a separate statement
       from which one is armed. */
    if (danger) el.askCancel.focus()
    else el.askGo.focus()

    return new Promise((resolve) => {
      asking = {
        danger,
        settle: (yes) => {
          asking = null
          el.ask.hidden = true
          if (returnTo instanceof HTMLElement) returnTo.focus?.()
          resolve(yes)
        }
      }
    })
  }

  function answer (yes) {
    asking?.settle(yes)
  }

  /**
   * Whether Return should take the destructive action outright.
   *
   * False for a question that destroys something: there the key follows focus,
   * which `ask` has deliberately put on Cancel. The window's keydown handler is
   * what actually presses a button, and it has to ask rather than assume — it
   * runs before focus is consulted at all.
   */
  const armed = () => !asking?.danger

  el.askCancel.addEventListener('click', () => answer(false))
  el.askGo.addEventListener('click', () => answer(true))
  // Clicking the dimmed page behind it is the same as saying no, the way it is
  // for every other overlay in the app.
  el.ask.addEventListener('mousedown', (e) => { if (e.target === el.ask) answer(false) })

  return { ask, answer, armed }
}
