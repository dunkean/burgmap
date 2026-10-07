# Hydrologie : drainage et tracés physiques

Le prototype produit un réseau permanent et des lacs à partir du relief préparé.
Les coordonnées, largeurs et niveaux sont en mètres. Le drainage initial peut
être calculé sur WebGPU ; le conditionnement final et la géométrie sont calculés
par Rust, nativement ou dans le worker WASM. Les réglages hydriques réutilisent
le terrain ; déplacer la caméra ne relance pas le réseau.

## Pourquoi le précédent audit ne suffisait pas

Le rang entier fondé sur deux distances en nombre de voisins supprimait les
cycles, mais gardait les symétries de la grille D8 : de longues diagonales
pouvaient être parfaitement droites et plusieurs chenaux rester parallèles.
Les événements de méandre espacés ajoutaient ensuite des courbes isolées.
Leur dosage dépendait notamment du pas de grille. Une fréquence élevée,
combinée à une amplitude faible et à une limite de rayon, pouvait presque
annuler les courbes dans une plaine pourtant ouverte.

La correction sépare deux problèmes : choisir un drainage convergent puis
construire une géométrie compatible avec ce drainage et le relief physique.

## Un drainage final commun

Le drainage D8 initial peut relier deux cellules basses en diagonale alors que
leurs voisins cardinaux créent un col bilinéaire plus haut que l'eau et le budget
de coupe. Une vérification des diagonales précède donc le routage final. Si elle
trouve un raccord impossible, un flood cardinal donne une borne supérieure F4 ;
un second flood à huit voisins minimise les niveaux avec des coûts de passage
tenant compte des deux coins F4 et du budget minimal de berges. Ce budget reste
celui de l'incision configurée, avec une petite réserve pour les arrondis.
Le résultat reste sous F4, y compris lorsque les mares rejetées sont ensuite
comblées sur la surface dérivée. Les choix de pentes, parcours plats, captures
et connexions de lacs filtrent aussi les diagonales incompatibles. La surface
de débordement finale peut ainsi monter au-dessus du F brut qui ignorait un col ;
aucun bruit n'est ajouté aux altitudes et les diagnostics GPU restent intacts.
La recomputation est évitée lorsque les raccords initiaux sont déjà admissibles.

`hydrology_flats.rs` identifie les composantes exactement plates de la surface
de débordement F. Les pentes choisissent un voisin réellement descendant ; les
plats rejoignent leurs sorties par un Dijkstra à coûts strictement positifs,
symétriques, avec des distances de 1 pour les voisins cardinaux et √2 pour les
diagonales. Les creux du terrain
enterré, filtrés sur un voisinage court, abaissent le coût sans modifier H ou F.
Les égalités sont résolues de façon déterministe, sans bruit d'altitude.

Dans les grandes cuvettes comblées (au moins 128 cellules et 0,4 m de profondeur),
une accumulation provisoire mesure aussi les apports réels des versants. Une
seule seconde passe réduit les coûts près des corridors les plus alimentés.
Son influence reste dans la composante et est bornée par six propagations
locales. C'est une consolidation heuristique bornée, pas une optimisation
globale ni une simulation temporelle de l'érosion fluviale.

Les versants disposent aussi d'une capture locale. Les corridors alimentés par
au moins 50 000 m² attirent les écoulements voisins ; leur influence sature à
400 000 m² et se propage sur environ 80 m (2 à 16 cellules selon la résolution).
Les cellules hors de ce voisinage gardent leur pente initiale. Les autres
choisissent un parcours descendant, pénalisé lorsqu'il s'écarte de la pente
maximale. Les candidats ordinaires conservent au moins 25 % de cette pente ;
un secours planaire peut relâcher ce critère. La longueur reste limitée à 1,35
fois le parcours initial plus le voisinage de capture. Les plats transportant de l'eau,
leurs sorties et les limites restent fixes. Les diagonales sont protégées avant
chaque changement. Cette passe modifie les récepteurs, puis recalcule les apports ;
elle ne se contente pas de masquer les ruisseaux parallèles.

