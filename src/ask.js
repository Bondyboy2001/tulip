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
 * @param {{ askTitle: HTMLElement, askDetail: HTMLElement, askGo: HTMLElement, askCancel: HTMLElement, ask: HTMLElement }} el  the DOM registry — the dialog, its two buttons and its
 *                     two lines of text
 * @returns {{ask: (q: object) => Promise<boolean>, answer: (yes: boolean) => void}}
 */
export function mountAsk (el) {
  /** @type {{ settle: (yes: boolean) => void } | null} */
  let asking = null   // { settle } while a question is on screen

  /**
   * @param {object} q
   * @param {string} q.title     the question, in as few words as it takes
   * @param {string} [q.detail]  the consequence, for the few that have one
   * @param {string} [q.go]      the label on the button that does it
   * @returns {Promise<boolean>}
   */
  function ask ({ title, detail = '', go = 'OK' }) {
    // A second question while one is up would strand the first one's caller.
    if (asking) answer(false)

    el.askTitle.textContent = title
    el.askDetail.textContent = detail
    el.askDetail.hidden = !detail
    el.askGo.textContent = go
    el.ask.hidden = false

    const returnTo = document.activeElement
    /* The filled action is the dialog's default, destructive or not: Return
       takes it, Escape is the unambiguous way back. Which action is which is
       said by the colour, and the key follows the colour — a question that
       asks "Move to Trash?" and then answers Return with "no" is the more
       confusing of the two mistakes. */
    el.askGo.focus()

    return new Promise((resolve) => {
      asking = {
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

  el.askCancel.addEventListener('click', () => answer(false))
  el.askGo.addEventListener('click', () => answer(true))
  // Clicking the dimmed page behind it is the same as saying no, the way it is
  // for every other overlay in the app.
  el.ask.addEventListener('mousedown', (e) => { if (e.target === el.ask) answer(false) })

  return { ask, answer }
}
