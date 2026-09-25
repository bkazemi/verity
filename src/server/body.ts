/**
 * Reads at most `maxBytes` of a response, and says whether it stopped early. A body is
 * whatever the far side chooses to send, so it is never read to the end on trust: the rest
 * is cancelled, which lets go of the connection instead of holding it to the deadline.
 */
export async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      if (!value?.byteLength) continue;

      // Reaching the limit exactly says nothing about whether the body ends there, so
      // only the end of the stream, read after it, says the whole thing was read.
      if (size >= maxBytes) {
        truncated = true;
        break;
      }

      chunks.push(value.subarray(0, maxBytes - size));
      size += value.byteLength;

      if (size > maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const bytes = new Uint8Array(Math.min(size, maxBytes));
  let at = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }

  return { bytes, truncated };
}

/** Lets go of a body nobody started reading. One already read has been let go of. */
export async function discard(response: Response): Promise<void> {
  if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
}
