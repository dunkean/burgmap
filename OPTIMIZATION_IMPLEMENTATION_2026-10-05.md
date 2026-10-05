# Optimisation des toits et du rendu — 2026-10-05

Les changements sont intégrés au checkpoint `12d8c225`. Le World complet de
la capitale de 60 000 habitants est exactement identique à la référence, hors
`stats` : 103 quartiers et 42 802 bâtiments détaillés. Les optimisations ne
modifient ni les partitions, ni les propositions acceptées, ni les exports SVG
dans les cas comparés.

La référence `0da0a9d` a été protégée par le tag annoté
`pre-optimization-2026-10-05`, poussé avant les changements. Sa publication de
contrôle sur `gh-pages` est `fa161ee`; le HTML servi était identique au build
local, SHA256 `a8684d5f37d8d7af9cdf697195bf2498f3307ed648fac8acee46e41f5825bfa9`.

## Toits : éviter les preuves coûteuses inutiles

`finishEdgeRoofs` conserve ses booléens vérifiés et ses transactions atomiques
sur les propriétaires, blocs, quartiers, phases et accès. Les vérifications de
collision passent avant les différences polygonales coûteuses. Les intersections
des obstacles sont préparées sur des snapshots; les preuves globales répétées
pour un même rectangle utilisent un cache local borné à 4 096 entrées, détruit à
la fin de la recherche. Les preuves spécifiques au propriétaire/donneur restent
hors de ce cache.

Les tailles sont examinées progressivement par surface décroissante. Les bandes
numériques qui se chevauchent restent ensemble, avec le tri stable original,
afin de conserver l'ordre des candidats. Les domaines convexes ne servent qu'à
rejeter des propositions impossibles : ils ne remplacent aucune preuve finale.
Les bâtiments d'une parcelle sont indexés sans changer leur ordre.

Mesures Node sérialisées, mêmes entrées, temps hors hashing/sérialisation :

| Cas | Référence | Optimisé | Accélération |
| --- | ---: | ---: | ---: |
| Quartier 58 de la fixture navigateur, essai 1 | 9,333 s | 2,275 s | ×4,10 |
| Même quartier, essai 2 | 9,394 s | 2,221 s | ×4,23 |
| Quartier 95 | 3,798 s | 2,339 s | ×1,62 |
| Quartier 52 | 3,512 s | 0,971 s | ×3,62 |
| Quartier 57 | 2,868 s | 1,936 s | ×1,48 |
| Quartier 51 | 3,035 s | 1,690 s | ×1,80 |
| Quartier 75 | 1,229 s | 1,018 s | ×1,21 |
| Génération complète `seed=4&size=city` | 52,190–53,712 s, 2 essais | 31,415 s, 1 essai | ×1,66–1,71 |

Tous ces hashes et nombres de bâtiments sont identiques. City conserve 6 113
bâtiments et le hash hors stats
`f52543de1e3bd1303debff2c543dab6d13e0cfdd72c93eedf3d765a1019ead89`.
Les gains sont propres aux cas mesurés; ils ne constituent pas un facteur garanti
pour toutes les seeds/cultures.

## Rendu : conserver scènes, terrain et pixels

`SceneBuilder` conserve les parties statiques et les quartiers inchangés,
prépare le sol par propriétaire et retient le World fusionné pour éviter de
regénérer les stand-ins. Les identités de chemins suivent les contributeurs
géométriques plutôt que les positions dans des tableaux aplatis. Les changements
de génération, de terrain, de propriétaire et les suppressions sont traités
explicitement. Le renderer du worker est conservé entre les lots.

Le Canvas interactif calcule le relief RGB sans encoder un PNG qui serait aussitôt
ignoré. Les exports gardent leur encodage PNG. Les clips de sol n'utilisent que
les candidats visibles. Un cache LRU de vraies tuiles raster, limité à 64 MiB de
pixels retenus, réutilise le dessin à zoom/DPR constants; les textes et panneaux
sont redessinés séparément. Les bornes d'invalidation incluent les anciennes et
nouvelles géométries et leur rayon de peinture. L'échec d'allocation ou un
viewport dépassant le budget utilise le chemin vectoriel. Ce budget ne limite
pas la mémoire totale des Worlds, chemins ou workers.

