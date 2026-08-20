// @ts-check
/* The two rules the model picker's provider groups follow.

   Their own module rather than part of settings.js so they can be asked
   questions without a document: settings.js builds DOM as it loads, and a test
   that imports it needs a browser to do it in. These need nothing. */

/**
 * Whether a provider's group of models is drawn open.
 *
 * A freshly opened Settings pane has every provider folded. Typing a search
 * opens them, because a result nobody can see is not a result. Clicking one
 * fixes it either way for the life of the pane, and that decision outranks the
 * search — so a group the reader deliberately folded stays folded while they
 * keep typing.
 *
 * Notably *not* part of it: how many models in the group are ticked. Opening a
 * group because something in it is selected sounds helpful and is not — it
 * un-folds half the list on the first paint, which is the state this whole rule
 * exists to avoid.
 *
 * @param {Map<string, boolean>} opened groups the reader has clicked, and how
 * @param {string} name the provider's name
 * @param {string} query what is typed in the filter box, if anything
 */
export function groupOpen (opened, name, query) {
  return opened.has(name) ? opened.get(name) : !!query
}

/**
 * The counter beside a provider's name.
 *
 * Out of the models *shown*, not out of everything the provider offers: with a
 * search running, "3/4" describes the four on screen. Counting against the full
 * catalogue instead made a filtered group read as "3 of 412 offered", which
 * says nothing about the four rows underneath it.
 *
 * @param {number} ticked how many of the shown models are selected
 * @param {number} shown how many are on screen
 */
export function groupCount (ticked, shown) {
  return `${ticked}/${shown}`
}
