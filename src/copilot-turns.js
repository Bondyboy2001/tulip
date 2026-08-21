let sequence = 0

/** A renderer-local identity that also travels over IPC with every event. */
export function newTurnId () {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `turn-${Date.now().toString(36)}-${(sequence++).toString(36)}`
}

/** Only the turn that asked may consume a subprocess event. */
export const ownsTurn = (turn, event) =>
  !!turn?.id && typeof event?.turnId === 'string' && event.turnId === turn.id