Le backend bitmap conserve le remplacement atomique de l'image et les contrôles
génération/version/vue. Le transfert direct d'un Canvas et un prototype WebGL2
à texture de viewport retenue ont été testés dans le harnais, sans être ajoutés
au backend de production. Ils n'amélioraient pas le rendu froid et apportaient
peu une fois les tuiles en cache. Ce prototype ne couvre pas un moteur GPU de
géométrie ni les mises à jour complètes des labels/quartiers.

## Mesures de l'application complète

Query : `seed=1&size=capital&culture=european-organic&population=60000`.
Chromium 153.0.8010.12, viewport 1400 × 900, DPR 1. Temps depuis navigation
jusqu'à présentation acceptée suivie de deux RAF : proxy de paint, pas mesure de
scanout physique. L'image complète exige les 103 résultats et leur présentation.
Les builds, exports de fixtures et captures sont hors des fenêtres chronométrées.

| Configuration | Première image | Image complète | Essais |
| --- | ---: | ---: | ---: |
| Référence, 2 workers | 7,670 s | 48,169 s | 1 |
| Optimisé, 2 workers | 7,169 s | 26,334 s | 1 |
| Optimisé, 4 workers, médiane | 6,997 s | 20,017 s | 3 |
| Optimisé, 6 workers | 7,318 s | 18,351 s | 1 |
| Optimisé, 8 workers | 7,341 s | 17,588 s | 1 |
| Optimisé, 4 workers, DPR 2 | 7,664 s | 22,980 s | 1 |

Les trois images complètes à quatre workers sont comprises entre 19,992 et
20,030 s. Le défaut est 1/2/4 workers selon CPU et mémoire déclarée; huit restent
possibles pour les appels explicites et diagnostics. Quatre constituent ici un
compromis : six/huit gagnent encore 1,7/2,4 s mais augmentent les copies et heaps.

À deux workers, le temps cumulé de préparation des scènes passe de 19,933 à
3,648 s. Les pans à zoom constant, après création des tuiles, passent de
1,76–2,00 s à 46–98 ms. Les trois essais à quatre workers confirment cette plage.
Le premier passage à un nouveau zoom prend encore environ 2,38 s : c'est un
coût froid explicite, parfois supérieur au chemin vectoriel. Au DPR 2, les pans
chauds observés prennent 79–126 ms.

Autres vérifications natives : capitale par défaut complète en 17,645 s,
ville ouverte de 20 000 habitants sur 10 km en 27,393 s, sans erreur de page.
Ces deux cas n'ont pas de baseline navigateur fraîche correspondante.

Les informations GPU CDP indiquent **ANGLE SwiftShader logiciel**. Aucun gain sur
carte graphique matérielle n'est revendiqué. Les conclusions sur le chargement
et les interactions s'appliquent à cette configuration mesurée.

## Fidélité et validation

Les scènes vectorielles anciennes, reconstruites et incrémentales donnent
exactement les mêmes pixels dans 36 vues : parchment/night/engraving, zooms
0,6/1,5, trois pans dont un fractionnaire, DPR 1/2. Les tuiles raster ajoutent
une interpolation et adoucissent les traits/hachures; leurs pixels ne sont donc
pas identiques. Les captures inspectées ne montrent ni jointure ni trou. Cette
différence est plus visible sur les hachures fines à zoom 0,6. SVG reste vectoriel.

Le World complet sauvegardé dans le navigateur, avant/après, a le même SHA256
canonique hors stats :
`432a775a6ae2e48c9a2080762644bd189fd8dd484f13e8f9f8cc88753c986074`.
Les revues de source ont précédé les exécutions; la revue finale d'intégration
porte sur `12d8c225`. Les branches des toits et du rendu passent respectivement
49 et 87 tests ciblés; la politique de pool passe ses 18 tests. Typecheck et
build intégré réussissent.

Les exports natifs SVG et JSON sont identiques entre offscreen HTTP, main HTTP,
file:// et refus du constructeur Worker; les quatre PNG de 3 000 pixels sont
valides. Les styles changent effectivement les pixels sans regénérer le World;
les vues attendent leur présentation et les deux demandes de génération
terminent sur la dernière génération. Depuis file://, ce navigateur utilise
le fallback main et ne fait aucune requête HTTP(S) depuis la page. Les captures
natives ont été inspectées.

