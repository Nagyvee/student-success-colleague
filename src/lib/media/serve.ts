/* Sound and video as phones ask for it.
 *
 * iPhones ask for a file in pieces (Range: bytes=0-1 first) and refuse to play
 * anything that answers with the whole file instead. */

export function serveMedia(req: Request, data: Uint8Array, headers: Record<string, string>): Response {
  const size = data.length;
  const base = { ...headers, 'Accept-Ranges': 'bytes' };
  const m = req.headers.get('range')?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2]) && size) {
    if (m[1] && Number(m[1]) >= size) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = Math.max(start, m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1);
    return new Response(new Uint8Array(data.subarray(start, end + 1)), {
      status: 206,
      headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(new Uint8Array(data), { headers: { ...base, 'Content-Length': String(size) } });
}
