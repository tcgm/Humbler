export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterDelay(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs);
}

// Wait a randomized amount of time between minMs and maxMs. Used between
// scrolls (and later, downloads) so requests don't land in a suspiciously
// regular pattern.
export async function politeDelay(minMs: number, maxMs: number): Promise<void> {
  await sleep(jitterDelay(minMs, maxMs));
}
