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

- **Échantillonnage** compare CPU Rust et GPU FP32 (`compute=wasm|gpu-f32`).
  **Génération** compare la référence CPU (`generation=cpu`), les bruits fins GPU
  (`gpu`), tous les bruits GPU (`gpu-all`) et l'érosion GPU complète
  (`gpu-erosion`, par défaut). À graine, résolution et nombre d'itérations identiques, ce
  dernier mode déplace sur WebGPU les bruits, le drainage, l'accumulation,
  l'incision, le traitement des cuvettes, la relaxation thermique, la diffusion
  et la reconstruction/normalisation du champ de 1024². Seul le champ final
  revient à Rust pour préparer le terrain et ses mips ; le rendu reste inchangé.
  Le mode fin conserve les entrées CPU du drainage. Les champs préparés sont
  réutilisés lors des déplacements de caméra.
  Ces modes GPU sont actifs pour collines, montagnes, mixte, hautes montagnes,
  vallée, canyon, plateau, volcan et caldeira. Pour ces quatre derniers reliefs,
  les choix GPU utilisent la génération et l’érosion complètes ; les modes
  bruits seuls restent des comparaisons des reliefs régionaux. L'échantillonnage GPU couvre aussi la plaine. Les autres familles
  et les navigateurs sans WebGPU utilisent Rust avec un diagnostic explicite.
  Le FP16 a été retiré après les artefacts observés par l'utilisateur.
  L'érosion GPU est une variante à comparer visuellement avec la référence CPU :
  la propagation parallèle et les arrondis FP32 peuvent modifier les tracés. Les flats utilisent une distance pondérée par les creux du terrain et
  une priorité reproductible issue de la graine, pour éviter les longs canaux
  alignés sur les huit directions de la grille. Cette priorité n'ajoute aucune
  perturbation aux altitudes physiques.
  Si le drainage ne converge pas, le GPU réessaie avec davantage de passes ;
  une erreur persistante déclenche le repli CPU avec sa raison dans le diagnostic.
  Le rendu, les palettes, les normales et les courbes conservent leur méthode.

- Largeur du terrain carré : **500 à 100 000 mètres**.
- Taille du motif : **250 à 50 000 mètres**, par défaut **3 000 m**, indépendante
  de la largeur de la carte. Elle règle les dimensions des formes et leur détail.
- Graine : chaîne reproductible ; bouton pour tirer une nouvelle graine.
- Relief : **plaine, colline, vallée, montagne, collines et montagnes, plateau, haute montagne,
  volcan, caldeira ouverte, caverne**.
  Le canyon est de nouveau disponible : il naît d’une érosion massive sur un
  haut pays, avec des branches déterminées par les bassins versants.
- **Alentours**, pour plateau, volcan et caldeira : plaine, collines,
  collines et montagnes, montagnes ou hautes montagnes. Le choix est conservé
  dans le lien (`environment=`), avec le mélange collines/montagnes par défaut.
  La forme locale et ses tirages restent indépendants du choix des alentours.
  Sa position varie de façon reproductible avec la graine ; une marge garde
  son champ local dans la carte lorsqu’elle est plus grande que le motif.
- **Collines et montagnes** possède son propre curseur de proportion de montagnes,
  de 0 à 100 %. Le mélange forme des régions continues et reste inclus dans le lien (`mix=`).
- Érosion : **0 à 200 %**, par défaut **100 %** (dose normale). **200 %** double
  les coefficients de la simulation, sans promettre un doublement de la profondeur
  finale. À 0 %, aucune passe d’érosion n’est appliquée. Les liens existants
  conservent leur valeur numérique. La dose est linéaire, avec une réponse à la
  pente en mètres et une accumulation exprimée en surface physique rapportée
  au motif, puis plafonnée pour éviter les incisions démesurées. L’érosion de
  surface intervient après le détail fin des montagnes et utilise le même
  drainage D-infinity que les formes finies. La grille de cette passe passe
  de 640 à 1024 cellules selon le rapport carte/motif, avec une marge extrapolée.
  Les cuvettes peuvent recevoir des dépôts, sans creusement forcé de leur
  exutoire suivant une chaîne D8. Les flats et pentes montantes ne sont pas
  incisés sur la seule base du potentiel de drainage. Le canyon possède une
  incision spécifique des grandes rivières : son drainage traverse les cuvettes,
  l’accumulation sélectionne les axes majeurs et règle leur profondeur et largeur.
  Des profils de berges en distance euclidienne élargissent ces entailles, puis
  12 passes de surface érodent leurs parois. Aucun tracé analytique prédessiné.
  La caverne ignore toujours l’érosion.
