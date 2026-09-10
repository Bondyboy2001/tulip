'use strict'

/* ===================================== no module-init use before define

   Reports a later-declared value only when reading it is part of evaluating
   the module itself.

   ESLint's general `no-use-before-define` cannot distinguish these two shapes:

     mountHistory({ confirm: ask })       // reads `ask` now: a real bug
     button.onclick = () => ask()         // reads `ask` after boot: deliberate

   Tulip is organised around the second shape: public operations are near the
   top of a module and the state/helpers they close over are declared below.
   The stock rule consequently produced hundreds of warnings nobody could act
   on, while the first shape is important enough to remain an error.

   Scope references do the name resolution, so property names, labels and
   shadowed locals are never guessed from spelling. A normal function is an
   evaluation barrier. A synchronous IIFE is not: its body runs exactly where
   its call appears and therefore still belongs to module initialisation.
*/

const FUNCTIONS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression'
])

/** Whether this reference is evaluated while the Program is evaluating. */
function duringModuleInit (node) {
  for (let current = node; current?.parent; current = current.parent) {
    if (!FUNCTIONS.has(current.type)) continue

    /* An IIFE is not deferred. Parentheses do not create an AST node, so the
       function is the call's callee directly. An async IIFE also starts now
       (up to its first suspension), so conservatively keep its whole body in
       scope. A generator call does not execute its body and remains deferred. */
    const call = current.parent
    if (current.type !== 'FunctionDeclaration' && !current.generator &&
        call.type === 'CallExpression' && call.callee === current) {
      current = call
      continue
    }
    return false
  }
  return true
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow reading a later-declared value during module initialisation.'
    },
    schema: [],
    messages: {
      before:
        "'{{name}}' is read while this module is initialising, before its declaration has run."
    }
  },

  create (context) {
    const source = context.sourceCode

    return {
      'Program:exit' () {
        /* Module, script and CommonJS scopes use different names, but each
           scope that owns top-level bindings has Program as its block. */
        const topScopes = source.scopeManager.scopes.filter((scope) =>
          scope.block?.type === 'Program')
        const seen = new Set()

        for (const scope of topScopes) for (const variable of scope.variables) {
          if (seen.has(variable)) continue
          seen.add(variable)
          const definition = variable.defs.find((def) => def.type === 'Variable')
          if (!definition?.node?.range) continue

          /* The binding is not initialised until its declarator finishes. This
             catches both an earlier statement and `const value = value` while
             allowing recursion captured by a deferred function initializer. */
          const readyAt = definition.node.range[1]
          for (const reference of variable.references) {
            if (!reference.isRead()) continue
            const identifier = reference.identifier
            if (identifier.range[0] >= readyAt || !duringModuleInit(identifier)) continue
            context.report({
              node: identifier,
              messageId: 'before',
              data: { name: identifier.name }
            })
          }
        }
      }
    }
  }
}
