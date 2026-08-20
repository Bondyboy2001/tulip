// @ts-check
/* Country flags are stored as Unicode prefixes in `.language.md` filenames.
   That keeps the choice portable without frontmatter or sidecar files. */

import { LANGUAGE_FLAG } from './vault-paths.js'

const CODES = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL
BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV
CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD
GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM
IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK
LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW
MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR
PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS
ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY
UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW XK
`.trim().split(/\s+/)

const names = new Intl.DisplayNames(['en'], { type: 'region' })

function countryFlag (code) {
  return [...String(code || '').toUpperCase()]
    .map((letter) => String.fromCodePoint(0x1F1E6 + letter.charCodeAt(0) - 65))
    .join('')
}

export const COUNTRIES = CODES
  .map((code) => ({
    code,
    flag: countryFlag(code),
    name: code === 'XK' ? 'Kosovo' : names.of(code)
  }))
  .filter((country) => country.name && country.name !== country.code)
  .sort((a, b) => a.name.localeCompare(b.name))

/** The country back out of its flag — countryFlag's inverse. */
export function countryCode (flag) {
  const letters = [...String(flag || '')]
    .map((char) => char.codePointAt(0) - 0x1F1E6)
    .filter((at) => at >= 0 && at < 26)
    .map((at) => String.fromCharCode(65 + at))
  return letters.length === 2 ? letters.join('') : ''
}

export function languageIdentity (value) {
  const text = String(value || '')
  const match = LANGUAGE_FLAG.exec(text)
  return {
    flag: match?.[1] || '',
    name: match ? text.slice(match[0].length) : text
  }
}
