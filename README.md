# Magna Urbis

DEMO: https://dunkean.github.io/magna-urbis/

**Magna Urbis is inspired by [TownGeneratorOS by Watabou (Oleg Dolya)](https://github.com/watabou/TownGeneratorOS) and his [Medieval Fantasy City Generator](https://watabou.itch.io/medieval-fantasy-city-generator).** The original Python prototype began as a port of TownGeneratorOS; the TypeScript and Rust implementations continue that exploration.

**Work in progress. Alpha. Prototype.** Magna Urbis generates pre-modern settlements and their surrounding landscapes for maps and tabletop role-playing games. Its output, performance and interfaces are still evolving. This is an experimental project, not a finished application.

There are two implementations: **TypeScript**, currently the most complete, and **Rust / WebAssembly**, which is still behind in features but is gradually catching up.

The long-term goal is to **integrate Magna Urbis into [Neural Earth](https://github.com/dunkean/neural-earth)**, the procedural world project developed in Infinite Map, placing cities and villages within a regional and planetary landscape. This integration is planned for the future and has not been delivered yet.

## Prototype screenshots

Actual captures from the TypeScript application: three cities of 30,000 inhabitants and a village of 600. They show different urban layouts and the **Parchment** and **Atlas** map styles, including the prototype's current imperfections.

### Medieval city - Parchment

![Medieval city and river in the Parchment map style](docs/images/medieval-city.png)

### Desert medina - Atlas

![Medina in a desert landscape in the Atlas map style](docs/images/desert-medina.png)

### Planned Chinese city - Atlas

![Planned Chinese city in the Atlas map style](docs/images/chinese-city.png)

### Village and countryside - Parchment

![Village surrounded by countryside in the Parchment map style](docs/images/village.png)

The [capture seeds, settings and views](docs/images/screenshots.json) let you reproduce these examples with the corresponding version. Rust does not generate these cities yet.

## TypeScript and Rust

| | TypeScript - `web/` | Rust / WASM - `rust/` |
| --- | --- | --- |
| Status | Most complete prototype and reference application | New engine under development |
| Landscape | Relief, biomes, coasts, rivers, lakes and rural land use | Relief, erosion, coasts, lakes and river networks |
| Settlements | Hamlets, villages and cities; quarters, streets, plots, buildings and landmarks | Urban generation still to come |
| Interface | Interactive map, settings, seeds, sharing and SVG / PNG / JSON exports | Browser integration in progress |
| Computation | TypeScript in the browser, without a generation server | Rust compiled to WebAssembly, with WebGPU paths for selected stages |

TypeScript explores organic street patterns, bastides, medinas, Chinese and Japanese plans, and fantasy cultures. Cultures can be combined through successive growth phases. Large populations and progressive detail remain experimental.

Rust is gradually taking over generation responsibilities. Performance and precision still depend on calculation grids, terrain and the browser's CPU/GPU capabilities. It is not yet a complete replacement for TypeScript.

The current interface is intended to be retained. The existing renderer is a temporary integration aid; the future rendering engine remains to be developed.

## Run the TypeScript application

Requirements: a recent Node.js LTS release and npm.

```sh
cd web
npm ci
npm run dev
```

Open the address printed by Vite, usually **http://localhost:5173/**. Choose the environment, then the settlements, their populations and cultures. Generate the map and explore it by zooming. The same seed and settings reproduce a generation within the same engine version.

```sh
npm run build
```

The build produces `web/dist/index.html`, a self-contained page that can run offline. TypeScript development and builds do not require Rust.

In **Share & export**, choose the SVG / PNG layers independently: relief, water, vegetation and fields, buildings and town grounds, town streets, regional roads, names, and decoration. Presets export the complete map, town only, relief only, or roads and streets only. Disable **Paper background** for transparent overlays; the relief image itself remains opaque. These choices affect downloads without regenerating the map. JSON exports retain all world data.

## Develop the Rust engine

Install the toolchain pinned in `rust/rust-toolchain.toml`, the `wasm32-unknown-unknown` target and `wasm-pack`. On Windows, install the Visual Studio C++ build tools and Windows SDK.

After installing npm dependencies, run these commands from `web/`:

```sh
npm run wasm:terrain   # Compile the WebAssembly module
npm run check:terrain  # Check Rust code and WASM compilation
```

Generated modules stay in `rust/pkg/wasm/`, which Git ignores. See the [Rust README](rust/README.md) for the engine's organization.

## Repository layout

```text
web/src/gen/      TypeScript generation
web/src/render/   Current SVG and Canvas rendering
web/src/ui/       Interface and workers
web/tests/        TypeScript tests
web/scripts/      Captures and verification tools
rust/crates/core/ Rust engine without browser dependencies
rust/crates/wasm/ WebAssembly bindings
rust/bridge/      Temporary interface and rendering adapters
rust/scripts/     Rust development commands
town_generator/  Earlier Python prototype, retained as a reference
tests/           Python prototype tests
docs/images/     README screenshots and reproduction settings
```

The Python prototype is historical; it is not a third active engine.

## Contributing

From `web/`, use `npm run typecheck`, `npm run test:fast` and `npm run build` to check changes. `npm test` also includes the exhaustive city and culture matrix and can take several dozen minutes.

When reporting a problem, include the version, seed, settings and shared link, with a screenshot if possible. The application supports pins and copying a bug report. Formats, results and generation links may change during this alpha.

## Credits and license

Thank you to **Watabou** for TownGeneratorOS and Medieval Fantasy City Generator, the starting point for this project and an ongoing reference.

Magna Urbis is distributed under the **GNU GPL v3**; see [LICENSE](LICENSE). The Python prototype retains its lineage from TownGeneratorOS. Third-party resources and dependencies retain their own license and provenance notices.