Le harnais accepte aussi une query non-macro et vérifie les bytes du véritable
document HTTP chargé. Le contrôle supplémentaire
`seed=7&size=village&culture=sahel&biome=desert&legend=1&style=parchment`
passe les quatre modes avec 504 bâtiments, les mêmes exports SVG/JSON, des PNG
valides et un basculement réel parchment → night. Ses images sont la référence
native avant les corrections visuelles de `BUGS.md`, qui sont développées
séparément de ce checkpoint d'optimisation.

Le premier harnais attendait uniquement offscreen en file://; cette assertion
a été corrigée pour accepter le fallback prévu. Les premiers résultats sont
conservés séparément. Il n'y a eu aucun changement de production pour ce remède.

La suite exhaustive est **incomplète** : arrêt après 133 minutes, 56 fichiers
rapportés sur 88 et 40 échecs d'assertion. Ces 40 cas ont été rejoués sur
`pre-optimization-2026-10-05` avec les mêmes tests et assertions : leurs titres
et valeurs d'échec correspondent. Le footer et le JSON final de cette exécution
n'existent pas ; une égalité exhaustive de leurs messages/stacks n'est donc pas
certifiée. Les défauts ou attentes historiques restent visibles, sans remplacer
les assertions.

Les deux workers immobilisés exécutent la même génération japonaise `p4uefz`,
dans `urban.footprint.test.ts` et `urban.roji.test.ts`. Les profils et les piles
localisent une boucle de recherche de voisin consommé dans polygon-clipping.
La capture complète des arguments de `differenceS` est identique dans les deux
workers (20 sommets, 13 operands). Cet appel gelé ne termine pas non plus dans
les replays supervisés de la baseline et du checkpoint actuel, chacun arrêté
à 10 secondes. Cela attribue le blocage de **cet appel** au noyau existant ; ce
n'est pas un résultat complet de génération sur la baseline. Le diagnostic ne
sert à aucune mesure de performance.

Les 30 fichiers non rapportés sont exécutés séparément dans un checkout figé
de `ee202a3`. Les preuves restent dans `full-suite-interruption.json`,
`remaining-suite.*`, `stalled-input-baseline-attribution.json` et
`baseline-attribution/`. Cette publication n'est pas un certificat de suite
complète verte. La correction du noyau et le travail de `BUGS.md` sont isolés
du checkpoint d'optimisation, avec leurs propres revues et validations.

## Reproduction et preuves

- [Harnais navigateur](web/scripts/optimization_display.mjs) : chargement réel,
  première/image complète, vues chaudes, GPU CDP et export World après les mesures.
- [Harnais des toits](web/scripts/roof_benchmark.ts) : entrées gelées, hashes
  sources et sorties, comparaison de quartiers et City.
- [Probe des backends](web/scripts/render_backend_probe.mjs) : vraie ancienne
  source indépendante, parité pixel, transports bitmap/direct et prototype GPU.
  Ses dessins ordonnés partagent des caches : ses temps froids sont diagnostiques.
- [Vérification native](web/scripts/optimization_verify.mjs) : exports SVG/JSON/PNG,
  vues présentées, changement de style, supersession de générations et file://.
- Rapports JSON, Worlds, PNG, manifeste des sources et preuves de publication :
  `web/out/optimization-implementation-2026-10-05/`, ignoré par Git et situé sur E.

Exemple depuis `web/` :

```powershell
node scripts/optimization_display.mjs --workers 4 --samples 3 --case 60k --save-world --out out/optimization/display
node scripts/optimization_verify.mjs --html dist/index.html --out out/optimization/native
node scripts/optimization_verify.mjs --html dist/index.html --url https://dunkean.github.io/burgmap/ --out out/optimization/published
npm run typecheck
npm run build
npm test
```

Le mode `--url` vérifie d'abord que le HTML distant est identique au build local,
puis teste trois modes sur la publication (offscreen, main, refus des Workers)
et le contrôle offline local.

Le feedback utilisateur sur les jardins/biomes et les frontières dans `BUGS.md`
reste ouvert et son texte local est préservé. Les deux scripts de reproduction
utilisateur sont inchangés.
