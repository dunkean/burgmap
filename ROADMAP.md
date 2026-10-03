# Burgmap completion roadmap

This checklist reconciles the open work in `BUGS.md`, `HANDOFF.md` §7 and `web/POLISH.md`. A task is complete only after its implementation and relevant geometry, visual, UI and performance checks pass. Preserve user bug reports and append their fixing commits.

## User bugs, in priority order

- [x] Overlapping phase districts and faubourgs (`0b8b5b9`, seeded regression and visual inspection).
- [x] Biomes: selectable climates, water-dependent cultivation, vegetation, consistent SVG/Canvas rendering, share links (`1508eb4`; six inspected previews, browser control/link, typecheck/build, targeted suites).
- [ ] Chinese moats: optional, terrain-aware, gates crossed properly; diversify and fill wards.
- [ ] Empty Japanese/Roman quarters on `p4uefz`: distinguish intentional gardens from inaccessible or discarded urban land.
- [ ] Venetian waterways: eliminate isolated river/canal ends.
- [ ] Stilt towns: adapt footprints and boardwalks to shores, channels and relief.
- [ ] Rural green seams: subdued boundaries between fields in both renderers.
- [ ] Terrace strokes: legible retaining walls and slope hachures at each zoom.

## Scale, performance and test health

- [ ] Megacity quarter detail: responsive loading at intermediate zoom, bounded memory, stable independent seeded results.
- [ ] Absorbed village greens: plausible village places rather than accidental triangles.
- [ ] Stand-in fabric: useful intermediate detail before exact quarters arrive.
- [ ] Five-million population: contain the full settlement on the map, with explicit extent handling when needed.
- [ ] Fast/slow test projects and commands; run the entire suite before completion.
- [ ] Ten-kilometre generation: reach the six-second target, retaining established output for pure optimisations.
- [ ] Check capital loading and Medina/Persian town budgets on a quiet machine.

## Culture and rendering quality

- [ ] Improve Ottoman fabric, Hanseatic street form, Korean ridge-following walls, stilt towns, Celtic oppida and Norse farmsteads; inspect all preset families.
- [ ] Implement the Swahili stone-town preset and its tests and visuals.
- [ ] Finish map-style polish and field furrows in Canvas.
- [ ] Make PNG export responsive and show export progress.
- [ ] Verify loading progress preserves the displayed map.
- [ ] Audit already-shipped farm variety, bug pins/links and minor-stream bridges; reconcile stale backlog checkboxes with evidence.

## Optional extensions and release

- [ ] Building roof/3D view and JSON import/export for editing.
- [ ] Evaluate WebGL and Rust/WASM only if measured rendering/export budgets still require them; the handoff records them as optional.
- [ ] Update architecture, README and handoff; run typecheck, build, full tests and browser/offline checks; publish the validated source and static build following repository conventions.
