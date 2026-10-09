# Magna Urbis · moteur Rust / WASM

**Alpha en cours de développement.** Ce moteur expérimental rattrape progressivement l'implémentation TypeScript. Le relief, l'érosion, les côtes et l'hydrologie sont en développement ; la génération urbaine et l'intégration complète restent à venir.

Le [README principal](../README.md) présente le projet et les captures de l'application TypeScript. L'objectif futur est l'intégration à [Neural Earth](https://github.com/dunkean/neural-earth), développé dans Infinite Map.

## Développement

Installer la toolchain épinglée dans `rust-toolchain.toml`, la cible `wasm32-unknown-unknown` et `wasm-pack`, puis les dépendances npm dans `web/`.

Depuis `web/` :

```sh
npm run wasm:terrain   # Compiler le module WebAssembly
npm run check:terrain  # Vérifier rustfmt, Clippy et la compilation WASM
```

Les modules générés sont placés dans `rust/pkg/wasm/`, ignoré par Git. L'application TypeScript conserve ses propres commandes de développement et de build, sans dépendance à Rust.

`crates/core/` contient le moteur sans navigateur ; `crates/wasm/` expose les bindings ; `bridge/` adapte temporairement les sorties à l'interface et au rendu existants. Le rendu actuel est provisoire, et le modèle TypeScript n'est pas imposé comme modèle permanent du moteur Rust.
