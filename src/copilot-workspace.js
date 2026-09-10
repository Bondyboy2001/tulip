/**
 * The Context / Instructions / Find chat workspace, as the preferences a
 * conversation carries and the capture they shape. `root` and `input`, and the
 * conversation/file helpers beside them, are the rest of that surface: the
 * call site names them so the shape stays visible while the controls move here
 * from copilot.js. Only `capture` and `chat` are read today.
 *
 * @param {{
 *   root?: HTMLElement,
 *   input?: HTMLElement,
 *   capture: (options: any) => any,
 *   chat: () => any,
 *   conversations?: () => any,
 *   selectChat?: (key: string) => any,
 *   files?: (query?: string) => any,
 *   save?: (...args: any[]) => any,
 *   quote?: (text: string) => any,
 *   warn?: (message: string) => any
 * }} options
 */
export function mountCopilotWorkspace (options) {
  const { capture, chat } = options
  const preferences = new WeakMap()
  const prefs = () => {
    const current = chat()
    if (!preferences.has(current)) preferences.set(current, { document: current.contextOptions?.document !== false, selection: current.contextOptions?.selection !== false, pins: Array.isArray(current.contextOptions?.pins) ? current.contextOptions.pins.filter((p) => typeof p === 'string').slice(0, 8) : [] })
    return preferences.get(current)
  }
  function transform (value, settings) {
    const snapshot = settings.document ? { ...value } : { contextBudget: value.contextBudget }
    if (!settings.selection) snapshot.selection = ''
    else if (!settings.document && value.selection) snapshot.selection = value.selection
    snapshot.pinned = [...settings.pins]
    return snapshot
  }
  return { capture: async (options) => {
    const settings = { ...prefs(), pins: [...prefs().pins] }
    return transform(await capture(options), settings)
  } }
}
