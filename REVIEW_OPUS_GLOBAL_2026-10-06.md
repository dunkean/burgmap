# Revue indépendante : contours ouverts et tissu bâti, 2026-10-06

## Verdict

**J'accepte les deux propositions avec des modifications importantes.** Les mécanismes de lisière sont confirmés dans le code. En revanche, l'existence de **vrais chevauchements de propriété n'est pas prouvée**, et la refonte du « canevas canonique » proposée dans ANALYSE_MAISONS §2 n'est pas justifiée en l'état. On peut corriger de façon bornée sans refonte globale.

### Réfutation de la preuve de chevauchement

1. L'audit lit `offscreen.json`. Ce fichier est produit par `worldToJson`, qui **arrondit chaque nombre au centimètre** (`web/src/ui/exportWorld.ts:27`). Une jonction en T déplacée de ≤ 7 mm sur un mur de 7 à 20 m produit 0,03 à 0,08 m² de recouvrement. C'est exactement l'ordre de grandeur observé pour les bâtiments et les quartiers.
2. Le générateur tolère déjà, par conception, des coutures de l'ordre du centimètre :
   - grille de 1 cm (`geo/poly.ts:10-12`, `URBAN_GEOMETRY.md:17`) ;
   - grille booléenne de 1 mm, avec un repli à **5 cm** (`geo/bool.ts:63`, `:177`) ;
   - `polyInside` accepte 1 cm hors de la parcelle (`geo/split.ts:177-189`), donc deux maisons mitoyennes peuvent se recouvrir sur une bande de 2 cm ;
   - `trimOverlaps` ignore jusqu'à 0,02 m² (`buildings.ts:134`) ;
   - `checkWorld` ignore jusqu'à 0,05 m² (`tests/urbanCheck.ts:64-70`).
3. L'audit trouve 0 chevauchement de blocs. Les paires de parcelles sont toutes dans un même bloc, et les paires de quartiers se situent dans l'espace de rue (même couleur). Rien ne montre une propriété revendiquée par deux propriétaires distincts.
4. `backtracks()` dans `scratch/global-geometry-audit.ts` ignore les arêtes de moins de 1 cm. `malformed: []` ne prouve donc pas l'absence de sommets dupliqués. Le cas mage 261 (options par défaut) reste un vrai défaut.

### Causes confirmées

**Lisière**
- `splitQuarter` accepte une coupure dès qu'une seule extrémité est raccordée, sans pénaliser une extrémité `LAB_OPEN` (`blocks.ts:258-262`).
- `layerGround` ne restitue au paysage que les blocs (`landscapeGround.ts:40-55`). La rue et les résidus de bord (pointes tronquées, blocs < 40 m², marge de 3 cm, `blocks.ts:509-545`) restent peints en couleur de rue (`render/urban.ts:375`, `scene.ts:328`).
- Les rues principales sont retracées par-dessus les bâtiments (`urban.ts:461-469`).
- **Cause absente de la proposition CONTOURS :** le fondu de bord vide des parcelles entières près de la limite (`index.ts:709-710`, `:841-846`, `houses.ts:110`). La rue continue alors au-delà de la dernière maison.
- `pruneWays` compte les anneaux `footprintH` comme des raccordements (`rural.ts:767-770`, `fields.ts:92`).

**Villes secondaires**
- `clipUrban` filtre bâtiments et blocs par centroïde, mais **conserve tels quels `quarters`, `footprintH` et `phases`** (`settlements/urban.ts:161-173`). L'aplat de rue et la réserve rurale couvrent donc des zones dont les blocs ont été retirés. À mesurer.

**Maisons**
- Le repère de la parcelle n'est pas reconstruit après fusion (`plots.ts:451-456`, `:513-516`). `burgageHouse` découpe ensuite des bandes à partir de `sideA`/`sideB` périmés (`houses.ts:65-73`), et `carvePassage` utilise les mêmes côtés.
- `splitLong` conserve l'empreinte d'origine si un seul morceau échoue (`access.ts:384-386`).
- Seule l'OBB globale est contrôlée (`access.ts:392`) ; aucune largeur locale n'est vérifiée.
- `carvePassage` conserve les pièces brutes si le nettoyage n'est pas prouvé (`:296-299`).
- Aucune normalisation finale n'a lieu après `finishEdgeRoofs`/`repairResidentialDensity` (`index.ts:1097-1115`) ni dans `mega/detail.ts:410-425`.

**Contrainte de déterminisme**
- Le flux aléatoire `rng.fork('pl:' + pi)` est indexé par le numéro global de parcelle (`index.ts:830`). Tout changement du nombre de parcelles redistribue l'aléa de toute la ville.
- La génération rurale tourne après les secondaires eager, mais avant les secondaires lazy (`pipeline.ts:249-279`). Une secondaire lazy doit rester identique à son jumeau eager, donc **aucune classification urbaine ne peut dépendre de `landuse`**.

