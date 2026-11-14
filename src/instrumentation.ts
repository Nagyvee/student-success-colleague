/* Runs once when the server boots: start the always-on pump (queue, weekly
 * sweep, sheet watcher, daily report and, on Render, the keep-awake ping)
 * without waiting for the first visitor. */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureAutomation } = await import('./lib/engine/automation');
    ensureAutomation();
  }
}
