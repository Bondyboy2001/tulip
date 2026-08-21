/* ================================================================ tree diff
   What changed between two snapshots of the same sorted vault tree, answered
   as a list of per-level instructions the sidebar can apply to the live DOM.

   The sidebar used to be rebuilt wholesale whenever the tree revision moved:
   a vault of a thousand open rows paid for a thousand fresh rows — two SVG
   clones, a file icon and half a dozen listeners each — to draw one new note.
   A create, rename or delete actually moves a handful of rows in one or two
   folders, and the diff below is that handful. The renderer applies its answer
   (see patchTree in src/renderer.js); this module only decides *what* changed,
   so the decision can be tested and benchmarked on its own.

   Both trees are sorted the same way (folders first, then by name — see
   BY_NAME in electron/main.js), so a level merges like two sorted lists: equal
   keys walk together, a key only in `before` is a removal and a key only in
   `after` is an insertion. A row whose record changed is a replacement. The
   key is (type, name) — unique within a level, since a directory cannot hold
   two entries of the same name. A rename is therefore a remove and an insert,
   which is what it is in the tree. `flag` joins the record because a language
   note that gains one redraws its row — the same fields snapshotRevision in
   electron/main.js hashes.
   ================================================================== */

/** The sort every level is ordered with; see BY_NAME in electron/main.js. */
const treeCompare = new Intl.Collator(undefined, { numeric: true })

/** The main process's level order: folders first, then name. */
export function compareTreeNodes (a, b) {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
  return treeCompare.compare(a.name, b.name)
}

/** Whether two rows sharing a key look different on screen. */
function recordChanged (a, b) {
  return a.kind !== b.kind || a.name !== b.name || a.flag !== b.flag
}

/**
 * What one snapshot became the other, as per-level patch instructions.
 *
 * Each returned level names the folder that owns the changed rows ('' for the
 * vault root) and the *full new* list of its children, plus the paths of the
 * rows among them whose record moved and must be rebuilt. Everything else the
 * renderer needs — what to remove, where to insert — follows from reconciling
 * the rows it has against `children`, in the order it already draws them.
 *
 * The walk is one pass over both trees, so an unchanged vault costs a couple
 * of comparisons per row and nothing else; a change costs the walk plus the
 * levels it actually touched.
 *
 * @param {Array} before  the previously drawn tree
 * @param {Array} after   the new tree
 * @returns {Array<{ parent: string, children: Array, replace: Set<string> }>}
 *   one entry per changed level, shallowest first.
 */
export function diffTrees (before, after) {
  const levels = []

  const walk = (a, b, parent) => {
    const replace = new Set()
    let touched = false
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      const x = a[i]
      const y = b[j]
      /* A list that has run out sorts after everything left in the other, so
         the leftovers are drained by the branch that advances the list they
         are in: `x` alone is a removal (cmp < 0, advance i), `y` alone is an
         insertion (cmp > 0, advance j). Reversed, the walk advances the list
         that is already exhausted and never terminates — which is every first
         draw, where `before` is empty. */
      const cmp = x && y ? compareTreeNodes(x, y) : (x ? -1 : 1)
      if (cmp === 0) {
        if (recordChanged(x, y)) {
          replace.add(y.path)
          touched = true
        }
        /* A folder whose name and record are unchanged may still have moved
           children — that is a change one level down. */
        if (x.type === 'folder') walk(x.children, y.children, y.path)
        i++
        j++
      } else if (cmp < 0) {
        touched = true // x is gone
        i++
      } else {
        touched = true // y is new
        j++
      }
    }
    if (touched) levels.push({ parent, children: b, replace })
  }

  walk(before, after, '')
  return levels
}
