# Magna Urbis

**Magna Urbis est un travail inspirÃ© de [TownGeneratorOS de Watabou (Oleg Dolya)](https://github.com/watabou/TownGeneratorOS) et de son [Medieval Fantasy City Generator](https://watabou.itch.io/medieval-fantasy-city-generator).** Le premier prototype Python est issu d'un port de TownGeneratorOS ; les moteurs TypeScript et Rust poursuivent cette exploration avec leurs propres implÃ©mentations.

**Projet en cours de dÃ©veloppement Â· alpha Â· prototype.** Magna Urbis gÃ©nÃ¨re des implantations prÃ©-modernes et leurs paysages pour la cartographie et le jeu de rÃ´le. Les rÃ©sultats, les performances et les interfaces Ã©voluent encore : ce dÃ©pÃ´t prÃ©sente un travail expÃ©rimental, pas un logiciel achevÃ©.

Le projet comporte **deux implÃ©mentations actives, TypeScript et Rust**. TypeScript est aujourd'hui la plus complÃ¨te. Rust est en retard sur son pÃ©rimÃ¨tre fonctionnel, mais le rattrape progressivement, en commenÃ§ant par le relief, les cÃ´tes et l'hydrologie.

Ã€ terme, Magna Urbis doit Ãªtre intÃ©grÃ© Ã  **[Neural Earth](https://github.com/dunkean/neural-earth)** pour inscrire les villes et villages dans un monde procÃ©dural plus vaste. Cette intÃ©gration est un objectif de dÃ©veloppement ; elle n'est pas encore livrÃ©e.

## AperÃ§us du prototype

Captures rÃ©elles de l'application TypeScript, avec des graines et rÃ©glages reproductibles. Les styles **Parchemin** et **Atlas** montrent aussi diffÃ©rentes morphologies urbaines. Ces images illustrent l'Ã©tat actuel du prototype, avec ses imperfections.

### Grande ville mÃ©diÃ©vale Â· Parchemin

![Grande ville mÃ©diÃ©vale, rendu Parchemin](docs/images/medieval-city.png)

### MÃ©dina dans le dÃ©sert Â· Atlas

![MÃ©dina dans un paysage dÃ©sertique, rendu Atlas](docs/images/desert-medina.png)

### Ville chinoise planifiÃ©e Â· Atlas

![Ville chinoise planifiÃ©e, rendu Atlas](docs/images/chinese-city.png)

### Village et campagne Â· Parchemin

![Village entourÃ© de campagne, rendu Parchemin](docs/images/village.png)

Les [rÃ©glages des captures](docs/images/screenshots.json) permettent de retrouver ces exemples. Les captures proviennent de TypeScript ; Rust ne gÃ©nÃ¨re pas encore ces villes.

## Deux moteurs, deux niveaux d'avancement

| | TypeScript Â· `web/` | Rust / WASM Â· `rust/` |
| --- | --- | --- |
| RÃ´le actuel | Application de rÃ©fÃ©rence et prototype complet de gÃ©nÃ©ration d'implantations | Nouveau moteur expÃ©rimental, dans un banc sÃ©parÃ© |
| Paysage | Relief, biomes, cÃ´tes, cours d'eau, lacs et occupation rurale | Relief, Ã©rosion, cÃ´tes, lacs et rÃ©seaux de riviÃ¨res ; calcul CPU et chemins WebGPU selon les Ã©tapes |
| Implantations | Hameaux, villages, villes ; quartiers, rues, parcelles, bÃ¢timents et monuments | GÃ©nÃ©ration urbaine encore Ã  venir |
| Interface | Carte interactive, paramÃ¨tres, graines, liens de partage, exports SVG / PNG / JSON | Banc de terrain interactif, rÃ©glages par Ã©tape et diagnostics |
| ExÃ©cution | Navigateur, sans serveur de gÃ©nÃ©ration | Rust compilÃ© en WebAssembly, exÃ©cutÃ© dans le navigateur |

Le moteur TypeScript explore notamment les tracÃ©s organiques, les bastides, les mÃ©dinas, les plans chinois et japonais, ainsi que des cultures fantastiques. Plusieurs cultures peuvent se combiner au fil des phases de croissance. Les grandes populations et leur dÃ©tail progressif restent expÃ©rimentaux.

Le moteur Rust n'est pas encore un remplacement complet de TypeScript. Il rÃ©utilise temporairement une partie de l'interface et du rendu existants pour tester les Ã©tapes dÃ©jÃ  portÃ©es. L'interface actuelle doit Ãªtre conservÃ©e Ã  terme ; le rendu actuel est une aide d'intÃ©gration provisoire, et le futur moteur de rendu reste Ã  dÃ©velopper.

## Essayer l'application TypeScript

PrÃ©requis : Node.js et npm. Utiliser une version LTS rÃ©cente de Node.js.

```sh
cd web
npm ci
npm run dev
```

Ouvrir l'adresse indiquÃ©e par Vite, gÃ©nÃ©ralement **http://localhost:5173/**. Choisir l'environnement, puis les implantations, leur population et leur culture. GÃ©nÃ©rer la carte et explorer au zoom. Une graine et les mÃªmes paramÃ¨tres permettent de reproduire une gÃ©nÃ©ration pour une mÃªme version du moteur.

Le banc isolÃ© de rues, parcelles et bÃ¢timents est accessible Ã  **`/testbench.html`**.

```sh
npm run build
```

Le build produit `web/dist/index.html` et `web/dist/testbench.html`, des pages autonomes utilisables hors ligne. **Le dÃ©veloppement et le build TypeScript ne nÃ©cessitent pas Rust.**

## Essayer le prototype Rust

PrÃ©requis supplÃ©mentaires : la toolchain dÃ©finie dans `rust/rust-toolchain.toml`, la cible `wasm32-unknown-unknown` et `wasm-pack` dans le PATH. Sous Windows, prÃ©voir les outils de compilation C++ de Visual Studio et le SDK Windows.

Installer la toolchain depuis `rust/`, puis lancer le banc depuis `web/` :

```sh
cd rust
rustup show
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked
cd ../web
npm ci
npm run dev:terrain
```

Ouvrir **http://localhost:5173/terrainbench.html** ou l'adresse indiquÃ©e par Vite. La commande compile le WASM, lance le banc et recompile les sources Rust lors des modifications.

```sh
npm run wasm:terrain   # Recompiler le module WASM
npm run build:terrain  # Produire le banc autonome
npm run check:terrain  # rustfmt, Clippy et compilation WASM
```

Le build Rust produit `rust/out/browser/terrainbench.html`. Les modules WASM gÃ©nÃ©rÃ©s restent dans `rust/pkg/wasm/`. Ces sorties sont ignorÃ©es par Git et sÃ©parÃ©es de `web/dist/`.

Rust permet dÃ©jÃ  d'explorer plusieurs familles de relief, de sÃ©parer l'Ã©tendue de carte et la taille des motifs, de rÃ©gler l'Ã©rosion et les cÃ´tes, et d'inspecter l'hydrologie. La prÃ©cision reste bornÃ©e par les grilles de calcul ; le zoom ne remplace pas une simulation Ã  plus haute rÃ©solution. Les performances dÃ©pendent du relief, de la taille de carte et des capacitÃ©s CPU/GPU du navigateur.

## Organisation du dÃ©pÃ´t

```text
web/src/gen/      Moteur TypeScript et algorithmes de gÃ©nÃ©ration
web/src/render/   Rendu SVG et Canvas actuel
web/src/ui/       Interface, contrÃ´les et workers
web/tests/        Tests TypeScript
web/scripts/      AperÃ§us, captures et vÃ©rifications de l'application
rust/crates/core/ Moteur Rust sans dÃ©pendance au navigateur
rust/crates/wasm/ Bindings WebAssembly
rust/bridge/      Adaptateurs temporaires vers l'interface et le rendu
rust/scripts/     Commandes de dÃ©veloppement et de build Rust
town_generator/  Ancien prototype Python, conservÃ© comme rÃ©fÃ©rence
tests/           Tests du prototype Python
docs/images/     Captures prÃ©sentÃ©es dans ce README
```

Le prototype Python est historique ; il ne constitue pas un troisiÃ¨me moteur actif. Les notes internes de conception, documents de travail, audits et anciennes captures sont archivÃ©s localement et ne font pas partie des fichiers suivis par Git. Les licences et les crÃ©dits des dÃ©pendances et ressources restent dans le dÃ©pÃ´t.

## VÃ©rifier et contribuer

Depuis `web/` :

```sh
npm run typecheck
npm run test:fast
npx vitest run tests/urban.determinism.test.ts
npm run build
```

`npm test` lance Ã©galement la matrice exhaustive des villes et cultures ; prÃ©voir plusieurs dizaines de minutes. `npm run test:slow` permet de lancer cette matrice sÃ©parÃ©ment.

Pour produire un aperÃ§u de carte :

```sh
npm run preview:png -- --seed 42 --size town --out out/check.png
```

Pour refaire les captures du README aprÃ¨s un build :

```sh
node scripts/readme_screenshots.mjs
```

Pour vÃ©rifier le prototype Python, depuis la racine : `python -m pytest tests/ -q`.

Pour signaler un problÃ¨me, joindre la version utilisÃ©e, la graine, les paramÃ¨tres et le lien de partage, avec une capture si possible. L'application propose Ã©galement des pins et la copie d'un rapport de bug. Les formats, les rÃ©sultats et les liens de gÃ©nÃ©ration peuvent Ã©voluer pendant cette alpha.

## CrÃ©dits et licence

Merci Ã  **Watabou** pour TownGeneratorOS et Medieval Fantasy City Generator, qui sont Ã  l'origine de ce projet et restent une rÃ©fÃ©rence majeure.

Magna Urbis est distribuÃ© sous la **GNU GPL v3** ; voir [LICENSE](LICENSE). Le prototype Python conserve sa filiation avec TownGeneratorOS. Les ressources et dÃ©pendances tierces gardent leurs propres notices de licence et de provenance dans les dossiers correspondants.
