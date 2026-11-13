function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterDelay(minMs, maxMs) {
  return minMs + Math.random() * (maxMs - minMs);
}

// Wait a randomized amount of time between minMs and maxMs. Used between
// scrolls (and later, downloads) so requests don't land in a suspiciously
// regular pattern.
async function politeDelay(minMs, maxMs) {
  await sleep(jitterDelay(minMs, maxMs));
}

module.exports = { sleep, politeDelay };
