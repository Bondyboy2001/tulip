'use strict'

/* ====================================================== no layout thrash

   Reports a layout-forcing property on the thing a loop is iterating.

   This exists because that exact shape wedged the window twice in one week,
   and both times it took a `Debugger.pause` session to find, because a forced
   layout is not an exception and not a slow function — it is a main thread
   that never comes back.

     // placedLines(), which could hang the renderer for ever on a big note
     [...el.reading.querySelectorAll('[data-line]')]
       .filter((n) => n.offsetParent !== null)

     // applyConfig(), the same bug three days later
     for (const pre of el.reading.querySelectorAll('pre.code-text')) pre.scrollLeft = 0

   Reading `offsetParent` — or writing `scrollLeft`, or measuring anything —
   cannot be answered without laying the page out. Once per element is one
   layout; once per element in a collection is n layouts. On a 1.7MB note that
   is 56,000 of them, and because `.reading-body > *` carries
   `content-visibility: auto`, each one is real work rather than a no-op on a
   box the engine had already measured. The first of these never finished; the
   second re-wedged the window on a button press after the first was fixed.

   WHAT IT DOES NOT REPORT, on purpose:

   - A `while` loop. `viewportLine` and `readingNodeAt` bisect a NodeList and
     call `getBoundingClientRect` on ~13 probes, which is the FIX for this bug
     rather than an instance of it. O(log n) measurements are how you ask about
     a big collection safely, and a rule that flagged them would be arguing
     against the repair.

   - A measurement of anything but the iteration variable itself. `for (const x
     of xs) frame.scrollTop = 0` writes one element n times, which is one
     layout and n cheap writes.

   So: for-of, for-in, a counted `for` over `.length`, and the array-iteration
   callbacks — the constructs that visit every member — and only the member.

   If a report is genuinely wanted, the answer is nearly always to read what
   you need in one pass before the loop (or bisect instead), not to silence it.
*/

/** Reading any of these, or writing to one, requires a laid-out page. */
const FORCES_LAYOUT = new Set([
  'offsetParent', 'offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight',
  'clientTop', 'clientLeft', 'clientWidth', 'clientHeight',
  'scrollTop', 'scrollLeft', 'scrollWidth', 'scrollHeight',
  'getBoundingClientRect', 'getClientRects', 'scrollIntoView', 'scrollIntoViewIfNeeded',
  'innerText', 'computedStyleMap',
  /* focus() scrolls the element into view, so it measures too. */
  'focus'
])

/* Methods that take a callback to run LATER. A function handed to one of
   these escapes the loop that registered it: `for (const p of PANELS)
   p.grip.addEventListener('pointerdown', () => p.host.getBoundingClientRect())`
   measures one panel once per drag, not every panel once per loop. Registering
   n handlers is n handlers, not n layouts. */
const DEFERS = new Set([
  'addEventListener', 'removeEventListener', 'on', 'once', 'off',
  'setTimeout', 'setInterval', 'setImmediate',
  'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask',
  'then', 'catch', 'finally',
  'observe', 'subscribe'
])

/** Array methods that call their callback once per member. */
const PER_MEMBER = new Set([
  'forEach', 'map', 'filter', 'find', 'findLast', 'findIndex', 'findLastIndex',
  'some', 'every', 'flatMap', 'reduce', 'reduceRight', 'sort', 'group'
])

/* Walking up from a layout-forcing access to the thing being measured. Two
   answers are interesting and they are different questions:

     rows[i].offsetTop   the member arrives by SUBSCRIPT, so what matters is
                         whether `i` is a counted loop's index
     row.offsetTop       the member arrives by NAME, so what matters is whether
                         `row` is bound per iteration

   `subscript` reports the first computed access on the way up, and `named` the
   plain identifier the chain starts from; a caller asks for both. */
function rootsOf (node) {
  let subscript = null
  let n = node
  while (n) {
    if (n.type === 'ChainExpression') { n = n.expression; continue }
    if (n.type !== 'MemberExpression') break
    if (n.computed && !subscript && n.property.type === 'Identifier') subscript = n.property
    n = n.object
  }
  return { named: n && n.type === 'Identifier' ? n : null, subscript }
}

/** Every name a binding pattern introduces — `const [a, {b}] = …` gives a, b. */
function namesIn (pattern, out = []) {
  if (!pattern) return out
  switch (pattern.type) {
    case 'Identifier': out.push(pattern.name); break
    case 'ObjectPattern': for (const p of pattern.properties) namesIn(p.value || p.argument, out); break
    case 'ArrayPattern': for (const e of pattern.elements) namesIn(e, out); break
    case 'AssignmentPattern': namesIn(pattern.left, out); break
    case 'RestElement': namesIn(pattern.argument, out); break
  }
  return out
}

