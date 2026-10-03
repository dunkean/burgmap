# Landmarks, activities, suburbs (M4)

Landmarks give the plan its life and its legibility. They are **not decorations placed on top of the fabric**: they are *lots claimed in the partition* before plots are cut (URBAN_GEOMETRY §3.4). Many of them reshape the street network around them: parvis, forecourt, arena ring, quay street. All placement is rule-based on terrain, network and history, per culture (URBAN_MORPHOLOGY). Every landmark is optional and has a toggle `auto | on | off`.

## 1. Mechanism

1. **Site selection** runs *before* level 2 (block splitting), on the quarter partition. Each landmark type has a score function over candidate locations:
   - distance to the nucleus;
   - height and prominence;
   - slope;
   - water frontage;
   - adjacency to arterials and gates;
   - phase (age);
   - distance to other landmarks (separation rules).
2. **Lot claim.** The chosen footprint polygon is cut out of its quarter as an exact piece, with the same split machinery. Its boundary becomes streets where the landmark needs access (parvis, forecourt), or stays a plot boundary (backs of houses against a monastery wall). The remaining quarter pieces continue through normal splitting.
3. **Internal layout.** Each landmark has a parametric internal plan that partitions its lot into built parts and open parts: church nave and aisles, cloister garth, bailey, courtyard.
4. **Street effects:**
   - parvis or place in front of main entrances;
   - widened market streets;
   - arena ring streets that fossilize the ellipse;
   - quay streets along water;
   - approach axes (processional ways for temples, avenues to palaces).
5. **Named** through `world.names` hooks. The user has their own name generator, so names are optional.

## 2. Catalogue (European default; culture variants in brackets)

| landmark | where | footprint / internal plan | street effect |
|---|---|---|---|
| **castle / citadel** [kasbah, jōkaku, kremlin, yamen-fort] | most defensible spot: hill, spur, meander neck, river bend or confluence; at the edge of the town, touching the wall | polygonal curtain (4–8 straight sides), keep, 1–2 baileys, ditch or moat ring, gatehouse facing the town; 0.3–3 ha | an open glacis/esplanade between castle and town; one approach street to its gate |
| **palace** (city+) [yamen, maharaja palace, dar al-imara] | near the nucleus or the castle, on a high or central site | courtyard complex, garden, forecourt | forecourt place, approach avenue |
| **cathedral** (city+, bishopric) [great mosque, main temple] | in the oldest phase, next to the market or on the highest ground of the core | cruciform plan (nave, transept, choir with apse, towers), 80–140 m long, oriented east; close with cloister, bishop's palace, canons' houses | parvis on its west front; close walls |
| **parish churches** | one per parish, about 1 per 1,500–3,000 inhabitants, spread across quarters (Voronoi-like separation), usually at a street corner or small place | nave, chancel, tower, 25–60 m; churchyard (cemetery) | small place or churchyard gate |
| **grand-place / market square** [souk lanes, walled market] | where the main radials meet, in the oldest phase | 0.2–1 ha; shape from history: triangular fork, rectangle, lens; town hall or market hall on it | all radials open into it |
| **secondary places** | forks, gates (intramural place behind each gate), church fronts, crossings of two arterials | 400–2,500 m² | — |
| **town hall / guildhall / market hall** | on the grand-place | hall 20–40 m, arcades | — |
| **monastery / priory / convent** (town+) [madrasa, Buddhist temple, math] | at the edge of the walled city or in the faubourgs (mendicant orders near gates) | church + cloister square + ranges around it + garden and orchard; walled precinct 0.5–4 ha | precinct wall with gate; streets bend around it |
| **hospital / almshouse** | near a gate or bridge | courtyard building | — |
| **arena / amphitheatre** (roman-core, or rare) | outside or at the edge of the core | ellipse 60–120 m; in medieval towns fossilized as an oval of houses built into the ruins (Arles, Lucca) | ring street following the ellipse |
| **port** (coast or navigable river) | sheltered water frontage nearest the nucleus: bay, estuary, river bank below the bridge | quays (straight stone edges along the water, 8–15 m wide), piers and jetties, basin, harbour chain towers; warehouse row behind the quay | a quay street parallel to the water; streets perpendicular to the quay ("ribs") |
| **shipyard** | port edge, on a gently sloping shore | slipways (long rectangles running into the water), timber yard, rope walk (a very long thin building, 200–300 m) | — |
| **fish market, customs house** | on the quay | — | — |
| **watermills** | river, on a weir or mill race near town | mill building straddling a mill race (a small canal cut); weir across the river | — |
| **windmills** | exposed hilltops or ridges outside the walls | round or post-mill footprint | track |
| **tanneries, dyers, butchers, potters** (nuisance trades) | downstream on the river, at the town edge or in faubourgs | long buildings with drying yards | — |
| **smithies, inns, stables** | at gates and along the entrance roads | courtyard inns with a carriage gateway | — |
| **gallows, lazar house, cemeteries** | outside the walls, on roads, on high ground (gallows) | — | — |
| **gardens, orchards, vineyards** | inside the walls, in younger phases and around monasteries | — | — |
| **city gates** | where radials cross the wall | gate towers, barbican (city+), intramural place | — |

