'use strict'

/* ================================================ consistent optional chaining

   Reports a plain `x.y` in a function that elsewhere writes `x?.y`.

   This exists because that exact shape shipped, three times, in the change that
   made the editing stack load on demand:

     editor?.dispatch({ selection: … })
     editor.scrollDOM.scrollTop = place.top || 0     // ← throws when null

   `editor` had become nullable, every site was visited, and the ones written on
   two lines were half-converted. Three of them threw on every single launch for
   a fortnight without anyone noticing, because a renderer exception went to a
   console nobody had open.

   The rule the codebase actually wants is "this value is nullable, so check
   it", and no linter can know that. But *the author already said so*: an
   optional chain on a name is a statement that the name may be nullish, and a
   plain access to the same name in the same function contradicts it. One of the
   two is wrong, and either way it is worth looking at.

   Scoped to a function rather than to a file because the guarantee genuinely
   differs between them: `saveNow` runs only with an editor up and says `editor.`
   throughout, which is correct and is not what this is about.

   A guard makes it safe — `if (!editor) return` — and the rule cannot see one,
   so it does not pretend to: an access that a guard has made safe is reported
   too, and the answer there is to write the access before the guard-less half
   of the function or to drop the now-unnecessary `?.`. In this tree that came
   to a handful of sites, all of which read better afterwards.
*/

/** Every function-ish scope an access could belong to, innermost first. */
const FUNCTIONS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'Program'
])

function enclosingFunction (node) {
  for (let n = node; n; n = n.parent) if (FUNCTIONS.has(n.type)) return n
  return null
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A name that is optional-chained somewhere in a function must not be ' +
        'dereferenced plainly elsewhere in it.'
    },
    schema: [],
    messages: {
      inconsistent:
        "'{{name}}' is written '{{name}}?.' elsewhere in this function, so it " +
        'may be nullish here too.'
    }
  },

  create (context) {
    /* function node -> { optional: Map<name, firstOffset>, tested, plain } */
    const scopes = new Map()

    const record = (fn) => {
      let found = scopes.get(fn)
      if (!found) {
        scopes.set(fn, (found = { optional: new Map(), tested: new Set(), plain: [] }))
      }
      return found
    }

    /**
     * Whether this access sits somewhere an optional chain on the same name
     * would already have skipped.
     *
     * `whiteboard?.open(path, whiteboard.place())` looks like the bug and is
     * not one: an optional chain short-circuits the *whole* chain, arguments
     * included, so a nullish `whiteboard` never reaches `.place()`. The same
     * goes for anything further along the chain — `a?.b.c` does not evaluate
     * `.c` either. Walking up to the enclosing chain and asking whether it is
     * optional on this name is the whole test.
     */
    const shortCircuited = (node, name) => {
      for (let n = node.parent; n; n = n.parent) {
        if (n.type !== 'MemberExpression' && n.type !== 'CallExpression' &&
            n.type !== 'ChainExpression') break
        if (n.type === 'MemberExpression' && n.optional &&
            n.object.type === 'Identifier' && n.object.name === name) return true
        if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
            n.callee.optional && n.callee.object.type === 'Identifier' &&
            n.callee.object.name === name) return true
      }
      return false
    }

    /* Every name mentioned anywhere inside a condition. The common shape by
       far is `const hit = find(…); if (!hit?.path) return; use(hit.path)` — a
       plain access that is plainly safe, because the function has already
       turned back if it was not. Rather than trying to prove which accesses a
       given test dominates, the rule takes any test naming the value as the
       author saying they have thought about it, and holds its peace. It is
       looking for the case where nobody thought about it at all. */
    const noteTested = (test) => {
      if (!test) return
      const fn = enclosingFunction(test)
      if (!fn) return
      const seen = record(fn)
      const walk = (n) => {
        if (!n || typeof n.type !== 'string') return
        if (n.type === 'Identifier') { seen.tested.add(n.name); return }
        for (const key of Object.keys(n)) {
          if (key === 'parent') continue
          const value = n[key]
          if (Array.isArray(value)) value.forEach(walk)
          else if (value && typeof value.type === 'string') walk(value)
        }
      }
      walk(test)
    }

    /* `const row = label?.closest('.row'); if (!row) return` — the guarantee
       is about `row`, but proving `row` proves `label`: the chain could only
       have produced a value by getting past it. So a declarator whose value is
       an optional chain rooted at a name lends that name whatever test its own
       binding is later given. Three of the four shapes left in this tree after
       everything above were exactly this, and they are all correct code. */
    const derived = []   // [{ from: name, to: name, fn }]

    return {
      VariableDeclarator (node) {
        if (node.id.type !== 'Identifier' || !node.init) return
        const chain = node.init.type === 'ChainExpression' ? node.init.expression : node.init
        let root = chain
        while (root && (root.type === 'MemberExpression' || root.type === 'CallExpression')) {
          root = root.type === 'CallExpression' ? root.callee : root.object
        }
        if (root?.type !== 'Identifier') return
        const fn = enclosingFunction(node)
        if (fn) derived.push({ from: root.name, to: node.id.name, fn })
      },

      IfStatement: (node) => noteTested(node.test),
      ConditionalExpression: (node) => noteTested(node.test),
      WhileStatement: (node) => noteTested(node.test),
      DoWhileStatement: (node) => noteTested(node.test),
      /* `x && x.y`, `x || fallback`, `x ?? fallback` — the left side is a test
         of the name whether or not it sits in an `if`. */
      LogicalExpression: (node) => noteTested(node.left),

      MemberExpression (node) {
        /* Only bare identifiers. `a.b.c` says nothing about whether `a.b` was
           meant to be nullable, and chasing that is a different rule. */
        if (node.object.type !== 'Identifier') return
        const fn = enclosingFunction(node)
        if (!fn) return
        const seen = record(fn)
        const name = node.object.name
        if (node.optional) {
          const at = seen.optional.get(name)
          if (at === undefined || node.range[0] < at) seen.optional.set(name, node.range[0])
        } else if (!shortCircuited(node, name)) {
          seen.plain.push({ name, node })
        }
      },

      'Program:exit' () {
        /* Repeated to a fixed point, so a guarantee can travel more than one
           binding — `const a = x?.y; const b = a.z; if (!b) return`. */
        for (let again = true; again;) {
          again = false
          for (const { from, to, fn } of derived) {
            const seen = scopes.get(fn)
            if (seen?.tested.has(to) && !seen.tested.has(from)) {
              seen.tested.add(from)
              again = true
            }
          }
        }

        for (const { optional, tested, plain } of scopes.values()) {
          for (const { name, node } of plain) {
            const firstOptional = optional.get(name)
            if (firstOptional === undefined || tested.has(name)) continue
            /* Only what comes after. `let handle; try { handle = await open();
               handle.sync() } finally { handle?.close() }` is the shape of a
               resource being cleaned up whether or not it was ever acquired —
               the plain uses are inside the try that assigned it, and the
               optional one is the finally that may run before it did. Reading
               order is the difference, and it is the difference that matters:
               the bug this rule is for is a value made nullable and then only
               half-converted, which always leaves the plain access downstream
               of an optional one. */
            if (node.range[0] < firstOptional) continue
            context.report({ node, messageId: 'inconsistent', data: { name } })
          }
        }
      }
    }
  }
}