Lorsqu'un cours principal reçoit un apport extérieur, son parcours est choisi
une seule fois et conservé. Après l'agrégation des lacs, une capture locale
supplémentaire tient compte de sa largeur réelle ; elle peut raccorder les
affluents avant qu'ils ne longent ses berges. Dans le voisinage des berges,
deux balayages favorisent le premier raccord descendant accessible au lit,
avec une distance de raccord bornée par ce voisinage. Elle garde les contraintes de
descente, de longueur et de planéité. L'accumulation naturelle et les bassins
sont reconstruits après ces changements ; l'apport extérieur est ajouté une
seule fois lors de l'extraction du réseau.

L'ordre de finalisation de Dijkstra fournit `flat_rank`, strictement descendant
le long des récepteurs d'un plat avant l'agrégation des lacs. Les lacs retenus
sont agrégés vers un seul exutoire. Leur parcours métrique évite les diagonales
qui croiseraient un chenal sec existant. Un contact diagonal isolé peut réorienter
localement ce chenal vers la partie du lac déjà reliée à l'exutoire, uniquement
si la cote et l'absence de cycle le permettent. Une configuration imposant
simultanément une diagonale bloquée et un exutoire immuable peut rester
impossible ; elle doit être signalée plutôt que créer silencieusement un cycle.

L'accumulation définitive, les bassins et les vecteurs utilisent les mêmes
récepteurs. L'apport extérieur éventuel est inclus dans les surfaces drainées.
Les diagnostics bruts du drainage initial restent séparés et intacts. Le réseau
représente un écoulement à une seule branche aval par nœud ; les chenaux tressés,
distributaires et deltas ne sont pas modélisés.

## Apparition des cours visibles

L'ancien seuil proportionnel à la surface de la carte faisait apparaître un
ruisseau dès 9 079 m² sur le cas de 3,5 km `1ryr6kq`, contre environ 667 000 m²
sur une carte de 30 km avec les mêmes réglages. Il est remplacé par une surface
physique d'initiation : 1 800 000 m² / (densité^1,5 × alimentation), divisée par
(1 + pente / 0,02)^0,35. Le minimum est 300 000 m² / (densité × alimentation),
avec un plancher de 24 cellules pour la précision du raster. Ces coefficients
calibrent le réseau permanent du prototype ; ils ne sont pas une loi universelle
d'apparition des torrents. Une fois initié, un cours reste connecté jusqu'à son
aval, même lorsque la pente diminue. Le cours extérieur et les sorties de lacs
restent explicites. Aucun nombre fixe de ruisseaux n'est imposé à la carte.

## Des courbes à l'échelle du cours

Les branches dominantes sont réunies avant de construire leurs courbes, puis
redécoupées aux nœuds. La phase continue traverse les confluences. La longueur
d'onde est proportionnelle à la largeur du cours. Un champ seedé C2 combine
trois bandes de B-splines cubiques à valeurs aléatoires, avec une activité et une
échelle variant continûment. Il ne force plus une alternance sinusoïdale de
boucles régulières sur les guides droits des petits torrents. Les nœuds restent exactement
communs ; une correction locale à support compact annule leur déplacement.

La pente du profil d'eau et les berges de la surface physique limitent la
mobilité. Le terrain enterré d'une cuvette comblée guide le drainage sans
constituer une fausse paroi contre les courbes. Le rayon limite les boucles
serrées ; une contrainte de relief, de lac, de mer ou de voisinage atténue
localement la déformation. Les profils d'eau restent descendants, avec des
niveaux identiques aux nœuds partagés. Le profil est ajusté depuis l'aval :
il anticipe les cols du terrain bilinéaire au lieu de descendre trop tôt puis
de traverser une crête. Les altitudes des nœuds restent fixes. Une subdivision
locale conserve les points nécessaires lorsque le profil linéaire dépasse le
budget de coupe du lit. Ce contrôle analytique est répété après la compaction
et les réparations, sur les segments effectivement exportés.
Le plafond supplémentaire d'amplitude fondé sur la seule pente a été retiré :
sur le cas utilisateur de 3,5 km, il neutralisait déjà l'intensité 1 et 2.
La mobilité, le rayon, les berges et les contraintes de voisinage continuent
de limiter les déplacements réellement admissibles.
La tolérance d'un déplacement tient compte de la profondeur et du plafond de
coupe du lit réellement appliqués par l'incision. Les contrôles préalables et
finaux utilisent le même profil descendant. Une spline trop ambitieuse réduit
ses tangentes communes localement avant de reprendre ses points détaillés.

