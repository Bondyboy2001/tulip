import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { appSession, delay, pdfFixture } from '../scripts/lib/app-session.mjs'
const cycles = Number(process.env.TULIP_SESSION_CYCLES || 20)
const files = {
  'Home.md': '# Home\n\nSession benchmark.\n',
  'Long.md': '# Long note\n\n' + 'A research paragraph with **formatting** and a [[Home]] link.\n\n'.repeat(1500),
  'Paper.pdf': pdfFixture(100),
  'Data.csv': 'name,value,category\n' + Array.from({ length: 20000 }, (_, i) => `Row ${i},${i},Group ${i % 10}`).join('\n'),
  'Analysis.ipynb': JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, cell_type: 'code', metadata: {}, execution_count: i, source: [`print(${i})`], outputs: [{ output_type: 'stream', name: 'stdout', text: [`${i}\n`] }] })) }),
  'Board.excalidraw': JSON.stringify({ type: 'excalidraw', version: 2, source: 'tulip', elements: [], appState: {}, files: {} })
}
/* A sizeable tree, fully expanded, so the sidebar work — fold-all, snapshot
   patching — is measured against the shape that used to make it slow. Thirty
   folders of ten notes is small next to a real archive and large enough that
   a whole-tree rebuild is a stall, not a blink. */
const folders = Array.from({ length: 30 }, (_, i) => `Areas/Folder ${String(i).padStart(2, '0')}`)
for (const dir of folders) {
  for (let n = 0; n < 10; n++) files[`${dir}/Note ${String(n).padStart(2, '0')}.md`] = `# Note ${n}\n\nIn ${dir}.\n`
}
/* `expanded` needs `Areas` as well as its children — a folder whose parent is
   shut never draws, and the tree would start this bench nearly empty. */
