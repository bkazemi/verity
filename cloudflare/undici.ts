/**
 * Stands in for undici in the Worker build. Only `publicFetch()` loads it, and only on
 * Node, so on Workers the real one would be a megabyte of code that can never run.
 */
function unavailable(): never {
  throw new Error('undici is not available on Workers');
}

export const Agent = unavailable;

export const fetch = unavailable;