## Blockers des propositions

| # | Proposition | Problème bloquant | Modification |
|---|---|---|---|
| B1 | MAISONS | Elle affirme des chevauchements « réels » à partir d'un export arrondi. | Phase 0 obligatoire : audit en mémoire, classé par épaisseur. Pas de refonte de `primary.ts`/`mega/boundary.ts` avant preuve. |
| B2 | MAISONS §5 | Recherche multi-candidats : programme de recherche, coût non borné. | La remplacer par une reconstruction du repère, un test de largeur locale et une coupe au niveau de l'étranglement, avec résidu en cour. |
| B3 | CONTOURS §2 | Masque `edgeGround` bruité à deux échelles en phase 1 : inutile, car le sol résidentiel est déjà rejoué partout. | Cibler les queues de rue et les résidus de bord. Le bruit devient une phase 3 optionnelle, par parcelle entière. |
| B4 | CONTOURS | Il utilise `UrbanParcel.front` comme identifiant de rue. | `front` est un segment (`types.ts:187`) : il faut le projeter géométriquement sur l'axe. |
| B5 | Les deux | Aucun contrat pour lazy, secondaire ou clonage. | Interfaces ci-dessous, chacune calculée uniquement depuis sa propre couche. |
| B6 | CONTOURS | Il ignore le fondu de bord comme source de queues. | Règle de la « maison terminale » en phase 2. |

## Architecture cible

