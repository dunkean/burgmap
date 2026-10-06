# Burgmap — prototype terrain Rust / WASM

Première étape du nouveau moteur : le terrain uniquement, dans un banc séparé
de l'application TypeScript. Le développement et les builds se font localement.
Aucune CI ni publication Rust n'est configurée pour cette étape.

## Lancer le prototype

Depuis `web/`, avec les dépendances npm déjà installées :

```powershell
npm run dev:terrain
```

Ouvrir **http://localhost:5173/terrainbench.html** (ou le port indiqué par Vite).
La commande compile Rust en WASM puis démarre Vite. Les changements `.rs` et
`Cargo.toml` recompilent automatiquement le WASM ; Vite recharge la page.
Les changements TypeScript/CSS utilisent le rechargement Vite habituel.

```powershell
# Recompiler seulement le WASM de développement
npm run wasm:terrain

# Compiler le WASM optimisé et produire une page autonome locale
npm run build:terrain

# Vérifications locales facultatives, sans tests
npm run check:terrain
```

Le build produit **`rust/out/browser/terrainbench.html`**, avec le WASM et le
worker incorporés. Cette sortie expérimentale reste hors de `web/dist/` et
des releases de l'application. `npm run dev` et `npm run build` habituels ne
compilent pas Rust. Le typecheck TypeScript fonctionne aussi sans `rust/pkg/`
grâce à la déclaration de la frontière WASM.

Les tests et les étapes suivantes du moteur sont reportés à la demande de
l'utilisateur. `check:terrain` exécute seulement rustfmt, Clippy et la
vérification de compilation pour `wasm32-unknown-unknown`.

## Contrôles

- Largeur du terrain carré : **500 à 100 000 mètres**.
- Taille du motif : **250 à 50 000 mètres**, par défaut **3 000 m**, indépendante
  de la largeur de la carte. Elle règle les dimensions des formes et leur détail.
- Graine : chaîne reproductible ; bouton pour tirer une nouvelle graine.
- Relief : **plaine, colline, vallée, canyon, montagne, plateau, haute montagne,
  volcan, caldeira ouverte, caverne**.
- Érosion : **0 à 100 %**. À 0 %, le relief initial est conservé ; la moitié
  supérieure du curseur renforce progressivement l'incision et l'usure. Ce réglage agit sur
  l'évolution du terrain, sans ajouter de rivières rendues à cette étape.
  La caverne ignore l'érosion, aussi bien pour le sol que pour ses parois.
- Générer et Autogénérer : la case active une génération après modification
  des paramètres, avec une courte temporisation pour les curseurs.
- Parchemin, Atlas et Topographique : changement de rendu du même terrain.
- Molette, glisser, zoom tactile, recentrer ; coordonnées sous la souris.
- Pins : Alt-clic ou mode de pose, notes, suppression, visibilité, copie du
  lien et du rapport. Le lien conserve le terrain affiché, les pins et la vue.

Les longueurs du bruit et les formes suivent la taille du motif, pas la carte.
Une vallée réglée à environ 3 km garde sa largeur sur une carte de 40 ou 100 km.
Le volcan et le plateau occupent une emprise physique limitée ; agrandir la
carte révèle leurs alentours. Les amplitudes suivent l'échelle du relief avec
des bornes physiques et ne grossissent pas avec la seule taille de la carte.
La caldeira ouverte est un type distinct : grand bassin bas et anneau effondré
avec une brèche. La graine fait varier le tracé et les pentes du canyon, et
la complexité, les niveaux et les reliefs résiduels du plateau.

Rust conserve un terrain préparé à une résolution physique liée au motif.
Le banc demande une vue d'ensemble puis des échantillons détaillés de la zone
visible quand on zoome ou déplace la carte. Il ne grossit pas seulement une
image couvrant les 100 km et ne relance pas l'érosion à chaque déplacement.
Les positions restent en mètres et le détail suit le même champ de terrain.
L'ombrage utilise des normales calculées avec un pas physique constant dans
Rust, plutôt que les différences de hauteur entre pixels de l'image affichée.
Le statut indique la taille des échantillons et les temps de calcul. Ces durées
ne sont pas une comparaison Rust/TypeScript ni une mesure complète des frames.

