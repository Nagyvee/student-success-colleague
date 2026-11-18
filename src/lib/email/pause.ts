/* The server's sending lock.
 *
 * While the academy is still testing, nothing may leave the building: no
 * email, WhatsApp, ManyChat message or phone call, and no write-back to a
 * sheet or an LMS. Everything is still drafted, reviewed and shown in the
 * Inbox, so the team can see exactly what would have gone.
 *
 * Sending stays paused unless the server is started with SENDING_PAUSED=false,
 * whatever the Live Outreach switch in the app says. */

export function sendingPaused(): boolean {
  return !/^(0|false|no|off)$/i.test((process.env.SENDING_PAUSED || '').trim());
}

/** Live sending is allowed only when the server lock is off AND the workspace switched Live Outreach on. */
export function liveAllowed(workspaceLiveSwitch: boolean | undefined): boolean {
  return !sendingPaused() && Boolean(workspaceLiveSwitch);
}

export const PAUSED_NOTE = 'Sending is paused on this server (test phase). Nothing leaves the building; see the Inbox.';