L'échantillonnage des courbes et des profils est adaptatif. Les contraintes
s'appliquent à des portions entières de spline ; une portion invalide garde
ses points détaillés plutôt que des sommets alternativement déplacés et remis
sur la grille. Un index de segments valide les axes et les largeurs des voisins pendant la
construction ; le contrôle final complète l'occupation raster, qui ne suffit
pas à distinguer des axes voisins dans une même cellule. Il permet seulement
les extrémités communes du graphe, pas une intersection suivie d'une seconde
jonction. Une berme de 1 à 3 m est préférée pendant la construction ; le contrôle
final exige une séparation physique hors raccord. Une vraie confluence comporte
un contact des berges avant la rencontre des axes : son autorisation suit
l'approche terminale continue des courbes effectivement produites. La première
séparation ferme cette autorisation, même si un autre contact reste proche. Un
contact isolé suivi d'une séparation reste interdit. Les tronçons d'un même
cours n'autorisent que les contacts locaux, dans trois largeurs curvilignes ;
une boucle distante ne bénéficie pas de cette autorisation. Les parties d'un
même lac appartiennent à une eau commune. La continuité d'une rivière est aussi
reconnue à travers ses connecteurs orientés de lac d'une cellule, et l'approche
d'une vraie confluence reste valide lorsque le cours rejoint est subdivisé.
Le compacteur reconstruit ses voisins après les réparations et contrôle la
géométrie réellement exportée. Un croisement ou contact non résolu produit une erreur
diagnostique. Chaque réparation locale est aussi contrôlée contre le terrain
bilinéaire, les lacs et la mer ; revenir vers le guide ne dispense pas de
vérifier les transitions du raccord. Chaque arrivée en mer possède son propre terminal côtier :
partager une cellule marine ne force pas deux embouchures à partager un point
de côte.

Une composante sous le niveau marin reliée au bord doit contenir au moins un
bloc de quatre échantillons voisins (2×2) pour être une surface marine résolue.
Un chenal étroit connecté à cette mer reste marin ; quelques cellules négatives
isolées sur un autre bord ne créent plus un océan ni un estuaire. Ce même
critère prépare le masque GPU et le masque CPU sans modifier les altitudes.
Le cas `1ds1473`, carte de 3,5 km, sort ainsi au sud avec un chenal d'environ
81 m plutôt qu'un élargissement tidal de 210 m déclenché par trois cellules.

## Portée et performance

La grille hydrique 256²/512²/1024² borne la précision du relief disponible.
Le zoom échantillonne le lit à partir des vecteurs conservés et ne peut découvrir
une contrainte topographique absente de cette grille.

Le GPU prépare actuellement drainage et accumulation initiaux. Le routage
métrique final reste CPU/WASM : ses coûts locaux et sa consolidation pourraient
alimenter un solveur GPU, mais cette version ne prétend pas disposer d'un
routage final GPU équivalent. Les temps affichés séparent drainage préparé,
finalisation hydrique et préparation de scène ; le coût du terrain et du rendu
ne doit pas être attribué au seul réseau.

