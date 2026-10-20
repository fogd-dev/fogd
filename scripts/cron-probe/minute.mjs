export function nextMinuteBoundary() { return Math.floor(Date.now() / 60000 + 1) * 60000; }

export async function waitForMinuteBoundary(at = nextMinuteBoundary()) {
  while (Date.now() < at + 2000) await new Promise(resolve => setTimeout(resolve, 250));
  return at;
}
