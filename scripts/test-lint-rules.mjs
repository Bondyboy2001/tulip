/* ======================================================== lint-rule tests

   The two rules in eslint-rules/ were each written after a defect that had
   already shipped, and each is now the only thing standing between this
   codebase and that defect coming back. A rule that silently stops matching —
   because an AST shape changed, or because someone widened an exemption to
   quieten a report — fails open: the lint run still says zero errors, which is
   exactly what it said the week the bug was there.

   So the rules get tests, and the cases below are the real code that broke.
*/

import { RuleTester } from 'eslint'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const noLayoutThrash = require('../eslint-rules/no-layout-thrash.js')
const consistentOptionalChaining = require('../eslint-rules/consistent-optional-chaining.js')

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' }
})

let ran = 0
const check = (name, rule, cases) => {
  ran += cases.valid.length + cases.invalid.length
  tester.run(name, rule, cases)
}

check('no-layout-thrash', noLayoutThrash, {
  valid: [
    /* THE FIX for the first hang. A bisection asks about a big collection in
       O(log n) probes, and a rule that flagged this would be arguing against
       the repair — so `while` is deliberately not a visit-every-member loop. */
    `let lo = 0, hi = nodes.length - 1
     while (lo < hi) {
       const mid = (lo + hi) >> 1
       if (nodes[mid].getBoundingClientRect().top < y) lo = mid + 1; else hi = mid
     }`,

    /* Registering n handlers is n handlers, not n layouts: the measurement
       happens once per drag, in a callback that outlives the loop. This shape
       is src/panels.js and was the rule's first false positive. */
    `for (const p of PANELS) {
       p.grip.addEventListener('pointerdown', () => {
         const box = p.host.getBoundingClientRect()
         use(box)
       })
     }`,
    `for (const row of rows) setTimeout(() => row.scrollIntoView(), 0)`,
    `for (const row of rows) queueMicrotask(() => { row.offsetTop })`,

    /* One element written n times is one layout and n cheap writes — the
       measurement has to be of the member for the count to matter. */
    `for (const x of xs) frame.scrollTop = 0`,

    /* Not layout at all. */
    `for (const x of xs) x.textContent = ''`,
    `for (const x of xs) total += x.length`,

    /* A counted loop that is not counting through a collection. */
    `for (let i = 0; i < 3; i++) rows[i].scrollTop = 0`
  ],

  invalid: [
    /* THE FIRST HANG, verbatim in shape: placedLines(), which could wedge the
       renderer for ever on a 1.7MB note. */
    {
      code: `const placed = [...root.querySelectorAll('[data-line]')].filter((n) => n.offsetParent !== null)`,
      errors: [{ messageId: 'thrash', data: { prop: 'offsetParent', name: 'n' } }]
    },

    /* THE SECOND HANG, three days later: applyConfig(). */
    {
      code: `for (const pre of root.querySelectorAll('pre.code-text')) pre.scrollLeft = 0`,
      errors: [{ messageId: 'thrash', data: { prop: 'scrollLeft', name: 'pre' } }]
    },

    /* Reached by subscript rather than by name — the same n layouts. */
    {
      code: `for (let i = 0; i < rows.length; i++) rows[i].scrollIntoView()`,
      errors: [{ messageId: 'thrash', data: { prop: 'scrollIntoView', name: 'i' } }]
    },

    /* Every per-member callback, not just filter. */
    {
      code: `nodes.forEach((n) => { n.scrollTop = 0 })`,
      errors: [{ messageId: 'thrash', data: { prop: 'scrollTop', name: 'n' } }]
    },
    {
      code: `const tops = nodes.map((n) => n.getBoundingClientRect().top)`,
      errors: [{ messageId: 'thrash', data: { prop: 'getBoundingClientRect', name: 'n' } }]
    },
    /* reduce's member is its SECOND parameter; blaming the accumulator would
       report the wrong name and miss the real one. */
    {
      code: `nodes.reduce((sum, n) => sum + n.offsetHeight, 0)`,
      errors: [{ messageId: 'thrash', data: { prop: 'offsetHeight', name: 'n' } }]
    },

    /* Through a property of the member, which is how both real bugs were
       written the second time round. */
    {
      code: `for (const page of pages) use(page.wrap.offsetTop)`,
      errors: [{ messageId: 'thrash', data: { prop: 'offsetTop', name: 'page' } }]
    },

    /* An inline function that runs where it is written stays inside the loop —
       only a DEFERRED callback is a barrier. */
    {
      code: `for (const row of rows) { const at = (() => row.offsetTop)(); use(at) }`,
      errors: [{ messageId: 'thrash', data: { prop: 'offsetTop', name: 'row' } }]
    },

    /* n×m, which is worse than either loop alone. */
    {
      code: `outer.forEach((a) => inner.forEach((b) => { use(a.offsetWidth) }))`,
      errors: [{ messageId: 'thrash', data: { prop: 'offsetWidth', name: 'a' } }]
    }
  ]
})

check('consistent-optional-chaining', consistentOptionalChaining, {
  valid: [
    /* A function that never says the name may be nullish is not this rule's
       business — `saveNow` runs only with an editor up and reads `editor.`
       throughout, correctly. */
    `function saveNow () { return editor.state.doc.toString() }`,
    /* Consistent either way. */
    `function f () { editor?.dispatch(); editor?.focus() }`,
    /* Different names. */
    `function f () { a?.x; b.y }`,
    /* The guarantee differs between functions, which is why the rule is scoped
       to one rather than to a file. */
    `function a () { editor?.focus() }
     function b () { editor.focus() }`
  ],

  invalid: [
    /* THE THREE LAUNCH-TIME CRASHES, in the shape they shipped in: the name was
       made nullable, every site was visited, and the ones written on two lines
       were half-converted. */
    {
      code: `function openText () {
        editor?.dispatch({ selection: sel })
        editor.scrollDOM.scrollTop = place.top || 0
      }`,
      errors: 1
    },
    {
      code: `function recheckOpenNote () {
        editor?.focus()
        return editor.state.doc.toString()
      }`,
      errors: 1
    }
  ]
})

/* The rule's own documented exemptions, pinned so that widening one is a
   deliberate act rather than a side effect. A chain that is TESTED says the
   author already handled the nullish case, and a plain use written BEFORE the
   first optional one is the `if (!x) return` shape the rule cannot see. */
check('consistent-optional-chaining exemptions', consistentOptionalChaining, {
  valid: [
    `function f () { if (editor?.state) return editor.state.doc.toString() }`,
    `function f () { editor.focus(); later(() => editor?.focus()) }`
  ],
  invalid: []
})

console.log(`lint rules: ${ran} cases`)
