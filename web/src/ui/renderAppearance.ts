/** UI-only preferences deliberately excluded from generation Options and World JSON. */
export function paintedFromQuery(query: string): boolean { return new URLSearchParams(query.replace(/^\?/, '')).get('brushes') === 'painted'; }
export function appearanceQuery(query: string, painted: boolean): string {
  if (!painted && !new URLSearchParams(query).has('brushes')) return query;
  const q = new URLSearchParams(query); if (painted) q.set('brushes', 'painted'); else q.delete('brushes'); return q.toString();
}
