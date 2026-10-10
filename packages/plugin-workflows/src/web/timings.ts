/**
 * Delays that coalesce typing into one request or local draft write. Hosts and tests may set them to 0, which
 * issues the request immediately so no behavior depends on wall-clock time.
 */
export const authoringTimings = { searchDelayMs: 250, validationDelayMs: 400, draftDelayMs: 300 };
/** Run after `delayMs` (immediately at 0); the returned cleanup cancels a pending run. */
export function debounce(run: () => void, delayMs: number): () => void {
  if (delayMs <= 0) {
    run();
    return () => {};
  }
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
}
