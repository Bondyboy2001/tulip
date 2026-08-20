// @ts-check
'use strict'

/* How to stop a process and everything it started.

   A fenced block runs a real interpreter, and that interpreter starts children
   of its own — a shell that starts python, a python that starts a compiler.
   Stopping the one process Node has a handle on leaves the rest running, so
   both platforms are asked to take the whole tree, and neither does it the same
   way:

   - POSIX signals the process *group*, which is what the negative pid means.
     The group exists because the spawn asked for one; see `detached` at the
     call site.
   - Windows has no process groups and no signals. `taskkill /t` walks the tree
     by parent id instead, and `/f` is the difference between asking and
     insisting — the closest thing there is to SIGTERM and SIGKILL.

   The decision is separated from the act of carrying it out so that it can be
   tested. Spawning a real tree of processes to find out whether Windows gets
   `/t` is not a trade worth making, and this way the answer is checked on every
   platform rather than only on the one running the suite. */

/**
 * @typedef {{ kind: 'spawn', command: string, args: string[] }} SpawnPlan
 * @typedef {{ kind: 'signal', target: number, signal: string }} SignalPlan
 */

/**
 * What to do to stop `pid` and its descendants.
 *
 * @param {number} pid the process Node holds a handle on
 * @param {string} signal 'SIGTERM' to ask, 'SIGKILL' to insist
 * @param {string} platform `process.platform` of the host
 * @returns {SpawnPlan | SignalPlan}
 */
function killPlan (pid, signal, platform) {
  if (platform === 'win32') {
    const args = ['/pid', String(pid), '/t']
    if (signal === 'SIGKILL') args.push('/f')
    return { kind: 'spawn', command: 'taskkill.exe', args }
  }
  // Negative: the group, not the leader. Everything the run started goes with
  // it, which is the whole point.
  return { kind: 'signal', target: -pid, signal }
}

module.exports = { killPlan }
