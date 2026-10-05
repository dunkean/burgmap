/** Cell positions in the untouched ImageGen 5×5 transparent atlas. */
const ICONS: Record<string, number> = {
  newMap: 0, surprise: 1, customize: 2,
  temperate: 3, forest: 4, desert: 5, steppe: 6, tropical: 7, tundra: 8,
  underdark: 9, 'underdark-caverns': 10,
  flat: 11, hills: 12, valley: 13, mountains: 14,
  'coast-none': 15, 'coast-random': 16, 'coast-N': 17, 'coast-E': 18,
  'coast-S': 19, 'coast-W': 20,
  'river-none': 21, 'river-stream': 22, 'river-river': 23, 'river-major': 24,
};

export function railIcon(id: string): string {
  const cell = ICONS[id];
  if (cell === undefined) throw new Error(`Unknown rail icon: ${id}`);
  return `<span class="rail-art" aria-hidden="true" style="background-position:${cell % 5 * 25}% ${Math.floor(cell / 5) * 25}%"></span>`;
}
