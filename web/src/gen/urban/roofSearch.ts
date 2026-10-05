/** Area bands let the existing sorted search stop before constructing smaller unused proposals. */
export interface RoofAreaBand { low: number; high: number }
export interface RoofCandidateSearch<T> {
  sizes: { width: number; depth: number }[];
  areaMargin: number;
  build: (band?: RoofAreaBand) => T[];
}

/** Overlapping numerical bands stay together; stable true-area sorting preserves every original tie. */
export function* roofCandidateBatches<T>(sources: RoofCandidateSearch<T>[], measuredArea: (candidate: T) => number): Generator<T[]> {
  const areas = new Set<number>();
  const margin = Math.max(0, ...sources.map((s) => s.areaMargin));
  for (const source of sources) for (const size of source.sizes) areas.add(size.width * size.depth);
  const sort = (items: T[]) => items.sort((a, b) => measuredArea(b) - measuredArea(a));
  if (!Number.isFinite(margin) || [...areas].some((a) => !Number.isFinite(a))) {
    yield sort(sources.flatMap((s) => s.build())); return;
  }
  const ordered = [...areas].sort((a, b) => b - a), bands: RoofAreaBand[] = [];
  for (const a of ordered) {
    const last = bands.at(-1);
    if (last && a + margin >= last.low - margin) last.low = a;
    else bands.push({ low: a, high: a });
  }
  for (const band of bands) {
    const items = sort(sources.flatMap((s) => s.build(band)));
    if (items.length) yield items;
  }
}