The culture presets define their own catalogue and rules through the same mechanism:
- **medina:** great mosque with courtyard and minaret, souk lanes around it, hammams, funduqs near the gates, madrasa, mellah (walled quarter), kasbah;
- **chinese:** drum and bell towers, yamen, Confucian temple, city god temple, walled east and west markets;
- **japanese:** castle, temple belt, shrines, merchant streets;
- **indian:** temple complex with gopurams, tank, palace, bazaar.

## 3. Suburbs and shanty towns (option `suburbs: auto|none|some|many`, `shantytowns: none|some|many`)

- **Faubourgs** already exist as ribbons along the roads. Add *growth over time*: faubourgs thicken into suburbs with their own secondary streets. They get their own parish church and market place, and their own later wall (for a city: a new enclosure that includes them).
- **Absorbed villages:** pre-existing hamlets and villages near the town (from the rural stage) become suburb nuclei, with an irregular old core inside the suburban fabric.
- **Shanty towns / informal settlements:** they appear on the least valued land:
  - floodplains;
  - steep slopes;
  - along the outside of the wall (the glacis, when allowed);
  - near tanneries and dumps;
  - between roads at the urban fringe.
  
  Their morphology differs from the planned fabric:
  - no plot partition, but a *dense irregular packing* of small huts (15–40 m²) with narrow winding footpaths (1–2 m);
  - they are generated as their own partition: a Voronoi of hut seeds relaxed, with footpaths as the cut network, and a coverage of 50–70 %;
  - no gardens, few wide paths, occasional water points.
  
  Culture variants include the Parisian "zone" outside the walls, gecekondu hillsides and bidonville edges.
- **Suburban land use:** market gardens, orchards, vineyards, laundry fields (bleaching grounds), rope walks and brick kilns in the rural–urban fringe.

## 3b. Bridges

- **Big rivers** (11 m wide and more, `m4/bridges.ts`): a bridge every 250–500 m of course inside the enclosure, closer in the core, on main streets only; in a large city the bridge nearest the nucleus carries houses.
- **Streams and small rivers** (`streambridges.ts`), in towns and villages: secondary streets and lanes cross them, as in Colmar, Annecy or Strasbourg's Petite France. A crossing is a street piece over the water only, square to the stream within ±30°, joined to a street on each bank:
  - two streets ending on facing banks are joined;
  - a street ending on the bank is carried across by a lane cut through the piece opposite (an ordinary partition cut ending on a connected street);
  - a stretch of stream without a crossing for more than about 65 m on either side gets a lane cut through the bank pieces on both sides.
  
  New crossings keep 45 m (streets) or 55 m (lanes) from the others. Kinds (`kind`/`arch` on the `World.bridges` entry, drawn at true size over the street space): plank footbridge for lanes (2–3 m), stone arch for streets (4–7 m); arched timber bridges in Japanese towns, stone humpbacks in Chinese towns, the stepped footbridges of the canals in lagoon towns (Venetian, gnomish); villages ford the brooks under 4 m most of the time.

## 4. Invariants

- Landmark lots are pieces of the partition, so no overlaps.
- Every landmark has street access at its entrance.
- Quays are on water and piers extend into it; nothing else overlaps water except bridges, mills, piers and slipways.
- Separation rules between landmarks are respected.
- Determinism.
