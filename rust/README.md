# Magna Urbis · prototype Rust / WASM

**Alpha en cours de développement.** Ce moteur expérimental rattrape progressivement le prototype TypeScript. Il génère actuellement du relief, de l'érosion, des côtes et de l'hydrologie dans un banc séparé ; la génération des villes reste à venir.

Le [README principal](../README.md) présente les deux implémentations, les captures, les prérequis, les commandes de lancement et l'objectif d'intégration à Neural Earth.

Depuis `web/`, après installation des dépendances npm, de la toolchain Rust épinglée et de `wasm-pack` :

```sh
npm run dev:terrain
npm run wasm:terrain
npm run build:terrain
npm run check:terrain
```

Le banc est accessible à `/terrainbench.html`. Le build autonome est produit dans `rust/out/browser/terrainbench.html` ; le package WASM dans `rust/pkg/wasm/`. Ces sorties sont ignorées par Git. Les commandes habituelles `npm run dev` et `npm run build` restent indépendantes de Rust.

`crates/core/` contient le moteur sans navigateur ; `crates/wasm/` expose les bindings ; `bridge/` adapte temporairement les sorties à l'interface et au rendu existants. Le futur rendu et l'intégration complète ne sont pas encore livrés. Le modèle TypeScript actuel n'est pas imposé comme modèle permanent du moteur Rust.