Pour ce prototype, les reliefs régionaux réemploient une source d'érosion
continue et déformée par le bruit mondial. Il ne s'agit pas encore d'une
simulation hydrologique intégrale d'un territoire de 100 km.

Le mélange de plusieurs reliefs, l'hydrologie, les villes et le futur moteur
de rendu restent des étapes ultérieures. La caverne fournit pour l'instant un
sol et un masque roche / ouvert, sans construction ni simulation souterraine.

## Organisation et frontière temporaire

```text
web/src/ui/terrainbench.*    interface du banc léger
web/src/ui/terrainWorker.ts worker Rust/WASM
rust/crates/core/           RNG, bruit, relief et érosion sans navigateur
rust/crates/wasm/           façade wasm-bindgen vers le cœur
rust/bridge/               chargement WASM et adaptation au rendu existant
rust/scripts/terrain.mjs   commandes locales de build et développement
rust/pkg/wasm/             module et binaire générés, ignorés par Git
rust/out/browser/          page autonome expérimentale, ignorée par Git
rust/crates/render/        réservé, technologie future non choisie
```

La façade expose un appel complet :

```ts
const engine = new TerrainEngine(seed, mapWidth, relief, erosion, motifSize);
const region = engine.sample_region(x, y, extent, resolution);
// getters : x, y, width (= extent), resolution, min_height, max_height,
//           height: Float32Array, cave_mask: Uint8Array,
//           normal_x, normal_y, normal_z: Float32Array
// region.free() après copie ; engine.free() au changement de terrain
```

Identifiants relief : `flat`, `hills`, `valley`, `canyon`, `mountains`,
`plateau`, `high-mountains`, `volcano`, `caldera`, `cavern`. L'API accepte des résolutions
entières entre 64 et 1024 pour les régions. Les entrées invalides
produisent une erreur explicite. Pas de substitution silencieuse par le
générateur TypeScript.

Coordonnées en mètres, origine en haut à gauche, y vers le bas ; altitudes
`Float32` échantillonnées au centre des cellules. `cave_mask` vaut 1 pour la
roche et 0 pour le sol ouvert ; le tableau est vide pour les terrains de
surface. Les buffers sont copiés par lot depuis WASM puis transférés du worker
à la page. Le navigateur utilise le même moteur Rust sur le thread principal
si la création du worker est refusée.

Le cœur porte le RNG sfc32, le bruit simplex et les principes d'érosion
stream-power / talus du terrain TypeScript de référence. Le port ne promet
pas une identité binaire de géométrie avec TypeScript. Le rendu utilise
temporairement les palettes et le rasterizer existants ; `World` n'est pas
le modèle du moteur Rust. Les liens du banc sont versionnés `engine=rust&v=2` ;
les anciens liens reçoivent une taille de motif de 3 000 m.

## Outils et chemins locaux

Toolchain épinglée dans `rust-toolchain.toml` : **Rust 1.99.0**, rustfmt,
Clippy, rust-analyzer et cible **wasm32-unknown-unknown**.
[wasm-pack 0.15.0](https://github.com/wasm-bindgen/wasm-pack/releases/tag/v0.15.0)
est installé localement. Les scripts recherchent aussi les exécutables dans
`%USERPROFILE%/.cargo/bin` si le terminal n'a pas encore récupéré le PATH.
Windows nécessite les Build Tools Visual Studio et le SDK Windows.

Le profil de développement optimise le calcul Rust (`opt-level=2`) tout en
conservant une compilation incrémentale. Le build utilise le profil release
(`opt-level=3`, LTO). wasm-opt est désactivé pour éviter une étape supplémentaire
dans ce prototype.

Sur cette machine, `D:` manque d'espace. Le cache Cargo est redirigé vers
`E:/CodexArtifacts/city-generator-rust-2026-10-06/target` par
`rust/.cargo/config.toml`, ignoré par Git. `rust/out/` est une jonction vers
le dossier `out` voisin sur `E:`. Sur une autre machine ces sorties utilisent
normalement `rust/target/` et `rust/out/`.

Voir aussi [le parcours d'intégration](docs/INTEGRATION.md) pour les étapes
futures et les décisions qui restent à concevoir avec l'utilisateur.
