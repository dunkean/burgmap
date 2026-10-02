/** Tiny perf log (window.__perf) used by scripts/perf.mjs; zero cost when nobody reads it. */
export interface PerfLog { t: Record<string, number>; frames: number[]; extra: Record<string, unknown> }
const g = globalThis as unknown as { __perf?: PerfLog };
export const perf: PerfLog = (g.__perf ??= { t: {}, frames: [], extra: {} });
/** Record a named duration (ms) and a performance.mark. */
export function rec(name: string, ms: number): void {
  perf.t[name] = ms;
  try { performance.mark(`${name}:${ms.toFixed(1)}`); } catch { /* ignore */ }
}
export const now = (): number => performance.now();
