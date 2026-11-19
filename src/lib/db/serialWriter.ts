/* Copies of one document go to the database one at a time, and the last one
 * written is always the newest.
 *
 * Without this, two saves a moment apart send two copies at once; the older
 * one can land after the newer one, the database keeps the older copy as its
 * latest, and on the next start the app loads it: work done since (a lead's
 * score, an agent's progress) is lost, and agents repeat steps they already
 * did. Here, while a copy is on its way, further saves only note "again";
 * when it lands, the current value is sent once more. `onWritten` hears the
 * time the stored copy was taken, only when nothing newer is waiting. */

export function serialWriter<V>(
  write: (value: V) => Promise<boolean>,
  onWritten?: (takenAt: number) => void,
): (read: () => V) => Promise<void> {
  let busy = false;
  let again = false;
  let latest: (() => V) | null = null;
  return async function push(read: () => V): Promise<void> {
    latest = read;
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        const takenAt = Date.now();
        const value = (latest as () => V)();
        const ok = await write(value);
        if (ok && !again) onWritten?.(takenAt);
      } while (again);
    } finally {
      busy = false;
    }
  };
}
