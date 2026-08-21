/* ========================================================== static analysis

   Sixty thousand lines of untyped JavaScript across a hundred modules had, up
   to now, nothing reading it but the bundler — and esbuild only asks whether a
   file parses, never whether it makes sense. What that cost is a matter of
   record rather than of principle:

     · `mountHistory({ confirm: ask })` captured `ask` three thousand lines
       before the `const ask` that defines it. Bundling turns a top-level
       `const` into a `var`, so instead of the temporal-dead-zone throw that
       would have made it obvious, it silently captured `undefined` and every
       Restore button in the app rejected the moment it was pressed.
       — `no-use-before-define`.

     · `editor?.dispatch(...)` on one line and `editor.scrollDOM` on the next,
       in six places, after the editing stack was made to load on demand. Three
       of them threw on every launch for a fortnight.
       — not a lint rule, but exactly what `tsc --checkJs` sees; see
         tsconfig.json, which is the other half of this.

   The rule set is deliberately small. Everything here is a defect, not a
   preference: this project has a house style and it is written in prose at the
   top of each module, not enforced by a formatter.

   Three shapes of file, three sets of globals:

     src/         ES modules, bundled into the renderer — browser globals
     electron/    CommonJS, the main process and its preload — node globals
     scripts/     both spellings, run under node

   `.cjs` is CommonJS wherever it appears, and `.mjs` is always an ES module;
   the bare `.js` files split on which directory they are in, because
   package.json says `"type": "commonjs"` and only the bundler knows better. */

import { createRequire } from 'node:module'
import js from '@eslint/js'
import globals from 'globals'

/* A local rule, in CommonJS like everything else outside src/. See the file
   itself for what it is for and what it cost not to have. */
const require = createRequire(import.meta.url)
const tulip = {
  rules: {
    'consistent-optional-chaining': require('./eslint-rules/consistent-optional-chaining.js'),
    'no-layout-thrash': require('./eslint-rules/no-layout-thrash.js')
  }
}

/* Deliberately not `js.configs.recommended` wholesale: that set includes
   stylistic and situational rules whose failures here are noise, and a lint
   run that reports things nobody intends to fix is one nobody reads. These are
   the ones that only ever fire on a mistake. */
const REAL_MISTAKES = {
  ...js.configs.recommended.rules,

  /* The two that earned their place, tuned rather than taken as they come. */

  /* Function declarations hoist, and this codebase leans on that everywhere —
     a module reads top-down as prose, with the helpers underneath the thing
     they help. Values do not hoist, which is the case that bit.

     A warning and not an error, and the distinction is the whole point. The
     rule cannot see *when* a reference runs: a `const` named inside a function
     body that is only called later is perfectly safe, and this codebase is
     full of those. What it caught was a reference evaluated during module
     initialisation, where "later" never comes. So the rule reports every one
     and a person reads the list — which is worth doing, and is not worth
     failing a build over. */
  'no-use-before-define': ['warn', {
    functions: false,
    classes: false,
    variables: true,
    allowNamedExports: true
  }],

  /* Deliberate, everywhere they appear: terminal output is stripped of its
     escape sequences before it is shown, and a NUL is exactly what the HTML
     sanitiser is looking for. A control character in a regular expression here
     is the subject matter. */
  'no-control-regex': 'off',

  /* About the shape of a rethrow rather than about a mistake. */
  'preserve-caught-error': 'off',

  /* `let size = 0` followed by `try { size = statSync(...).size } catch
     { return }` is how this codebase declares a value it is about to try for.
     The initialiser is never read, which is the rule's complaint and exactly
     the point of writing it: the declaration says what the variable is for
     without depending on the try succeeding. Every report of this rule in the
     tree was that idiom, and none of them was a mistake. */
  'no-useless-assignment': 'off',

  /* An unused argument is often documentation — `(_event, path)` says what the
     channel sends even where only the second half is wanted — so only the ones
     after the last used argument are reported, and a leading underscore opts
     out entirely. */
  'no-unused-vars': ['error', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrors: 'none',
    ignoreRestSiblings: true
  }],

  /* The one rule written for this codebase rather than taken from the shelf:
     a name optional-chained anywhere in a function must not be dereferenced
     plainly elsewhere in it. Three launch-time crashes came from exactly that
     inconsistency; see eslint-rules/consistent-optional-chaining.js. */
  'tulip/consistent-optional-chaining': 'error',

  /* The second rule written for this codebase, after the second hang in a
     week: a layout-forcing property read or written on the member of a
     collection being iterated is one forced layout per member, and with
     `content-visibility: auto` on every reading-view block that is a wedged
     window rather than a slow one. See eslint-rules/no-layout-thrash.js for
     both instances and for what it deliberately does not report. */
  'tulip/no-layout-thrash': 'error',

  /* Empty blocks are a house idiom here: `catch { /* already gone *\/ }` is how
     this codebase says a failure is expected and has nothing to do. The comment
     is the point, and the rule below still catches an empty block with none. */
  'no-empty': ['error', { allowEmptyCatch: true }]
}

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      /* A build that dies partway leaves its staging directory behind — .gitignore
         already knows about them, and without this a crashed build turns the next
         lint run into two thousand findings against bundled third-party code. */
      '.dist-stage-*/**',
      '.dist-previous-*/**',
      'build/**',
      'output/**',
      'bench/**'
    ]
  },

  /* The renderer: ES modules in a browser, with the preload's bridge hanging
     off `window.tulip` — which is a property, not a global, so it needs no
     declaration here. */
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        /* Chromium has had these for years; the shared `browser` list is
           conservative about what it promises. */
        requestIdleCallback: 'readonly',
        cancelIdleCallback: 'readonly'
      }
    },
    plugins: { tulip },
    rules: REAL_MISTAKES
  },

  /* Main and the preload: CommonJS under node, with Electron's own modules
     arriving through `require`. */
  {
    files: ['electron/**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    plugins: { tulip },
    rules: REAL_MISTAKES
  },

  /* The test and build scripts, which are node either way. */
  {
    files: ['**/*.mjs'],
    ignores: ['**/*.page.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node }
    },
    plugins: { tulip },
    rules: REAL_MISTAKES
  },

  /* Bundled by esbuild the way src is, and run inside the offscreen windows
     the Electron-backed suites drive — `*.page.mjs` is the naming convention
     for the half of a test that executes in the page rather than in node. */
  {
    files: ['scripts/**/*.js', '**/*.page.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node }
    },
    plugins: { tulip },
    rules: REAL_MISTAKES
  },

  /* A harness measures its fixture on purpose. `scripts/table-tests.js` walks
     every header of a ten-column table to assert where it landed, which is the
     assertion rather than a hang; the fixtures are small and are built by the
     test itself. Same reasoning tsconfig.json gives for leaving scripts/ out of
     the typecheck: these files exist to be thrown away and rewritten. */
  {
    files: ['scripts/**'],
    rules: { 'tulip/no-layout-thrash': 'off' }
  }
]