const app = await appSession({ executable: process.argv.find((arg) => arg.startsWith('--app='))?.slice(6), files, config: { tabs: ['Home.md'], tabIndex: 0, view: 'read', expanded: ['Areas', ...folders] } })
const samples = []
try {
  async function sample (cycle) {
    await app.command('HeapProfiler.collectGarbage')
    const heap = await app.command('Runtime.getHeapUsage')
    return { cycle, heapMB: heap.usedSize / 1048576, ...(await app.evaluate('({ nodes: document.querySelectorAll("*").length, tabs: window.__tulip.state.tabs.length })')) }
  }
  for (let cycle = 0; cycle <= cycles; cycle++) {
    for (const name of ['Long.md', 'Paper.pdf', 'Data.csv', 'Analysis.ipynb', 'Board.excalidraw', 'Home.md']) {
      const ms = await app.evaluate(`(async () => { const start = performance.now(); await window.__tulip.openNote(${JSON.stringify(name)}); const selector = ${JSON.stringify({'Paper.pdf': '#pdf .pdf-page.is-drawn canvas', 'Data.csv': '#data .csv-frame', 'Analysis.ipynb': '#notebook .nb-cell', 'Board.excalidraw': '#whiteboard .excalidraw', 'Long.md': '#reading', 'Home.md': '#reading'}[name])}; const deadline = performance.now() + 15000; while (!document.querySelector(selector)) { if (performance.now() > deadline) throw new Error('Viewer not ready: ' + selector); await new Promise((r) => setTimeout(r, 25)); } await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - start })()`)
      if (cycle > 0) samples.push({ cycle, file: name, ms })
    }
    await app.evaluate('(async () => { window.__tulip.runCommand("copilot"); await new Promise((r) => setTimeout(r, 100)); document.querySelector("#ai-close")?.click(); return true })()')
    await delay(100)
    if (cycle === 0 || cycle % 5 === 0 || cycle === cycles) console.log(JSON.stringify(await sample(cycle)))
    if (cycle === 0) globalThis.baseline = await sample(cycle)
  }
  // Explicit page navigation and editor input, beyond opening and closing panes.
  await app.evaluate('window.__tulip.openNote("Paper.pdf")')
  const pageTimings = await app.evaluate(`(async () => {
    const readyBy = performance.now() + 5000;
    while (!document.querySelector('#pdf .pdf-page.is-drawn')) {
      if (performance.now() > readyBy) throw new Error('PDF did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const times = [];
    for (const page of [20, 80, 5, 50, 100]) {
      const start = performance.now(); window.__tulip.pdf.goToPage(page);
      const navigation = {current:window.__tulip.pdf.page(), top:document.querySelector('#pdf').scrollTop, height:document.querySelector('#pdf').clientHeight, pages:document.querySelectorAll('#pdf .pdf-page').length};
      if (navigation.height > innerHeight) throw new Error('PDF viewport escaped the window during panel animation');
      const deadline = performance.now() + 5000;
      while (!document.querySelector('#pdf .pdf-page[data-page="' + page + '"].is-drawn')) {
        if (performance.now() > deadline) throw new Error('Requested PDF page did not render: ' + page + ' (current ' + window.__tulip.pdf.page() + ', drawn ' + [...document.querySelectorAll('#pdf .pdf-page.is-drawn')].map(p=>p.dataset.page).join(',') + ', initial ' + JSON.stringify(navigation) + ')');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      times.push(performance.now() - start);
    }
    return times;
  })()`)
  await app.evaluate('window.__tulip.openNote("Long.md")')
  await app.evaluate('window.__tulip.runCommand("view-edit"); true')
  // Use the editor directly after the app has mounted it; dispatch still uses
  // the real document update, decorations, save scheduling and render paths.
  const inputTimings = await app.evaluate(`(async () => {
    window.__tulip.runCommand('view-edit');
    const editor = window.__tulip.editor;
    if (!editor) throw new Error('Editor not mounted for input benchmark');
    const times = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      editor.dispatch({ changes: { from: 0, insert: 'x' } });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      times.push(performance.now() - start);
    }
    return times;
  })()`)
  await app.evaluate('window.__tulip.openNote("Home.md")')
  /* The sidebar on a fully-expanded 330-row tree: fold-all collapses and
     re-expands, then a file landing is patched in. Both measured around the
     click — the work is synchronous, so the number is the stall itself. */
  const treeTimings = await app.evaluate(`(async () => {
    const fold = document.querySelector('#btn-fold-all')
    if (!fold || fold.hidden) return { collapseMs: -1, expandMs: -1, patchMs: -1 }
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const rows = () => document.querySelectorAll('#tree .row').length
    const t0 = performance.now(); fold.click(); await raf()
    const collapseMs = performance.now() - t0
    const collapsed = rows()
    const t1 = performance.now(); fold.click(); await raf()
    const expandMs = performance.now() - t1
    const expanded = rows()
    return { collapseMs, expandMs, collapsed, expanded }
  })()`)
  const percentile = (values) => [...values].sort((a,b) => a-b)[Math.min(values.length - 1, Math.floor(values.length * .95))]
  const responsiveness = { pdfNavigationP95Ms: percentile(pageTimings), typingP95Ms: percentile(inputTimings), treeCollapseMs: treeTimings.collapseMs, treeExpandMs: treeTimings.expandMs, treeRows: treeTimings.expanded }
  const final = await sample(cycles)
  await app.command('Performance.enable')
  const cpuBefore = (await app.command('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value
  const idle = await app.evaluate(`(async () => {
    let ticks = 0; let longest = 0; let last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last - 50); last = now; ticks++ }, 50);
    await new Promise((r) => setTimeout(r, 5000)); clearInterval(timer); return { ticks, longestDelayMs: longest }
  })()`)
  const cpuAfter = (await app.command('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value
  idle.rendererBusyPercent = (cpuAfter - cpuBefore) / 5 * 100
  const result = { cycles, responsiveness, baseline: globalThis.baseline, final, retainedGrowthMB: final.heapMB - globalThis.baseline.heapMB, idle, timings: Object.fromEntries([...new Set(samples.map((s) => s.file))].map((file) => {
    const times = samples.filter((s) => s.file === file).map((s) => s.ms).sort((a, b) => a - b)
    return [file, { medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.min(times.length - 1, Math.floor(times.length * .95))] }]
  })) }
  console.log(JSON.stringify(result, null, 2))
  if (process.env.TULIP_SESSION_REPORT) await writeFile(process.env.TULIP_SESSION_REPORT, JSON.stringify(result, null, 2))
  if (process.argv.includes('--check')) {
    assert.ok(responsiveness.pdfNavigationP95Ms < 250, 'PDF page navigation yields a frame within 250ms')
    assert.ok(responsiveness.typingP95Ms < 50, 'long-note typing frame delay stays below 50ms')
    if (treeTimings.expanded > 0) {
      assert.ok(treeTimings.collapseMs < 150, 'collapsing the whole tree is a patch, not a rebuild')
      assert.ok(treeTimings.expandMs < 500, 'expanding the whole tree stays under half a second')
    }
    for (const timing of Object.values(result.timings)) assert.ok(timing.p95Ms < 500, 'document switching p95 stays below 500ms')
    assert.ok(result.retainedGrowthMB < 20, 'retained heap grows by less than 20 MB after warm-up')
    assert.ok(final.nodes < globalThis.baseline.nodes + 1000, 'closed viewers do not accumulate DOM')
    assert.ok(idle.rendererBusyPercent < 5, 'idle renderer stays below 5% busy time')
    assert.ok(idle.longestDelayMs < 100, 'idle window remains responsive')
  }
} finally { await app.dispose() }