Les courbes sont un modèle procédural contraint, pas une simulation de migration
des berges, débit variable, sédiments ou hydraulique des rapides. Les relations
entre dimensions du chenal et dimensions des méandres motivent l'échelle
physique ; les coefficients du prototype restent des choix de génération.
Voir [Williams, USGS, 1986](https://pubs.usgs.gov/publication/70015687) et les
[observations sur géométrie et migration, Nature Communications, 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC10912106/).

Les entrées GPU des graines `1c9fqdw` (plaine), `1ijwjgy` (collines, cas utilisateur)
et `48702y` (montagnes et côtes) sont conservées dans `rust/out/` pour les
comparaisons locales. Les sondes ciblées vérifient drainage, connexions,
conservation des apports et croisements ; elles ne démontrent pas à elles seules
la qualité visuelle. Les captures Playwright servent à examiner les plaines,
les confluences et les versants/canyons. Aucun nouveau framework de tests n'est
nécessaire à cette étape.

## Vérification locale du 7 octobre 2026

Les onze cas à entrées GPU conservées sont rejoués à l'identique dans le WASM optimisé, quatre
fois chacune. Les contrôles portent sur les récepteurs, le rang des plats,
les croisements D8 et vectoriels, les nœuds XY et leurs niveaux d'eau, les profils
descendants, la conservation des apports et les diagnostics bruts inchangés.
Tous passent ; les huit petites sondes natives préexistantes passent également.
Le contrôle analytique indépendant du terrain bilinéaire exporté ne trouve
aucun dépassement de coupe supérieur à 1 cm ; le résidu maximal est de 2,1 mm
sur le canyon. Les vrais polygones SVG des variantes rivière/fleuve/largeur×2
et du grand cas à intensité 2 ne présentent aucun contact indépendant hors lac.
Aux trois pins utilisateur, aucun affluent ne touche puis ne quitte la rivière.

| Entrée | Carte/motif | Tronçons/lacs | Finalisation WASM chaude, hors rendu |
| --- | --- | --- | --- |
| `1ryr6kq`, rivière, intensité 2 | 3,5/10 km | 13/1 | 345–359 ms |
| `1ryr6kq`, grand fleuve | 3,5/10 km | 13/1 | 608–754 ms |
| `1ryr6kq`, largeur×2 | 3,5/10 km | 13/1 | 490–573 ms |
| `1ds1473`, sortie terrestre au sud | 3,5/10 km | 12/2 | 438–460 ms |
| `1c9fqdw`, plaine | 30/20 km | 536/13 | 679–736 ms |
| `1ijwjgy`, collines utilisateur | 30/10 km | 581/6 | 1 053–1 149 ms |
| `1ijwjgy`, intensité 2 | 30/10 km | 581/6 | 1 127–1 353 ms |
| `48702y`, montagnes avec côtes | 30/10 km | 104/4 | 435–468 ms |
| `48702y`, montagnes sans côtes | 30/10 km | 834/14 | 1 399–1 433 ms |
| `42`, canyon | 12/6 km | 373/36 | 766–815 ms |
| `48702y`, vallée | 12/6 km | 147/4 | 410–424 ms |

Ces mesures séquentielles Node utilisent la grille 512² ; elles ne sont pas un
gain de vitesse annoncé sur l'ancien modèle. Les tronçons sont des arêtes du
graphe, pas autant de rivières indépendantes : le petit cas conserve six sources
naturelles et un apport extérieur. Les dernières scènes Chrome contrôlées
mesurent environ 0,60–1,84 s de finalisation, en plus du drainage préparé GPU
et du terrain/rendu. Plusieurs onglets régénérant ensemble faussent fortement
ces temps ; les captures finales sont faites séquentiellement.

Les comparaisons vectorielles de plaine et du grand cas utilisateur ainsi que
les captures Playwright des trois pins, du faux estuaire, de montagne, canyon
et vallée ont été examinées. Les scènes finales de relief ne produisent aucune
erreur de page. Le banc autonome est aussi vérifié
avec WebGPU et Worker indisponibles et les requêtes de ressources externes
bloquées : grand fleuve, treize tronçons, 69 ms de drainage initial et 710 ms
de finalisation hydrique ; la préparation complète du terrain CPU reste séparée
(environ 7,4 s dans cette capture). `check:terrain` (fmt, Clippy strict, compilation WASM), le typecheck
TypeScript, le build autonome et les builds indépendants de l'application
passent. Le WASM vérifié porte le SHA256
`7192693559C1671351431701534D4AA6C43BE4D0422E5242078F80091FB8621A`.
Les captures et replays restent dans le répertoire ignoré `rust/out/`.
