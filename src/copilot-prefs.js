/* The copilot panel's own preferences — the handful of choices that belong to
   the reader rather than to a conversation, and so live in localStorage
   instead of the vault's config.

   One place for the keys, so a second surface for the same choice (a Settings
   row, a reset) cannot spell the key differently from the panel that reads it.
   Every access is guarded: a page that forbids storage is a panel with
   defaults, not a panel that will not open. */

const THINK_KEY = 'tulip.copilot.showThinking'

export const thinkingPref = {
  get () {
    try { return localStorage.getItem(THINK_KEY) === '1' } catch { return false }
  },
  set (on) {
    try { localStorage.setItem(THINK_KEY, on ? '1' : '0') } catch {}
  }
}