1. **Audit (`gen/urban/geometryAudit.ts`, pur).**
   - Chevauchements par relation : même parcelle, même bloc, même quartier, quartiers différents, **couches différentes** (principale/secondaire, hôte/détail).
   - Pour chaque paire : aire, **épaisseur** (diamètre inscrit de la pièce d'intersection), et l'état `failed`, qui n'est jamais compté comme zéro.
   - Anneaux défectueux : doublons < 1e-6, arêtes nulles, allers-retours, croisements.
   - Mesures d'empreinte : `minNeck` (largeur locale), rayon inscrit, angle minimal, `arch`/`ring`.
   - Classement : couture si épaisseur ≤ 0,02 m ; défaut si épaisseur > 0,05 m.
2. **Réseau ouvert (`gen/urban/openTails.ts`, pur, sans rng).** Classe les extrémités de rue et calcule les longueurs desservies. La donnée est stockée dans le World ; on ne tronque jamais `UrbanStreet.path`.
3. **Matériau.** `layerGround` ajoute les queues non desservies et les résidus de bord à la source du paysage. SVG et Canvas les reçoivent déjà par `currentLandscapeGround`/`LandscapeGroundCache`, d'où une parité automatique.
4. **Raccord rural.** Un seul validateur pur, `linkTail()`, sert à `rural.ts` (couches eager) et au rendu lazy (lecture de `landuse.ways`, immuable).
5. **Empreintes.**
   - Repères de parcelle reconstruits.
   - Test de largeur locale pour les typologies non cour ; contrôle de la profondeur de pièce pour les cours.
   - `finalizeFootprints` appelé **après la dernière mutation**, sur les chemins eager, détail et secondaire.

## Interfaces (premier commit de l'agent B, gelé)

```ts
// types.ts (additif, clonable)
export type StreetEndClass = 'regional' | 'junction' | 'served' | 'barrier' | 'unserved';
export interface UrbanStreetTail {
  street: number; end: 0 | 1; cls: StreetEndClass;
  tailLength: number;       // m, 0 = rien à requalifier
  tail: Polyline;           // axe non desservi, du point de coupe à l'extrémité
  ground: PolyH[];          // ruban de la queue ∩ espace de rue, moins les rubans desservis, places et routes
}
UrbanLayer.openTails?: UrbanStreetTail[];
UrbanLayer.openEdgeGround?: PolyH[];  // résidus de streetSpace touchant footprintH (< 0,1 m), hors rubans desservis
LandUseLayer.wayLinks?: { layer: number; street: number; end: 0 | 1; path: Polyline }[];

// openTails.ts
classifyStreetTails(u: UrbanLayer, roads: Road[], open: Polyline[], isBarrier: (p: Vec2) => boolean): UrbanStreetTail[];
servedStreetPath(u: UrbanLayer, i: number): Polyline; // chemin utilisé par toutes les surcharges de trait
linkTail(t: UrbanStreetTail, ways: Polyline[], obstacles: PolyH[], tol: number): Polyline | null;

// geometryAudit.ts / poly.ts
auditUrban(world: World): AuditReport;
minNeck(p: Polygon): { w: number; a: Vec2; b: Vec2 } | null; // null pour un triangle
finalizeFootprints(u: { buildings; parcels }): { changed: Set<number>; invalid: number[] };
```

**Règles de classification :**
- **barrier** : eau, mur ou pente forte dans les 6 m au-delà de l'extrémité.
- **regional** : extrémité sur `world.roads` à moins de la demi-largeur.
- **served** : rôle `close`/derb, ou dernière façade (projection du `front` d'une parcelle bâtie, entrée d'un site, ou bord d'une place) à moins de 4 m de l'extrémité.
- **unserved** : tous les autres cas ; la coupe se fait à la dernière façade + 2 m.

**Politique par implantation :** `none` pour stilts, graves, campements `openGround` et villes murées hors faubourgs ; ailleurs, on requalifie. Les murs physiques de caverne sont préservés.

## Phases

**Phase 0 — agent A, gate**
- Script `web/scripts/geometry_audit.ts` qui régénère en Node avec les options exactes.
- Vérifier que les comptes égalent 32/90/476/803. Sinon, ajouter `worldToJson(world, { exact: true })` (debug seulement, arrondi par défaut inchangé).
- Inventaire sur les fixtures listées plus bas, avec en plus les paires entre couches.
- Décision écrite : si toutes les paires ont une épaisseur ≤ 2 cm, l'hypothèse de chevauchement est close pour ces cartes. On demande alors à l'utilisateur des pins wizard pour l'entrée BUGS « frontières entre quartiers ».

**Phase 1 — en parallèle, sûre**
- **A1.** `finalizeFootprints` :
  - supprimer doublons et allers-retours seulement si |Δaire| < 1e-6 et que l'empreinte reste dans sa parcelle ; ne jamais supprimer de bâtiment ;
  - les cas invalides sont comptés dans `stats['footprint.invalid']` ;
  - masses recalculées pour les blocs modifiés.
- **A2.** Reconstruction de `front`, `nrm`, `sideA`/`sideB` (avec `sideA.p = front[0]` et `sideB.p = front[1]`) et `depth`, **uniquement sur les cellules `grown`/fusionnées** (`plots.ts:451-456`, `:513-516`). Le nombre de parcelles est inchangé, donc le flux rng l'est aussi.
- **A3.** Largeur locale :
  - logements non cour : `minNeck ≥ 0,8·MIN_BW` ; pièces `ring` : `≥ 0,8·rd` ;
  - triangle : accepté si diamètre inscrit ≥ 3,2 m et angle ≥ 20° ;
  - en cas d'échec, couper à l'étranglement et rendre le résidu à `plotGardens` ;
  - `splitLong` garde les morceaux valides si leur aire totale atteint au moins 70 % de l'original.
- **B1.** Types, `classifyStreetTails` aux points d'accroche (voir propriété des fichiers), puis `rural.ts` :
  - connecteurs = rubans de rues réelles + routes + accès de ferme, et plus les anneaux d'emprise ;
  - `wayLinks` validés : sec, hors parcelles, murs et autres emprises ; à défaut, rétrogradation en headland.
- **B1b, conditionnel au résultat de la phase 0.** `clipUrban` découpe `quarters`, `footprintH` et les rues par `tryIntersection` avec la région. En cas d'échec booléen, il garde la géométrie actuelle et signale l'échec ; les extrémités coupées sont classées.
- **C1.**
  - `layerGround` intègre `openTails[].ground` et `openEdgeGround` ; ajout de ces champs à la signature de cache (`landscapeGround.ts:110-114`) ;
  - SVG (`urban.ts:461-469`, `openGroundPathsSvg`) et Canvas (`scene.ts:413-425`, `canvas.ts:941-946`) utilisent `servedStreetPath` ;
  - trace en terre `tail + wayLink` lorsqu'un lien existe ; sinon la queue reprend le sol naturel ;
  - pour le lazy : `linkTail` est dérivé au rendu depuis `landuse.ways`.

**Phase 2 — change le World, attribution par fixture**
- **B2.** `splitQuarter` : coût +0,35 pour une coupure dont une extrémité est `LAB_OPEN` dans une ville ouverte. À conserver seulement si les queues non desservies baissent d'au moins 50 % sur F1, sans perte de logements de plus de 2 %.
- **B2b.** Règle de la maison terminale : `Plot.terminal` exempte du fondu de bord la dernière parcelle d'une rue ouverte.
  - `index.ts:842` : le tirage `pr.fork('openGap')` reste fait, seul son effet change.
  - `houses.ts:110` : l'appel `rng.chance` est conservé, on ajoute seulement `&& !pl.terminal`.
- **A4.** Garde sur la fusion du terrain arrière : refus si l'étranglement passe sous 3,6 m. Le terrain reste alors jardin, et la surface est comptée.

**Phase 3 — optionnelle (C).** `Noise2D` (`core/noise.ts`) en coordonnées monde fait basculer **des parcelles entières** admissibles entre `gardens` et `natural` dans `groundAppearance`. Aucune géométrie ne change.

## Propriété des fichiers (worktrees)

- **A (maisons)** : `geometryAudit.ts`, `scripts/geometry_audit.ts`, `geo/poly.ts`, `plots.ts`, `houses.ts`, `buildings.ts`, `access.ts`, plus les tests `urban.geometryAudit`, `urban.plotFrames`, `urban.footprintFinal`. A livre `finalizeFootprints` ; l'appel est inséré par B.
- **B (réseau)** : `types.ts`, `openTails.ts`, `index.ts` (deux points d'accroche : après `:1100` pour `finalizeFootprints`, à l'assemblage `:1193` pour les queues), `mega/detail.ts` (après `:421`), `settlements/urban.ts` (après `clipUrban`), `blocks.ts`, `rural.ts`, `fields.ts`, plus les tests `urban.openTails`, `landuse.wayLinks`.
- **C (rendu)** : `landscapeGround.ts`, `groundAppearance.ts`, `render/{urban,scene,sceneCache,canvas,svg,roadSurfaces}.ts`, plus le test `render.openTails` et la parité.

L'intégrateur fusionne B, puis A, puis C sur une révision figée.

## Fixtures

- **Lisière :**
  - `p4uefz` town european-organic, walls=none, settlements=none, suburbs=some, et suburbs=none en contrôle (crops existants) ;
  - `p4uefz` city ;
  - medina seed 4, walls=none ;
  - open42 (`seed=42&size=town&relief=hills&walls=none&settlements=none`) ;
  - un cas côte ou rivière ;
  - Sahel désert (`earthStreets`) ;
  - kraal 600 (politique `none`, inchangé) ;
  - une carte avec ≥ 1 secondaire d'une autre culture (à consigner) ;
  - la macro 60k, avec détail lazy dans deux ordres différents.
- **Maisons :**
  - wizard 4, options par défaut (261) et options natives ;
  - open42 et la fixture gelée `edge-roof-open42-finish` ;
  - medina 4, persian 4, russian-kremlin 42 pop 6000 (temps) ;
  - mix medina+bastide:0.45:phases seed 3 ;
  - japonais `p4uefz` (allers-retours hérités) ;
  - cas unitaires : triangle plausible **conservé à l'identique**, L à étranglement, parcelle fusionnée à repère périmé, anneau à doublons, aller-retour d'aire nulle, cour à pièces de 2,4 m, coordonnées vers 20 km.

## Critères de sortie

- **Audit :**
  - 0 `failed` non signalé ;
  - 0 nouvelle paire d'épaisseur > 2 cm, toutes relations et couches confondues ;
  - 0 doublon, aller-retour ou croisement dans les bâtiments finaux (principale, secondaire, détail).
- **Empreintes :**
  - 0 logement non cour avec étranglement < 3,6 m ;
  - pièces de cour ≥ 0,8·rd ;
  - logements ≥ 98 % de la base ;
  - `urban.densityhealth`, `density`, `access` et `culturequality` passent ;
  - surfaces rendues en cour/jardin comptées par cause.
- **Repères :** pour chaque parcelle, `front` est sur la rue (≥ 3,6 m), et `sideA`/`sideB` sont des arêtes du polygone (< 1 cm).
- **Réseau :**
  - longueur pavée non desservie visible = 0 m, hors `barrier`/`regional` documentés ;
  - aucune voie agricole raccordée par une simple emprise ;
  - chaque `wayLink` est sec et hors parcelle, mur ou autre emprise ;
  - `close`/derb et routes régionales sont conservés.
- **Rendu :**
  - parité SVG/Canvas au pixel sur les crops, DPR 1 et 2 ;
  - modes Worker, main, offscreen, `file://` et repli sans Worker ;
  - le hash du World ne change pas au rendu ;
  - aucun saut à l'arrivée du détail lazy ;
  - PNG avant/après inspectés.
- **Validation complète :** déterminisme (deux exécutions, deux ordres lazy), `typecheck`, `build`, suites ciblées (`urban.roadfringe`, `urban.openfringe`, `render.*ground*`, `render.countryside`, `mega.quality`, `urban.edgeRoofs`, `urban.densityRepair`). Les échecs hérités sont comparés à la base.

## Limites à documenter

- La phase 1 requalifie les queues, mais seule la phase 2 en réduit le nombre à la source.
- Les secondaires lazy n'ont pas de `wayLink` en génération : il est dérivé au rendu.
- Les coupures nettes dues à l'eau, aux falaises ou aux murs de caverne restent voulues.
- Les coutures de 1 à 2 cm sont conformes au contrat de géométrie (`URBAN_GEOMETRY.md:172`) ; on les classe, on ne les « corrige » pas.
