import { getState, subscribe } from '@/lib/engine/store';
import { ensureAutomation } from '@/lib/engine/automation';
import type { WorldState } from '@/lib/types';
import { runWithSessionTenant } from '@/lib/auth/requestTenant';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* The live office, as Server-Sent Events (scoped to the user's workspace). */

export async function GET(req: Request) {
  return runWithSessionTenant(req, () => {
    ensureAutomation();
    const enc = new TextEncoder();
    let unsub: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const send = (s: WorldState) => {
          if (!open) return;
          try { controller.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify(s)}\n\n`)); }
          catch { open = false; }
        };
        send(getState());
        unsub = subscribe(send);
        heartbeat = setInterval(() => { try { controller.enqueue(enc.encode(': ping\n\n')); } catch { open = false; } }, 15000);
        const close = () => {
          open = false;
          unsub?.(); unsub = null;
          if (heartbeat) clearInterval(heartbeat);
          try { controller.close(); } catch { /* already closed */ }
        };
        req.signal.addEventListener('abort', close);
      },
      cancel() {
        unsub?.();
        if (heartbeat) clearInterval(heartbeat);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });
}
