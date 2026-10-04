# Burgmap completion roadmap

This checklist reconciles the open work in `BUGS.md`, `HANDOFF.md` §7 and `web/POLISH.md`. A task is complete only after its implementation and relevant geometry, visual, UI and performance checks pass. Keep open user bug reports unchanged; remove resolved entries from BUGS.md after validation, as requested by the user. Record completed work here and in Git history.

Current review gate: Astra, actual Claude Opus 5.5 and actual Claude Sonnet 5.5 must all approve each substantial source change or amendment before tests, typecheck, build or generation of the modified code.

## User bugs, in priority order

- [x] Overlapping phase districts and faubourgs (`0b8b5b9`, seeded regression and visual inspection).
- [x] Biomes: selectable climates, water-dependent cultivation, vegetation, consistent SVG/Canvas rendering, share links (`1508eb4`; six inspected previews, browser control/link, typecheck/build, targeted suites).
- [x] Chinese moats: optional, terrain-aware, dry gates and double-wall crossings; separate defensive reserves, SVG/Canvas water holes (`6f78c19`; Astra + Opus 5.5 reviews before 39 passing tests, typecheck/build, inspected PNG and browser On/Off/link checks).
- [x] Chinese wards: accessible cardinal hutongs and irregular siheyuan compounds (`d0b5f99`, `5dd7025`). Oversized plots are split on real frontage; pavilion ranges stay in connected lot sections. Astra + Opus 5.5 reviewed code and before/after images before final verification: 46 targeted tests, typecheck/build and browser checks passed. Sparse residential area on `p4uefz` fell from 163,522 to 28,605 m².
- [x] Japanese/Roman gaps (`0340ace`, `01171fe`): release 139,847 m² of unserved reserve and grow connected local-axis merchant roji. Largest Japanese merchant plot falls from 114,614 to 6,460 m²; the crescent gains 55,679 m² of roofs. Roman gardens are intentional. Both code and image reviews passed; 89 regression/culture tests plus 12 focused ward tests, typecheck/build and browser checks passed.
- [x] Venetian waterways (`e2c4514`): route short connections inside public street space; validate shore outlets and dry full-width bridge landings. All 12 canal components on p4uefz reach natural water (previously 9 of 35); buildings/parcels unchanged, gnomish output byte-identical. Both source/image reviews, 24 tests across four sizes, typecheck/build and browser checks passed.
- [x] Stilt towns (`4a4e493`): reliable shore selection, terrain-shaped quarters, reserved navigation channels, connected shore walks and precise safe ends. Short plots and one local council platform retain density; unusable bank corners are cleared with area guards. Astra + actual Opus 5.5 reviewed every amendment before tests and accepted wide/detail images. Nine focused tests, six culture cases, two city diagnostics, determinism/terrain identity, typecheck/build and browser checks passed. P4uefz now has 138 buildings on the bank; river channels stay open.
- [x] Rural green seams (`5c504a6`): shared muted earth/olive boundaries and sparse hedge trees in SVG/Canvas, exact shared-edge deduplication, disabled-style/biome support and mid-zoom fade. Both source and image reviews accepted; 28 targeted/Canvas tests, typecheck/build and three live rural zooms passed.
- [x] Terrace strokes (`f30671b`): continuous soft riser shade, fine retaining walls, real arc-spaced hachures and transverse stairs shared by SVG/Canvas. Detail fades at intermediate zoom. Both source and final image reviews accepted; 32 rendering/Canvas tests, typecheck/build and live Inca/dwarven views from 0.1 to 6 px/m passed.
- [x] Open-town edges (`7074c2a`): small served fringe lanes, lower edge density and garden gaps; rural cover reaches the exact footprint while farms keep their safe reserve. Astra + actual Opus 5.5 approved every code amendment before testing and accepted wide/detail/Canvas images. Thirteen focused and nine field tests, typecheck/build, seven culture diagnostics and three live zooms passed; single/double/elf hedge-walled output remains byte-identical. P4 gains four fringe quarters and 29 garden gaps without parcel overlaps or lost frontage.
- [x] Primitive cities (`4fb1626`): twelve tribal cultures grow one urban plan above culture-specific population thresholds, with native roundhouses, longhouses, tents or pueblo rows; masonry landmarks are suppressed and appropriate palisades retained. Astra + actual Opus 5.5 + actual Sonnet 5.5 approved source and amendments before execution. Eighteen focused tests, fourteen whole-world identity checks for unchanged villages/control towns, typecheck/build, twelve generated culture profiles, inspected SVG/PNG details and live Canvas controls passed.
- [ ] Open-town ground: blend countryside texture into peripheral quarters instead of a uniform urban background (new user report in `BUGS.md`, after the primitive-city fix).
- [ ] Estuary variety: generate several mouth shapes, including a river that simply widens instead of a round basin (new user report).
- [ ] Water-aware town plans: audit every family and keep ordinary quarters and houses on dry land, with explicit exceptions for suitable water architecture (new user report).
- [x] Settlement placement (`248fd34`, `0d968e6`): choose main/village centres by coordinates or map click; retain partial input and support cancel, automatic reset and shared links. Unsafe centres move deterministically to usable land; conflicting or unreachable secondary positions warn rather than exceeding their correction budget. Explicit megacity centres reserve their footprint even on large maps. All three reviewers approved source, fusion and amendments before execution; 13 placement regressions plus 15 existing settlement/site tests passed, then 31 combined primitive/placement tests, 14 unchanged-world hashes, typecheck/build and live click/cancel/reload checks passed.
- [x] Explicit settlement types (`0eec619`): choose farmstead, hamlet or village directly, with visible population and the existing larger classes. Type/population edits update the row without losing focus, unfinished coordinates or pending map placement. Astra, actual Opus 5.5 and actual Sonnet 5.5 approved before execution; 28 relevant tests, typecheck/build and isolated/root browser checks passed. Seed 4 preserves placed village/hamlet/farm links. Oversized requests warn on a 3.6 km map; a 40 km map keeps 1.5M and 250k settlements lazy, with the 1.5M macro plan generated in about 0.87 seconds.
- [ ] Large-map strokes: bound contour and field-interior strokes so they do not grow ugly with image/map extent (new user report).
- [ ] Dense houses: fix overlapping footprints, arbitrary cuts and inconsistent geometry in tightly built quarters (new user report; dedicated parallel agent).
- [x] Road backgrounds (`fc6a312`): share bounded physical road/bridge widths between SVG and Canvas, colour rural activity tracks as earth and clip enlarged urban arterials to the real town ground. An 8 m road on a 10 km map now exports at a readable 10 m rather than 42.5 m. Astra + actual Opus 5.5 + actual Sonnet 5.5 approved source and amendments before execution; eight seeded/Canvas/resvg/macro regressions, 13 combined rendering tests, typecheck/build, before/after PNG and browser checks passed. Rural activity and village-street audits confirmed preserved legitimate yards and regional continuations; SVG casing changes deliberately match Canvas.

## Scale, performance and test health

Bug fixes take priority. The user requested a preliminary performance study, without committing to a Rust port: see `PERFORMANCE_STUDY.md` for measured generation, scene preparation, frame and export costs and the proposed profiling targets.

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
