/* ================================================================= speech
   Saying the word out loud.

   A vocabulary table is silent, and a language is not. For a script the reader
   is still decoding — Greek, Cyrillic, Devanagari — the sound is half of what
   makes a word stick at all: without it every card is a shape being matched
   against a shape, and nothing said at the counter will ever match either of
   them.

   The voice is the system's. macOS ships one for most of what a learner is
   likely to be studying, the browser exposes them all through one API, and a
   language nobody's machine can speak simply gets no audio — the card is still
   a card. Nothing is downloaded, nothing is generated, and the vault is not
   made to carry sound files.

   Which language to speak in is not asked. A language folder already carries a
   flag and a name, exactly as the keyboard strip's letters are already decided
   by them; see electron/spoken-languages.json for the two maps that turn
   either into a tag.
   ================================================================== */

import ALPHABETS from '../electron/alphabets.json'
import SPOKEN from '../electron/spoken-languages.json'
import { countryCode, languageIdentity } from './countries.js'

/** Everything before the region: `pt-BR` and `pt-PT` are both Portuguese, and a
 *  machine with only one of them should still speak. */
const base = (tag) => String(tag || '').toLowerCase().split('-')[0]

/**
 * The BCP-47 tag a language folder should be spoken in.
 *
 * Which language it is comes from the name first, so `Ελληνικά` and `Greek`
 * reach the same voice, and from the flag when the name is one nobody listed —
 * the flag being the more dependable of the two, picked from a list when the
 * language is created while the name is free text somebody may have written as
 * "Greek practice".
 *
 * The region is then laid over the top, and only where it changes the voice
 * rather than the language: `🇧🇷 Portuguese` is pt-BR, and `🇧🇪 Français` stays
 * French rather than becoming the Dutch that country's entry would otherwise
 * impose. That check — same language, or ignore it — is the whole reason this
 * is two lookups instead of one.
 *
 * @param {string} folder the folder's name, flag and all
 * @returns {string} a tag, or '' for a language with no entry — which the
 *   caller must treat as "no audio", not as "guess"
 */
export function speechTag (folder) {
  const { flag, name } = languageIdentity(String(folder || '').split('/').pop() || '')
  const country = countryCode(flag)

  const family =
    SPOKEN.byName[name.trim().toLowerCase()] ||
    SPOKEN.byName[ALPHABETS.byCountry[country]] ||
    ''
  const regional = SPOKEN.byCountry[country] || ''
  if (!family) return regional
  return base(regional) === base(family) ? regional : family
}

/**
 * The system's voices, and one word said in one of them.
 *
 * Chromium fills its voice list asynchronously and answers the first call with
 * an empty array, which is why this is a small object with state rather than a
 * function: the list is re-read when the browser says it has changed, and until
 * then `has()` answers honestly rather than optimistically.
 */
export function makeSpeech (synth = globalThis.speechSynthesis) {
  let voices = []

  const refresh = () => { voices = synth ? synth.getVoices() : [] }
  if (synth) {
    refresh()
    // `voiceschanged` is how the list arrives at all on a cold start.
    synth.addEventListener?.('voiceschanged', refresh)
  }

  /**
   * The best voice for a tag: an exact regional match, then any voice of the
   * same language, then nothing. A default voice is never substituted — English
   * reading out a Greek word is worse than silence, because it teaches the
   * wrong sounds rather than none.
   */
  function voiceFor (tag) {
    if (!tag || !voices.length) return null
    const want = String(tag).toLowerCase()
    const family = base(want)
    return voices.find((voice) => voice.lang.toLowerCase().replace('_', '-') === want) ||
      voices.find((voice) => base(voice.lang.replace('_', '-')) === family) ||
      null
  }

  return {
    /** Whether this language can be spoken at all on this machine. */
    has (tag) {
      if (!voices.length) refresh()
      return !!voiceFor(tag)
    },

    /**
     * Say it, cancelling whatever was being said.
     *
     * Cancelled rather than queued: pressing on to the next card while the last
     * one is still being read leaves a voice talking over the word in front of
     * you, and by the third card it is a sentence behind.
     */
    speak (text, tag, { rate = 0.9 } = {}) {
      if (!synth || !text) return false
      const voice = voiceFor(tag)
      if (!voice) return false
      synth.cancel()
      const said = new SpeechSynthesisUtterance(String(text))
      said.voice = voice
      said.lang = voice.lang
      // A shade under natural pace. A word in a language you are learning is
      // several sounds you cannot yet predict, and the default rate is set for
      // a listener who can.
      said.rate = rate
      synth.speak(said)
      return true
    },

    stop () { synth?.cancel() }
  }
}
