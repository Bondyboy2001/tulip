'use strict'

/* ============================================================== killing well

   Everything Tulip spawns spawns something else. `npx opencode` is a Node
   wrapper around the CLI that does the work; `jupyter server` is a launcher
   that forks a kernel per notebook; a run block's `python` may have started a
   subprocess of its own. Killing the process we hold a handle to is therefore
   the one thing that reliably does *not* finish the job — it reaps the
   wrapper and orphans the work, which then keeps a port bound, a GPU claimed
   or a few hundred megabytes resident until the machine is restarted.

   On Unix the answer is a process group: spawn with `detached: true`, which
   makes the child a group leader, and signal the negative pid to reach every
   descendant at once. That is what the call sites already did.

   Windows has no process groups and no signals, and `process.kill(-pid)`
   simply throws there — after which the call sites fell back to `child.kill()`
   and reaped the wrapper alone. The equivalent is `taskkill /T`, which walks
   the process tree the job was started with, and `/F`, which does not ask
   politely. It is a separate program rather than a system call, so it is
   spawned; there is nothing to wait for and nothing useful to do if it fails,
   because by then the alternative was already going to be leaking.

   Exported as one function so there is one place to be wrong. */

const { spawn } = require('child_process')

/**
 * Kill a child and everything it started.
 *
 * `signal` is the Unix signal to send; Windows has no equivalent, so a
 * termination there is always forceful and the argument is ignored. Never
 * throws: a process that is already gone is the outcome being asked for.
 *
 * Returns true if a kill was issued at all, which is only false when there was
 * no live child to kill.
 */
function killTree (child, signal = 'SIGTERM') {
  const pid = child?.pid
  if (!pid || child.exitCode !== null || child.signalCode !== null) return false

  if (process.platform === 'win32') {
    try {
      /* Detached and with its output thrown away: taskkill is fire-and-forget,
         and a pipe nobody reads is a pipe that can fill and stall it. `unref`
         so a quit is never waiting on the thing doing the quitting. */
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true
      })
      killer.on('error', () => { try { child.kill() } catch { /* already gone */ } })
      killer.unref()
    } catch {
      /* taskkill itself would not start — an unusual PATH, a locked-down
         machine. The wrapper alone is better than nothing. */
      try { child.kill() } catch { /* already gone */ }
    }
    return true
  }

  try {
    // The negative pid is the group, which is why everything here is spawned
    // `detached: true`. See the account above.
    process.kill(-pid, signal)
  } catch {
    /* No group by that id: the child was not spawned detached, or it and its
       group are already gone. Try the process on its own terms. */
    try { child.kill(signal) } catch { /* already gone */ }
  }
  return true
}

module.exports = { killTree }
