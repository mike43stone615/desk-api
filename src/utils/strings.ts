/** Removes trailing "/" characters. A loop, not a regular expression: `/\/+$/` is quadratic on a long run of slashes. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

/** Text in one canonical Unicode form (NFC), so "é" typed as one character or as e + accent is stored (and compared) the same way. */
export function nfc(value: string): string {
  return value.normalize('NFC');
}

/** Every string inside a JSON-like value in NFC (objects and arrays are copied; other values are returned as they are). */
export function nfcDeep<T>(value: T): T {
  if (typeof value === 'string') return nfc(value) as unknown as T;
  if (Array.isArray(value)) return value.map(nfcDeep) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [nfc(k), nfcDeep(v)])) as T;
  }
  return value;
}
