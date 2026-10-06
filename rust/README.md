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
- Relief : **plaine, colline, vallée, montagne, collines et montagnes, plateau, haute montagne,
  volcan, caldeira ouverte, caverne**.
  Le canyon est retiré des choix du banc ; les anciens liens `relief=canyon`
  ouvrent une plaine. Son implémentation reste interne au moteur.
- **Collines et montagnes** possède son propre curseur de proportion de montagnes,
  de 0 à 100 %. Le mélange forme des régions continues et reste inclus dans le lien (`mix=`).
- Érosion : **0 à 100 %**. À 0 %, le relief initial est conservé ; la dose augmente
  progressivement avec le carré du curseur pour les montagnes. La plaine utilise
  une dose à la puissance quatre, plus douce au départ, avec une échelle de rendu
  indépendante de la dose. Les volcans et caldeiras utilisent une érosion dédiée
  à dose normale sur 12 passes, avec une grille fine pour les ravines des parois.
  L'amplification et les 24 passes du canyon interne ne leur sont plus appliquées.
  Le passage de 0 à 1 % ne déclenche plus une incision complète des cuvettes. Ce réglage agit sur
  l'évolution du terrain, sans ajouter de rivières rendues à cette étape.
  La caverne ignore l'érosion, aussi bien pour le sol que pour ses parois.
- Générer et Autogénérer : la case active une génération après modification
  des paramètres, avec une courte temporisation pour les curseurs.
- Parchemin, Atlas et Topographique : changement de rendu du même terrain,
  avec un ombrage continu sans les anciennes hachures noires ni grain haute fréquence.
- Molette, glisser, zoom tactile, recentrer ; coordonnées sous la souris.
- Pins : Alt-clic ou mode de pose, notes, suppression, visibilité, copie du
  lien et du rapport. Le lien conserve le terrain affiché, les pins et la vue.

Les longueurs du bruit et les formes suivent la taille du motif, pas la carte.
Une vallée réglée à environ 3 km garde sa largeur sur une carte de 40 ou 100 km.
Le volcan et le plateau occupent une emprise physique limitée ; agrandir la
carte révèle leurs alentours. Les amplitudes suivent l'échelle du relief avec
des bornes physiques et ne grossissent pas avec la seule taille de la carte.
Les vallées suivent un tronc courbe à plusieurs échelles, avec des affluents
raccordés aux deux versants. Leurs confluences sont fusionnées progressivement,
sans coupe à angle droit à l'entrée des affluents. Le canyon possède un réseau
distinct de lacets et retours en arrière, des affluents et leurs branches,
des corniches irrégulières et des chaos rocheux. Son tracé ne dépend pas du
curseur d'érosion, qui use et creuse ses véritables parois. Les alentours mêlent collines et
montagnes, comme autour du plateau, du volcan et de la caldeira. La haute montagne
varie aussi entre massifs élevés et régions plus basses, avec des vallées érodées.
Le plateau a un sommet plus calme et un contour moins bruité. Les parois et les
bords volcaniques ont des irrégularités légères. Le raccord du plateau, du volcan
et de la caldeira prend le maximum de leur hauteur et des montagnes environnantes.
Le dessus du plateau et les parties intactes des cratères conservent leur
propre hauteur, avec des masques tirés de la même géométrie que leur relief.
La partie effondrée de la caldeira reçoit aussi le maximum avec les montagnes
environnantes, pour éviter une ouverture plate. Les cratères ont une lèvre arrondie
et un léger bruit géographique continu ; les variations angulaires qui dessinaient
des traits en étoile sont supprimées.
La caldeira ouverte reste un type distinct avec un bassin bas et un anneau
effondré muni d'une brèche.

Rust conserve un terrain régional préparé dans les coordonnées réelles de la carte.
Les formes isolées sont préparées séparément à l'échelle du motif.
Le banc demande une vue d'ensemble puis des échantillons détaillés de la zone
visible quand on zoome ou déplace la carte. Il ne grossit pas seulement une
image couvrant les 100 km et ne relance pas l'érosion à chaque déplacement.
Les positions restent en mètres et le détail suit le même champ de terrain.
Les octaves trop fines pour la vue sont atténuées progressivement, sans
renormaliser les basses fréquences. Une pyramide filtrée applique le même
principe aux reliefs préparés et aux corrections d’érosion. L’ombrage et les
courbes utilisent cette même surface filtrée ; les normales sont calculées
avec un pas adapté à la résolution physique demandée. Le détail revient au
zoom, avec des coordonnées de terrain fixes et sans relancer l’érosion. Il révèle
le relief déjà préparé ; aucun bruit haute fréquence ni octave supplémentaire
n'est ajouté au zoom. Le détail précédent reste affiché jusqu'au décodage et au
chargement de la nouvelle image, puis un court fondu accompagne son remplacement.
Le statut indique la taille des échantillons et les temps de calcul. Ces durées
ne sont pas une comparaison Rust/TypeScript ni une mesure complète des frames.

Les reliefs régionaux ne projettent plus un petit terrain érodé au travers d'un
champ de bruit : cette projection déformait les vallées de drainage. L'érosion
est préparée sur la région complète, puis échantillonnée directement. Le raster
régional de 1024² borne la finesse de ces vallées sur les grandes cartes ; le zoom
retrouve les formes analytiques et le détail de surface, mais ne relance pas une
simulation hydraulique locale. Cela reste un prototype de relief, sans hydrologie
intégrale ni réseau de rivières.

Les autres mélanges de reliefs, l'hydrologie, les villes et le futur moteur
de rendu restent des étapes ultérieures. La caverne fournit un sol et un masque
roche / ouvert, sans construction ni simulation souterraine. La pierre descend
continûment vers les ouvertures ; ses normales incluent cette pente. Le banc
affiche une roche noire ombrée, sans hachures ni courbes d'altitude en caverne.

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
const engine = new TerrainEngine(seed, mapWidth, relief, erosion, motifSize, mountainMix);
// mountainMix : 0 à 1, facultatif (0.5 par défaut), utilisé pour relief="mixed".
const region = engine.sample_region(x, y, extent, resolution);
// getters : x, y, width (= extent), resolution, min_height, max_height,
//           height: Float32Array, cave_mask: Uint8Array,
//           normal_x, normal_y, normal_z: Float32Array
// region.free() après copie ; engine.free() au changement de terrain
```

Identifiants relief : `flat`, `hills`, `valley`, `canyon`, `mountains`,
`mixed`, `plateau`, `high-mountains`, `volcano`, `caldera`, `cavern`. L'API accepte des résolutions
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