/** The names a for-of/for-in header binds, or null if it is not one. */
function membersOfForHeader (node) {
  if (node.type !== 'ForOfStatement' && node.type !== 'ForInStatement') return null
  const left = node.left
  if (left.type === 'VariableDeclaration') return namesIn(left.declarations[0] && left.declarations[0].id)
  return namesIn(left)
}

/* The index names of `for (let i = 0; i < xs.length; i++)` — a loop that
   visits every member, reaching each one by subscript. A bare `while` is
   deliberately not this: bisection is the repair for the bug, not an instance
   of it, and it is written as a while. */
function countedIndices (node) {
  if (node.type !== 'ForStatement' || !node.test || !node.init) return null
  const t = node.test
  if (t.type !== 'BinaryExpression' || !['<', '<=', '>', '>='].includes(t.operator)) return null
  const overLength = [t.left, t.right].some((side) =>
    side.type === 'MemberExpression' && !side.computed &&
    side.property.type === 'Identifier' && side.property.name === 'length')
  if (!overLength) return null
  if (node.init.type !== 'VariableDeclaration') return null
  return node.init.declarations.flatMap((d) => namesIn(d.id))
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A layout-forcing property must not be read or written on the member ' +
        'of a collection being iterated: that is one forced layout per member.'
    },
    schema: [],
    messages: {
      thrash:
        "'{{prop}}' forces a layout, and '{{name}}' is a member of a collection " +
        'this loop visits in full — so this is one layout per member, which on a ' +
        'large note is a hang rather than a slowdown. Gather what you need in a ' +
        'single pass before the loop, or bisect instead of walking.'
    }
  },

  create (context) {
    /* Two stacks, one per way a member is reached. Stacks rather than a single
       set because loops nest, and a callback written inside a loop is still
       inside it. */
    const members = []   // names bound to one member per iteration
    const indices = []   // names counting through a collection's length

    const frame = (names, barrier) => ({ names: new Set(names), barrier: !!barrier })

    function enter (names, idx, barrier) {
      members.push(frame(names, barrier))
      indices.push(frame(idx, barrier))
    }
    const leave = () => { members.pop(); indices.pop() }

    /* Innermost first, stopping at a barrier: a deferred callback does not run
       once per member of the loop that registered it, so nothing outside it
       counts. */
    function held (stack, name) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].names.has(name)) return true
        if (stack[i].barrier) return false
      }
      return false
    }

    /* What a nested function inherits from the loop around it, if anything:
         - the members of `xs.filter((n) => …)`, which is itself the loop
         - nothing at all, if it was handed to something that defers it
         - whatever its enclosing scope had, for a plain inline function that
           runs where it is written
       The last is why this returns a marker rather than a list: an arrow inside
       a `for…of` body is still inside the loop. */
    const INHERIT = Symbol('inherit')

    function callbackMembers (node) {
      const parent = node.parent
      if (!parent || parent.type !== 'CallExpression') return INHERIT
      if (!parent.arguments.includes(node)) return INHERIT
      const callee = parent.callee
      const name = callee.type === 'MemberExpression' && !callee.computed &&
        callee.property.type === 'Identifier' ? callee.property.name
        : callee.type === 'Identifier' ? callee.name : null
      if (!name) return INHERIT
      if (DEFERS.has(name)) return null
      if (!PER_MEMBER.has(name)) return INHERIT
      /* reduce's first parameter is the accumulator, its second the member. */
      const which = name.startsWith('reduce') ? 1 : 0
      return namesIn(node.params[which])
    }

    function checkAccess (node) {
      if (node.computed || node.property.type !== 'Identifier') return
      if (!FORCES_LAYOUT.has(node.property.name)) return
      const { named, subscript } = rootsOf(node.object)
      /* `rows[i].offsetTop` is measured per member when `i` counts; `row.
         offsetTop` is when `row` is bound per member. A subscript answers for
         the whole chain, so it is asked first. */
      const blame = (subscript && held(indices, subscript.name) && subscript) ||
                    (named && held(members, named.name) && named)
      if (!blame) return
      context.report({
        node,
        messageId: 'thrash',
        data: { prop: node.property.name, name: blame.name }
      })
    }

    function enterLoop (node) {
      enter(membersOfForHeader(node) || [], countedIndices(node) || [], false)
    }

    return {
      ForOfStatement: enterLoop,
      'ForOfStatement:exit': leave,
      ForInStatement: enterLoop,
      'ForInStatement:exit': leave,
      ForStatement: enterLoop,
      'ForStatement:exit': leave,

      'ArrowFunctionExpression, FunctionExpression' (node) {
        const bound = callbackMembers(node)
        /* A per-member callback adds its member and keeps what surrounds it —
           it runs where it is written, and `xs.forEach(x => ys.map(y => …))` is
           n×m visits, not a fresh start. Only a deferred one is a barrier. */
        if (bound === null) enter([], [], true)
        else enter(bound === INHERIT ? [] : bound, [], false)
      },
      'ArrowFunctionExpression, FunctionExpression:exit': leave,

      MemberExpression: checkAccess
    }
  }
}
