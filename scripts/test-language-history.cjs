'use strict'

/** Focused lifecycle checks for `.tulip/language-history.json`. */

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { makeStore, languageRows } = require('../electron/language-history-store')

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) return
  failures++
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

const table = (...rows) => [
  '| Word | English | Example | Notes |',
  '| --- | --- | --- | --- |',
  ...rows
].join('\n') + '\n'

async function main () {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'tulip-language-history-'))
  let clock = 1_000
  let nextId = 0
  const make = () => makeStore({
    vault: () => vault,
    now: () => clock,
    makeId: () => `row-${++nextId}`
  })

  try {
    const store = make()
    const blank = table('|  |  |  |  |')
    check('blank scaffold is not learned', (await store.sync('Greek/Vocabulary.language.md', blank)).length === 0)

    const first = table(
      '| νερό | water | Θέλω νερό. |  |',
      '| ψωμί | bread |  |  |'
    )
    const created = await store.sync('Greek/Vocabulary.language.md', first)
    check('complete rows receive dates', created.length === 2 && created.every((row) => row.addedAt === 1_000))
    check('rows receive stable ids', created.map((row) => row.id).join(',') === 'row-1,row-2')

    clock = 2_000
    const edited = await store.sync('Greek/Vocabulary.language.md', table(
      '| νερό | water | Πίνω νερό. | common |',
      '| ψωμί | bread |  |  |'
    ))
    check('editing preserves the added date', edited[0].id === 'row-1' && edited[0].addedAt === 1_000)
    check('editing advances only that row', edited[0].editedAt === 2_000 && edited[1].editedAt === 1_000)

    clock = 3_000
    const moved = await store.sync('Greek/Vocabulary.language.md', table(
      '| ψωμί | bread |  |  |',
      '| νερό | water | Πίνω νερό. | common |'
    ))
    check('reordering follows row identity', moved.map((row) => row.id).join(',') === 'row-2,row-1')
    check('reordering is not an edit', moved[1].editedAt === 2_000 && moved[0].editedAt === 1_000)

    const withIncomplete = table(
      '|  | pending |  |  |',
      '| ψωμί | bread |  |  |',
      '| νερό | water | Πίνω νερό. | common |'
    )
    const shifted = await store.sync('Greek/Vocabulary.language.md', withIncomplete)
    check('incomplete rows receive no history', shifted.length === 2)
    check('visible row indexes include incomplete rows', shifted[0].row === 1 && shifted[1].row === 2)
    check('parser keeps escaped pipes', languageRows(table('| a\\|b | value |  |  |'))[0].cells[0] === 'a|b')

    await store.relocate('Greek', 'Languages/Greek')
    check('folder moves carry row history', (await store.rows('Languages/Greek/Vocabulary.language.md')).length === 2)
    check('old paths are removed after a move', (await store.rows('Greek/Vocabulary.language.md')).length === 0)

    const reloaded = make()
    const persisted = await reloaded.rows('Languages/Greek/Vocabulary.language.md')
    check('history survives a fresh store', persisted[1].id === 'row-1' && persisted[1].addedAt === 1_000)

    clock = 4_000
    const baseline = await reloaded.sync(
      'Languages/Greek/Older Vocabulary.language.md',
      table('| παλιός | old | old house |  |'),
      { trackNew: false }
    )
    check('existing rows are not falsely dated', baseline[0].addedAt == null && baseline[0].editedAt == null)
    clock = 5_000
    const oldEdited = await reloaded.sync(
      'Languages/Greek/Older Vocabulary.language.md',
      table('| παλιός | old | very old house |  |')
    )
    check('an old row starts with an honest edited date',
      oldEdited[0].addedAt == null && oldEdited[0].editedAt === 5_000)

    await reloaded.remove('Languages/Greek')
    check('folder deletion removes its history', (await reloaded.rows('Languages/Greek/Vocabulary.language.md')).length === 0)

    /* A cold store asked for the same note twice before either read finishes.
       `load` used to publish an empty history the moment it was entered, so the
       second caller decided every row was new: fresh ids, and today stamped
       over the real added date. Both callers must see what is on disk. */
    const note = 'Race/Vocabulary.language.md'
    const onDisk = table(
      '| νερό | water | Θέλω νερό. |  |',
      '| ψωμί | bread | Τρώω ψωμί. |  |'
    )
    clock = 8_000
    const settled = await make().sync(note, onDisk)
    check('the fixture has history to lose',
      settled.length === 2 && settled.every((row) => row.addedAt === 8_000))

    clock = 9_000
    const cold = make()
    const [a, b] = await Promise.all([cold.sync(note, onDisk), cold.rows(note)])
    check('a concurrent read keeps the stored ids',
      a.map((row) => row.id).join(',') === settled.map((row) => row.id).join(','),
      `${a.map((row) => row.id)} vs ${settled.map((row) => row.id)}`)
    check('a concurrent read keeps the stored added dates',
      a.every((row) => row.addedAt === 8_000))
    check('both callers of a cold load agree', b.length === settled.length)
  } finally {
    await fs.rm(vault, { recursive: true, force: true })
  }

  if (failures) process.exitCode = 1
  else console.log('language history: all checks passed')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