- Générer et Autogénérer : la case active une génération après modification
  des paramètres, avec une courte temporisation pour les curseurs.
- Parchemin, Atlas et Topographique : changement de rendu du même terrain,
  avec un ombrage continu sans les anciennes hachures noires ni grain haute fréquence.
- **MNE · Copernicus** : altitudes du terrain généré en dégradé bleu foncé, vert,
  jaune, rouge, gris puis blanc, sans ombrage ni courbes. L'échelle globale
  reste fixe au zoom ; ce rendu n'importe pas de données Copernicus.
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
sans coupe à angle droit à l'entrée des affluents. Le canyon tire son réseau du relief et de l’accumulation du drainage. Le curseur
contrôle la dose qui le creuse ; à zéro, il reste un haut pays non incisé.
Les alentours des formes géologiques suivent le relief choisi dans **Alentours**.
Autour du plateau, leur taille de motif vaut 2,5 fois celle du plateau,
sur CPU comme sur GPU. Autour des vallées, volcans et caldeiras, ce facteur
vaut 2. La taille de la vallée et du cône reste indépendante. Le plateau
garde une emprise initiale fixe quand la dose change. Son contour combine trois
à sept lobes déformés, avec des baies concaves et parfois des mesas détachées.
Son dessus conserve les anciens paliers, lobes secondaires, buttes et petits
reliefs ridged, limités à cette nouvelle emprise. Le raccord utilise
ce même contour et cesse d’agir avant le bord du raster : aucune fondation carrée.
Le raccord du volcan et de la caldeira suit également leur contour volcanique,
avec un support circulaire qui s’annule avant les bords du champ local ; la
fondation ne relève plus les coins du raster. CPU et GPU partagent ce masque.
Le canyon est généré et érodé sur toute la carte, comme avant l’ajout du menu
Alentours ; il ne reçoit ni masque local, ni fondation, ni déplacement de forme.
Les anciens paramètres `environment=` sont ignorés pour ce relief.
La fondation est échantillonnée à la position réelle des trois formes finies.
Les alentours en plaine utilisent le calcul Rust existant ;
les autres alentours et l’érosion locale utilisent le GPU en mode GPU. Le
diagnostic de préparation distingue le temps de la plaine CPU du calcul GPU.
Les collines ont une amplitude relevée de 10 % ; leur seuil d’incision suit
leur propre pente caractéristique pour garder des ravines lisibles.
Les montagnes et hautes montagnes ont une charpente de crêtes ridged dans le
champ de soulèvement principal, avant l’érosion. Elle suit la taille du motif ;
les collines et le haut pays du canyon gardent des formes initiales plus douces.
Le raccord des formes finies utilise une union lissée sur 18 % de leur amplitude
et un fondu spatial à dérivées continues dans une large bande extérieure.
Les formes finies reposent sur une fondation filtrée de leur environnement,
qui élève le motif entier sans remplir sa dépression. Le bassin intact et
le sommet du plateau restent protégés par leurs masques géométriques ; la brèche
reçoit le raccord lissé aux alentours. Les irrégularités du cratère sont
cartésiennes, avec une lèvre arrondie et un fond doucement bruité.
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
const engine = new TerrainEngine(seed, mapWidth, relief, erosion, motifSize, mountainMix, environment);
// mountainMix : 0 à 1, facultatif (0.5 par défaut), utilisé pour relief="mixed".
// environment : "flat" | "hills" | "mixed" | "mountains" | "high-mountains",
// facultatif ("mixed" par défaut), utilisé pour plateau, volcan et caldeira.
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

[L'audit de performances](docs/PERFORMANCE_AUDIT.md) détaille le parcours de
calcul, les mesures par relief et les optimisations vérifiées en copies isolées,
avec leurs outils de reproduction. Les mesures initiales proviennent de copies
isolées ; la suite autorisée intègre désormais le sampler GPU et six
optimisations CPU exactes. Le FP16 est désactivé ; les bruits de génération disposent d'un chemin GPU FP32.
