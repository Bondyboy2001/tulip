import js from '@eslint/js'
import globals from 'globals'

/* What a linter is here to catch.

   Not style. The house style is already consistent, it is enforced by the
   people writing it, and a formatter arguing with it would produce a large diff
   that says nothing. There is no `semi`, no `quotes`, no `indent` rule below,
   and nothing that would rewrite a line that reads correctly.

   What it is for is the class of mistake that a five-thousand-line file hides:
   a variable that is assigned and never read, a `case` that falls through, a
   promise nobody awaited, a condition that cannot be false. These are silent —
   they do not throw at build time and they do not fail a test, because the
   branch they are in is the branch nobody took. That is exactly the branch a
   note in somebody's vault eventually takes. */

const shared = {
  linterOptions: {
    // A rule disabled for a line that no longer needs it is itself a small
    // lie about the code.
    reportUnusedDisableDirectives: 'error'
  },
  rules: {
    ...js.configs.recommended.rules,

    /* An argument that is not used is often deliberate — an Electron handler
       taking `(_event, payload)` cannot skip the first one. Leading
       underscore is the existing convention for saying so, and it is the only
       exemption: a local or an import that is never read is dead either way. */
    'no-unused-vars': ['error', {
      args: 'after-used',
      argsIgnorePattern: '^_',
      caughtErrors: 'none',
      varsIgnorePattern: '^_'
    }],

    /* `catch {}` with nothing in it appears throughout, and every one of them
       has a comment above saying which failure is being allowed and why. That
       is a deliberate pattern here, not an oversight, so the rule allows an
       empty catch and nothing else — an empty `if` or `for` body stays an
       error. */
    'no-empty': ['error', { allowEmptyCatch: true }],

    /* Two rules are deliberately absent, having been tried and found to fit
       something other than this codebase:

       `require-atomic-updates` raised 43 findings, every one of them a UI flag
       like `mergeOpen` being cleared after an await on a path that cannot
       interleave with itself. `no-template-curly-in-string` raised five, all
       of them slash-command snippets whose whole purpose is to carry a literal
       `${name}` for the editor to fill in.

       Neither found a real defect, and a rule at that ratio does not sharpen
       the list — it buries the findings that mean something. */

    // The ones that are almost always a bug rather than a preference.
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'no-var': 'error',
    'prefer-const': ['error', { destructuring: 'all' }],
    'no-throw-literal': 'error',
    'no-return-await': 'error',
    'no-promise-executor-return': 'error',
    'no-unmodified-loop-condition': 'error',
    'no-unreachable-loop': 'error',
    'no-constant-binary-expression': 'error',
    'no-self-compare': 'error',
    'default-case-last': 'error',
    'no-fallthrough': ['error', { commentPattern: 'falls?\\s?through' }]
  }
}

export default [
  {
    ignores: ['dist/', 'release/', 'build/', 'node_modules/', '.dist-stage-*/', '.dist-previous-*/']
  },

  // The renderer: a browser, with no Node and no bundler globals.
  {
    ...shared,
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.browser
    }
  },

  // The main process and the CommonJS helpers beside it.
  {
    ...shared,
    files: ['electron/**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.commonjs }
    }
  },

  // Build, tests and benchmarks: Node, as modules.
  {
    ...shared,
    files: ['build.mjs', 'scripts/**/*.mjs', 'bench/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node
    }
  },

  /* Two files are neither: they are strings of browser source that a test
     writes to disk and an Electron window then loads. Node's globals are not
     theirs, and the page they become has no module graph. */
  {
    ...shared,
    files: ['scripts/table-tests.js', 'scripts/test-agent-diff.page.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.browser
    }
  }
]
