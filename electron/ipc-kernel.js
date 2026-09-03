'use strict'

/* ---------------------------------------------------------------- notebooks

   The notebook kernels' IPC surface, lifted out of main.js. A notebook's cells
   run in a kernel rather than as programs, because they are meant to share one
   namespace — see electron/kernel.js for why that is borrowed from Jupyter
   rather than built here.

   Everything the handlers need that is not about kernels arrives through the
   context object, so this file holds no window bookkeeping of main's own and
   can be typechecked, reviewed and tested on its own. The kernel host and the
   map of which window owns which notebook, by contrast, live HERE and nowhere
   else: they are one state machine, and splitting state across the boundary
   would leave main.js holding half of it.
   ================================================================== */

const { BrowserWindow, ipcMain } = require('electron')

/**
 * @param {{
 *   sendTo: (win: Electron.BrowserWindow | null, channel: string, payload: unknown) => void,
 *   executionTrusted: () => boolean,
 *   ensureLoginPath: () => Promise<void>,
 *   runnerPath: () => string,
 *   getVaultPath: () => string | null
 * }} ctx
 */
function makeKernelDomain (ctx) {
  const { sendTo, executionTrusted, ensureLoginPath, runnerPath, getVaultPath } = ctx

  /* Indexed, not dotted: tsc resolves kernel.js's `module.exports = {…}` as a
     value alias, so the namespace has no named members to reach — the class
     comes out of indexing the object, then InstanceType of that. */
  /** @type {InstanceType<(typeof import('./kernel'))['KernelHost']> | null} */
  let kernels = null

  function kernelHost () {
    if (kernels) return kernels
    // A notebook opened is the first reason to load the kernel machinery, so
    // the require waits for this function rather than riding this module's —
    // the same laziness main.js kept when this file was part of it.
    const { KernelHost } = require('./kernel')
    kernels = new KernelHost({
      pathFor: runnerPath,
      onEvent: (event) => {
        const win = kernelOwners.get(event.path)
        if (win) sendTo(win, 'kernel:event', event)
      }
    })
    const dir = getVaultPath()
    if (dir) kernels.setRoot(dir)
    return kernels
  }

  /* Which window is showing each notebook, so a kernel's output goes to the pane
     that asked for it. Keyed by notebook path because that is what a kernel
     belongs to — two windows on the same notebook would share one namespace,
     which is what opening the same notebook twice in Jupyter does too. */
  const kernelOwners = new Map()   // notebook path -> BrowserWindow

  function ownKernel (notebookPath, event) {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) kernelOwners.set(notebookPath, win)
    return win
  }

  /** Shut down what a window started, when that window goes. A kernel is a
   * Python process; leaving it running for a pane nobody can see is a leak
   * measured in hundreds of megabytes. */
  function stopOwnedBy (win) {
    for (const [notebookPath, owner] of [...kernelOwners]) {
      if (owner !== win) continue
      kernelOwners.delete(notebookPath)
      kernels?.shutdown(notebookPath).catch(() => {})
    }
  }

  /* The vault is closing or has been replaced: the kernels belonged to the
     vault that is going, and their namespaces (and the processes behind them)
     end with it. */
  function moveRoot (dir) {
    if (!kernels) return
    kernels.dispose().catch(() => {})
    kernels.setRoot(dir)
  }

  /* For quitting, where there is no later: the async disposal's escalation
     timer would never fire, so the Jupyter servers go outright. */
  function disposeSync () {
    kernels?.disposeSync()
  }

  function register () {
    ipcMain.handle('kernel:start', async (event, notebookPath, wanted) => {
      if (typeof notebookPath !== 'string' || !notebookPath) throw new Error('No notebook.')
      if (!executionTrusted()) {
        const error = /** @type {Error & { code: string }} */ (new Error('This vault is not trusted for code execution.'))
        error.code = 'TULIP_UNTRUSTED_VAULT'
        throw error
      }
      ownKernel(notebookPath, event)
      // The Jupyter server is spawned with `pathFor`, which is `runnerPath`.
      await ensureLoginPath()
      const kernel = await kernelHost().kernelFor(notebookPath, wanted)
      return { kernel: kernel.displayName, name: kernel.name, state: kernel.state }
    })

    ipcMain.handle('kernel:execute', async (event, notebookPath, code) => {
      if (!executionTrusted()) {
        const error = /** @type {Error & { code: string }} */ (new Error('This vault is not trusted for code execution.'))
        error.code = 'TULIP_UNTRUSTED_VAULT'
        throw error
      }
      const kernel = kernels?.get(notebookPath)
      if (!kernel) throw new Error('This notebook has no kernel running.')
      const win = ownKernel(notebookPath, event)

      /* The id goes back at once and the verdict follows as an event. The viewer
         cannot attribute a line of output to a cell until it knows which request
         produced it, and output starts arriving the moment the kernel begins. */
      const { msgId, done } = kernel.execute(code)
      /* A wedged cell used to hang forever with only manual Interrupt to stop
         it. Time out long executions: interrupt the kernel so a runaway loop
         dies, and report the timeout as the cell's verdict. */
      const KERNEL_EXEC_TIMEOUT_MS = 10 * 60 * 1000
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        kernel.interrupt().catch(() => {})
      }, KERNEL_EXEC_TIMEOUT_MS)
      timer.unref?.()
      const finish = (payload) =>
        sendTo(win, 'kernel:event', { path: notebookPath, kind: 'done', msgId, ...payload })
      done.then(
        (result) => {
          clearTimeout(timer)
          if (timedOut) finish({ status: 'aborted', error: 'The cell timed out after 10 minutes and was interrupted.' })
          else finish({ status: result.status, executionCount: result.executionCount })
        },
        // A rejected `done` is the kernel dying, restarting or being shut down
        // under a running cell — all of which the cell has to be told about, or it
        // says "Running…" for the rest of the session.
        (err) => {
          clearTimeout(timer)
          finish({ status: 'aborted', error: err?.message || 'The run stopped.' })
        }
      )
      return { msgId }
    })

    ipcMain.handle('kernel:interrupt', async (_e, notebookPath) => {
      const kernel = kernels?.get(notebookPath)
      return kernel ? kernel.interrupt() : false
    })

    /* The answer to an `input()` the kernel is blocked on. Nothing is returned but
       whether there was a question to answer: what the kernel does with it comes
       back as ordinary output, the way it does when you type into a terminal. */
    ipcMain.handle('kernel:input', async (_e, notebookPath, value) => {
      const kernel = kernels?.get(notebookPath)
      return kernel ? kernel.respondInput(value) : false
    })

    /* Completion and inspection answer straight back rather than as events: unlike
       a cell, nothing is drawn until the whole reply is in hand. A kernel that is
       not running is not an error worth raising here — the caller is a Tab key. */
    ipcMain.handle('kernel:complete', async (_e, notebookPath, code, cursorPos) => {
      const kernel = kernels?.get(notebookPath)
      if (!kernel) return null
      return kernel.complete(code, cursorPos).catch(() => null)
    })

    ipcMain.handle('kernel:inspect', async (_e, notebookPath, code, cursorPos) => {
      const kernel = kernels?.get(notebookPath)
      if (!kernel) return null
      return kernel.inspect(code, cursorPos).catch(() => null)
    })

    ipcMain.handle('kernel:restart', async (_e, notebookPath) => {
      const kernel = kernels?.get(notebookPath)
      return kernel ? kernel.restart() : false
    })

    ipcMain.handle('kernel:shutdown', async (_e, notebookPath) => {
      kernelOwners.delete(notebookPath)
      return kernels ? kernels.shutdown(notebookPath) : false
    })

    /* The notebook was renamed or moved. Its kernel is filed under the path it had
       — as is the window that owns it — so both are re-keyed here rather than left
       naming a file that is gone. Answered even when nothing was running: the
       renderer calls this for every rename of an `.ipynb`, and "there was no
       kernel" is the ordinary case. */
    ipcMain.handle('kernel:rename', async (_e, from, to) => {
      const owner = kernelOwners.get(from)
      if (owner) {
        kernelOwners.delete(from)
        kernelOwners.set(to, owner)
      }
      return kernels ? kernels.rename(from, to) : false
    })

    ipcMain.handle('kernel:specs', async () => {
      await ensureLoginPath()
      return kernelHost().kernelSpecs()
    })
  }

  return { register, stopOwnedBy, moveRoot, disposeSync }
}

module.exports = { makeKernelDomain }
