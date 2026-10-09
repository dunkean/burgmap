# Magna Urbis - Rust / WASM engine

**Alpha, under development.** This experimental engine is gradually catching up with the TypeScript implementation. Relief, erosion, coasts and hydrology are under development; urban generation and full application integration remain to come.

The [main README](../README.md) introduces the project and shows screenshots of the TypeScript application. The long-term goal is integration into [Neural Earth](https://github.com/dunkean/neural-earth), developed in Infinite Map.

## Development

Install the toolchain pinned in `rust-toolchain.toml`, the `wasm32-unknown-unknown` target and `wasm-pack`, then install npm dependencies in `web/`.

From `web/`:

```sh
npm run wasm:terrain   # Compile the WebAssembly module
npm run check:terrain  # Check rustfmt, Clippy and WASM compilation
```

Generated modules are placed in `rust/pkg/wasm/`, which Git ignores. The TypeScript application keeps its own development and build commands without depending on Rust.

`crates/core/` contains the engine without browser dependencies; `crates/wasm/` exposes bindings; `bridge/` temporarily adapts output to the existing interface and renderer. The current renderer is provisional, and the TypeScript model is not imposed as the permanent Rust engine model.
