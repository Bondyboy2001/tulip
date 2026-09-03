const clamp = (value, low, high) => Math.max(low, Math.min(high, value))

/** Character budgets for one Copilot turn. Model windows and conversation
 * usage are tokens; the result is deliberately conservative characters so
 * the system prompt, tool traffic, and reply still have room. */
export function contextBudget ({ window = 0, used = 0 } = {}) {
  const modelWindow = Math.max(0, Number(window) || 0)
  const conversation = Math.max(0, Number(used) || 0)
  /* A model the catalogue cannot size. This used to hand out four hundred
     thousand characters of document — a hundred-odd thousand tokens quoted
     whole into a window nobody had measured, on the first turn, for a note
     the memo would then have to carry. Sized instead to what most of the
     catalogue actually has: a 128k window's share, which the memo makes
     sufficient — a longer note is quoted around the cursor and the agent is
     told to read the rest. */
  if (!modelWindow) {
    return {
      total: 120000,
      document: 80000,
      structured: 12000,
      attachments: 32768,
      pdf: 14000,
      selection: 4000
    }
  }

  const replyReserve = clamp(Math.floor(modelWindow * 0.2), 4096, 32768)
  const availableTokens = Math.max(4000, modelWindow - conversation - replyReserve)
  const total = clamp(Math.floor(availableTokens * 1.5), 12000, 240000)
  const document = Math.floor(total * 0.55)
  return {
    total,
    document,
    structured: Math.min(24000, document),
    attachments: Math.min(48000, Math.floor(total * 0.2)),
    pdf: Math.min(14000, Math.floor(total * 0.15)),
    selection: Math.min(4000, Math.floor(total * 0.08))
  }
}

/** A line-aligned window around the useful part of some text. */
export function boundedText (text, limit, focus = 0) {
  const source = String(text || '')
  const size = Math.max(0, Number(limit) || 0)
  if (!size) return { text: '', truncated: Boolean(source.length) }
  if (source.length <= size) return { text: source, truncated: false }

  const point = clamp(Number(focus) || 0, 0, source.length)
  const wanted = clamp(point - Math.floor(size * 0.35), 0, source.length - size)
  const lineStart = source.lastIndexOf('\n', wanted) + 1
  /* A single very long line must not push the focus out of its own window. */
  const from = point - lineStart < size * 0.75 ? lineStart : wanted
  const rawTo = Math.min(source.length, from + size)
  const after = source.indexOf('\n', rawTo)
  const to = after !== -1 && after - from <= size * 1.25 ? after : rawTo
  return {
    text: `${from ? '…\n' : ''}${source.slice(from, to)}${to < source.length ? '\n…' : ''}`,
    truncated: true
  }
}

const EXCERPT_BUDGET = {
  note: { whole: 400000, window: 24000 },
  code: { whole: 12000, window: 12000 }
}

/** Whole document when it fits; otherwise a line-aligned window at the caret. */
export function noteExcerpt (text, head, { code = false, maxChars = 0 } = {}) {
  const source = String(text || '')
  const base = EXCERPT_BUDGET[code ? 'code' : 'note']
  const ceiling = Math.max(1, Number(maxChars) || base.whole)
  const whole = Math.min(base.whole, ceiling)
  if (source.length <= whole) return { text: source, cut: false }
  const span = Math.min(base.window, whole)
  const windowed = boundedText(source, span, head)
  return { text: windowed.text, cut: true }
}

export function textContextKind ({ tex = false, code = false, language = false, flashcards = false, codeLanguage = '' } = {}) {
  if (tex) return 'tex'
  if (code) return String(codeLanguage || 'source').toLowerCase()
  if (language) return 'language'
  if (flashcards) return 'flashcards'
  return 'note'
}
