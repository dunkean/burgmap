# Parcours d'intégration

## Première étape autorisée — terrain (6 octobre 2026)

Le prototype terrain dispose désormais de sa propre page `/terrainbench.html`.
Il utilise exclusivement Rust/WASM pour le relief ; l'application et le banc
de parcelles existants restent en TypeScript. La demande actuelle remplace,
pour cette étape, la sélection TS/Rust dans le même banc et reporte les tests.
Les compilations et la vérification visuelle restent utiles au développement.

La frontière temporaire conserve un `TerrainEngine` par configuration. La
taille de carte (jusqu'à 100 km) et la taille physique du motif sont indépendantes.
Les appels `sample_region` transportent des grilles d'altitudes et de normales
`Float32Array` et, pour la caverne, un masque `Uint8Array`. Un aperçu de 512²
est complété par des régions de 768² au déplacement et au zoom ; ces appels
réutilisent le relief préparé et ne relancent pas l'érosion. Le bruit et le relief
préparé filtrent les détails sous la résolution demandée ; normales et courbes
suivent la même surface. L'érosion régionale utilise désormais les coordonnées
réelles de la carte, avec une finesse limitée par son raster de 1024². Les vallées
ont un réseau courbe d'affluents fixe ; les canyons tirent leurs axes du drainage. La catégorie `mixed` possède
un curseur de proportion de montagnes, transmis comme sixième argument facultatif
du constructeur WASM. La caldeira ouverte est un type dédié et la caverne ignore
l'érosion ; ses parois descendent vers les ouvertures et le banc les rend en noir
ombré sans bandes.
Le canyon incise spécifiquement les grandes rivières du haut pays. Le drainage
relie les cuvettes ; l’accumulation physique sélectionne les axes, leurs profondeurs
et leurs largeurs. Des profils en distance euclidienne élargissent les berges,
puis 12 passes de surface érodent les parois. Aucun tracé analytique imposé.
L’érosion normale s’étend de 0 à 200 % (100 % par défaut, 200 % = dose doublée).
Une passe commune après le détail fin ajuste l’incision à la pente et à la
surface du bassin versant rapportée au motif ; les contributions excessives
sont bornées. L’érosion ne creuse plus les exutoires des cuvettes par chaînes
D8 et ne coupe pas les flats sur la seule base de leur potentiel de drainage.
Sa grille physique varie de 640 à 1024 cellules, avec une marge extrapolée.
Le relief Montagne et le mélange collines/montagnes gardent un soulèvement doux,
avec les réglages de talus, diffusion et détail de la référence TypeScript.
Le relief Montagnes (chaînes, anciennement haute montagne) conserve la charpente
ridged dans le soulèvement principal. Le CPU et le plan d’érosion GPU utilisent
les mêmes paramètres ; les identifiants `mountains` et `high-mountains` restent
compatibles avec les liens existants.
Les collines gagnent 10 % d’amplitude ; leur érosion de surface suit un seuil
de pente adapté au relief. Les alentours du plateau sont à une échelle ×2,5 ;
ceux des vallées, volcans et caldeiras à ×2. Les formes centrales gardent
leur propre motif, et le plateau ne change plus d’emprise avec la dose.
Les plateaux, volcans et caldeiras génèrent et érodent leur forme locale
sur GPU FP32. Leurs alentours sont sélectionnables : plaine, collines, mixte,
montagne ou montagnes (chaînes, `environment=`, mixte par défaut). La plaine
conserve son calcul Rust existant, séparé dans les diagnostics de temps ; les
autres alentours sont préparés sur GPU. Le champ local et le champ régional ont des
pyramides séparées ; le zoom conserve l’échelle du motif et ne relance rien.
Une union lissée et un fondu spatial remplacent le raccord par maximum dur.
Le plateau possède trois à sept lobes, des baies, parfois des morceaux détachés,
avec les anciens paliers et petits reliefs du dessus restaurés à la demande
utilisateur. Son masque de raccord
suit le contour et s’annule avant le bord du champ local, supprimant la fondation
carrée signalée avec la graine `14k0yl1` (10 km, motif 5 km, érosion 1,33).
Le raccord volcan/caldeira suit leur contour bruité et s’annule sur un support
circulaire avant les bords du champ local, sur CPU comme GPU. Il supprime aussi
la fondation carrée de la graine `1fc2unq` (12,5 km, motif 7,5 km, érosion 1,21),
sans modifier le plateau.
Les trois formes ont une origine géographique décalée par un fork RNG dédié
(`geological-placement`), avec une marge quand le motif tient dans la carte.
Elle reste identique quand seuls les alentours ou la dose changent. La fondation
utilise cette origine réelle. Le canyon conserve son champ régional sur toute
la carte et son réseau issu du drainage et de l’incision des grandes rivières.
Il ne reçoit ni raccord de forme finie, ni déplacement de source, ni alentours
sélectionnables ; les anciens paramètres `environment=` sont ignorés pour lui.
Les formes finies sont posées sur une fondation filtrée de l’environnement et
gardent leur bassin/sommet intact. La brèche rejoint progressivement l’extérieur.
Le détail régional au zoom révèle la surface préparée sans octave supplémentaire
ni texture indépendante. Le grain du banc reste désactivé. La nouvelle image régionale
est décodée avant un court fondu, en conservant l’ancienne jusque-là.
`bridge/` adapte ces données au rendu de terrain actuel. Le modèle `World`
n'est pas le modèle du moteur Rust. Voir [README](../README.md) pour le
contrat, les commandes et les limites de cette première étape.

### Extension côtes (7 octobre 2026)

Le banc terrain accepte un masque de huit directions indépendantes, conservé
dans les liens et désactivé en caverne. Toutes les directions activées donnent
une île principale ou un archipel de trois à sept îles principales, selon un menu
qui propose aussi un tirage seedé. `TerrainEngine.set_coast(mask, mode)` réutilise
le relief préparé, découpe la côte puis applique l'érosion finale de surface.
Le chemin GPU utilise `configure_coast`, assemble directement un champ 1024²
sur le device, puis applique les passes physiques GPU avant `set_coast_surface`.
Le champ signé final revient à Rust pour ses mips ; aucune normalisation ne
déplace le niveau marin. L'érosion antérieure du relief principal reste conservée.
Le cœur Rust et le sampler WGSL consomment les mêmes paramètres FP32, avec
coordonnées rapportées à la carte et niveau marin à zéro. Les altitudes négatives
portent le fond marin ; le renderer transitoire découpe la terre par un masque
vectoriel antialiasé issu de la même surface, sans trait brun de bordure.
La surface littorale physique est conservée au zoom ; sa finesse est bornée
par la grille 1024². Pas de nouvelle hydrologie ni simulation marine.

Le retour utilisateur suivant remplace les ellipses et les découpes cumulées :
un contour à huit secteurs garde de larges attaches dans les directions terrestres.
Les îles combinent des axes courbes de largeur variable et des branches, avec
des îlots détachés près des côtes. Un fork `shore-noise` fournit plusieurs échelles
de découpe sur CPU et GPU ; le filtrage suit le pas physique d'échantillonnage.
Le support continental utilise une superellipse tournée et seedée pour éviter
les angles droits. Une rampe multiplicative de largeur variable alterne plages
douces et portions rocheuses ; elle reste bornée par la taille locale.
Pour les plaines côtières, la référence marine retire 35 % de l'amplitude nominale
avant un plancher positif doux et la découpe : le socle constant de la formule
intérieure ne crée plus une marche de près de vingt mètres vers la mer.
Les petits îlots ont six familles de silhouettes, de compactes à ramifiées,
avec des hauteurs et largeurs de raccord propres à chaque îlot. Une hauteur
simple est partagée entre ses branches, puis soumise au raccord à la mer et à
l'érosion commune. Les bruits fBm et ridged ajoutés à l'intérieur ont été retirés
après le signalement des deux îles marquées sur `12fu8j0` (canyon, carte10km,
motif8km, érosion1,37). Les anciens tirages de détail sont consommés pour
conserver exactement les silhouettes, tailles et placements de cette graine.
Un fork `islet-sizes` mélange trois classes de rayon rapportées à la carte
(0,25–0,85 %, 0,9–2,3 %, 2,5–4,5 %). Les premières cibles comprennent une grande
et deux moyennes. Le placement tient compte de leur emprise, des formes déjà
placées et du continent ; une cible trop grande rétrécit progressivement si
les secteurs maritimes n'offrent pas assez de place. CPU/GPU consomment le même
plan de formes et de tailles.

### Extension hydrologie (7 octobre 2026)

Le design a été validé pour le banc Rust : **Relief → Côtes → Hydrologie**,
avec une séparation des réglages généraux, des étapes et de l'affichage.
L'utilisateur demande plusieurs agents Sol, une implémentation compacte et
une validation principalement visuelle par ses soins, sans matrice de tests.

`HydrologyEngine` conserve un échantillon de la surface finale en mètres,
son drainage CPU ou GPU et ses bassins versants. Le GPU utilise FP32 pour
les niveaux/potentiels et un comptage entier pour l'accumulation, reconvertie
en m². Seule la mer connectée au bord sert d'exutoire marin. Le potentiel
d'écoulement est distinct des altitudes physiques. Les sorties WASM sont des
tableaux groupés indépendants de `World` : récepteurs, surfaces drainées,
labels de bassins/lacs, surface physique avant incision, niveaux remplis,
profondeurs des lacs, surface ajustée, axes/largeurs/profils, nœuds et
contours avec trous. Les offsets comptent des sommets ; le récepteur terminal
vaut `u32::MAX`. Les commentaires Rust décrivent les enregistrements vectoriels.

Les lacs naturels suivent les cuvettes et les seuils de débordement. Le mode
« quelques lacs » peut créer des cuvettes bornées et recalculer leur drainage
en Rust, même lorsque le drainage initial utilise le GPU ; le diagnostic
mentionne cette étape CPU. Les grands cours reçoivent un apport extérieur
uniquement si une entrée terrestre descendante est disponible. Sinon, le
cours principal reste limité au bassin local avec une indication dans le banc.
Les lacs sont classés par profondeur moyenne et alimentation ; leur quantité,
leur budget total et leur taille individuelle sont indépendamment réglables.
Les plafonds par défaut sont 5 % des terres pour l'ensemble et 2 % par lac.
On conserve ou écarte des cuvettes entières, sans abaisser artificiellement
leur niveau d'eau sous l'exutoire. Ces plafonds s'appliquent aussi aux lacs aménagés.
Les méandres ajoutés sont bornés par la pente et le confinement de la surface
physique, en laissant de la mobilité dans les cuvettes comblées. Un obstacle
local atténue le coude concerné sans annuler les méandres de tout le cours.
Le tracé intègre une variation continue de fréquence, amplitude et asymétrie
seedée par cours, à une longueur d'onde proportionnelle à sa largeur. Les petites
inflexions pentues sont bornées en mètres selon la largeur ; elles ne sont
pas supprimées par un seuil global de pente ou de facteur de déformation.
Le profil fractionnaire suit le terrain physique entre centres de cellules,
avec les niveaux des nœuds conservés et une descente monotone. L'accumulation
diagnostique reste complète ; la sélection des sources utilise séparément
les apports des terrains non enterrés pour éviter les branches artificielles
parallèles dans les cuvettes comblées.
Le routage final identifie les composantes exactement plates de F, naturelles
ou remplies, et leurs vraies sorties. Un parcours métrique à coûts positifs
favorise les creux du terrain enterré sans modifier les altitudes. Une seconde
passe bornée consolide les corridors déjà alimentés des grandes cuvettes
comblées. L'ordre de finalisation fournit un rang entier strictement descendant.
Les pentes nettes gardent un drainage descendant. Les lacs retenus sont ensuite
agrégés vers un exutoire stable, en évitant de croiser les entrées sèches.
Le rang exporté décrit le masque avant cette
agrégation, pas un ordre de drainage intérieur aux lacs.
Un seul graphe autoritatif alimente accumulation, bassins et vecteurs ; les
récepteurs/accumulations/bassins bruts restent disponibles séparément. L'apport
extérieur en m² équivalents est inclus dans l'accumulation finale. Les anciens
Dijkstra de capture par arrivée sont supprimés. Les voisins de la simplification
restent indexés spatialement, même sans nœud partagé.
Les cours dominants sont vectorisés en continu puis divisés
aux nœuds du graphe ; les affluents se raccordent vers l'aval sous contraintes
topographiques et spatiales, avec des nœuds fixes et un raccord terminal court.
Les courbes C1 sont subdivisées selon leur erreur géométrique et leur profil
vertical, à une précision liée à leur largeur physique. Les portions droites
ne sont plus subdivisées uniformément. La simplification conserve les nœuds
et restaure localement les points nécessaires si un raccourci croise un voisin.
Les contrôles redondants sont retirés avant le calcul des tangentes C1 : des
stations de courbure presque confondues avec les stations de grille ne doivent
pas resserrer artificiellement l'arrondi. La reparamétrisation suit les distances
métriques originales, avec les nœuds conservés exactement. La phase ne
redémarre pas à chaque confluence ; une correction locale maintient chaque
nœud fixe. Le travail reste borné par le nombre de stations par cours et la
subdivision adaptative. Un régime calme conserve une amplitude visible dans
une plaine ouverte, tandis que pente et confinement peuvent la réduire.
Une courbe qui resserre un coude existant sous un rayon compatible avec la
largeur est atténuée localement. Les raccords d'affluents gardent une
approche bornée sous contraintes de terrain et de voisinage. Les corrections
spécifiques aux longues jambes droites et les retries de queue sont supprimés.
Le contrôle final ne se limite plus aux raccourcis de simplification : une
portion détaillée qui croise un voisin reprend localement sa référence de
drainage D8, avec les mêmes nœuds et profils. Voir
[le modèle hydrique et ses limites](HYDROLOGY.md).
Le remplissage des eaux reprend la palette marine.
Pour les cuvettes non retenues, le mode automatique recherche une ouverture
bornée par composante, avec un budget global de visites. Les limites par défaut
sont 12 m de coupe et 1 000 m de longueur ; le volume de coupe doit être au plus
10 % du remblai évité. Les composantes contenant un lac retenu sont protégées.
Un drainage complet du terrain proposé vérifie ensuite les niveaux des lacs :
tout changement annule le plan. En présence de mer, une ouverture ne descend
pas sous le datum marin. Le mode `fill` garde le comblement seul, également
utilisé comme repli. Le comblement résiduel précède l'incision ; le relief GPU
amont reste intact. Les champs physiques et F initiaux sont conservés séparément,
ainsi que le nombre d'ouvertures, le volume coupé et le remblai réellement évité.
Les variantes d'embouchures donnent un aspect simple/élargi/entonnoir/tidal ;
la simulation des marées, des sédiments et des deltas reste ultérieure.

`bridge/hydrology.ts` conserve drainage et sorties ; une modification hydrique
réutilise le relief. La surface avant incision est conservée séparément.
`hydrologySurface.ts` interpole le comblement large par une B-spline cubique
et échantillonne le lit directement depuis les axes/largeurs/profils vectoriels.
Les coupes physiques des seuils utilisent séparément des corridors continus
entre centres D8 à cote absolue, avec des raccords doux : le lissage du remblai
ne rebouche pas leur ouverture, même lorsque l'incision est nulle.
Un index spatial conservé borne le travail aux segments proches de la tuile.
Le rayon de creusement est physique, indépendant de la résolution du drainage ;
les segments utilisent une enveloppe commune plutôt qu'un creusement additif.
Le cœur conserve la même formule sur sa grille de diagnostic. Les tuiles
parcourent la bande du lit par ligne plutôt que le rectangle entier des longues
diagonales. Le comblement cubique est évalué de manière séparable, avec la même
surface. Les PNG de caméra utilisent une compression sans perte plus rapide.
Les chemins de contours sont conservés pour une même surface, calculés à la
demande lorsqu'ils sont visibles ; leur précision ne change pas. Les tuiles
caméra ne recalculent pas le réseau. `hydrologyRender.ts` adapte les vecteurs
au SVG temporaire et rend les diagnostics conservés ; leurs rasters servent
uniquement à l'affichage. Le worker garde ses grilles intactes et les transmet
sur les réponses d'aperçu, pas sur chaque demande caméra. Il prépare aussi PNG
et contours pour les demandes de génération/caméra ; le thread principal garde
le décodage et l'insertion. Le repli sans worker et les changements de style
peuvent encore préparer la scène sur le thread principal. Les berges vectorielles
emploient des intersections d'offset bornées, avec biseau aux angles extrêmes.

La pose d'une source et le remplissage animé restent différés. Les liens v3
incluent hydrologie et diagnostic ; les liens Rust v2 sans options d'eau
conservent leur affichage historique. Le build TypeScript ordinaire reste
indépendant de Rust. Voir le README pour les commandes et contrôles.

## 1. Design puis moteur natif

L'utilisateur définit les étapes, les entrées/sorties et les règles du nouveau
moteur. Créer alors les premières crates dans le workspace. Le cœur doit pouvoir
être testé et mesuré nativement sans UI, navigateur ou renderer. Le TypeScript est
une référence visuelle et comportementale, pas une architecture à recopier.

Décisions à prendre avec ce design : RNG et sens de la seed, unités/précision,
topologie et identifiants, étapes incrémentales, annulation, erreurs et diagnostics.
Aucun schéma JSON ni bibliothèque de géométrie n'est choisi à ce stade.

## 2. Première fonction dans le testbench

Commencer par une étape isolée choisie par l'utilisateur. La liaison WASM expose
des opérations par lot ; l'adaptateur dans `bridge/` traduit vers les données
nécessaires au testbench actuel. Les imports du moteur TS restent dans cet
adaptateur, hors du cœur Rust. Aucun appel JS/WASM par sommet.

Lors du branchement, ajouter un choix explicite TS/Rust au testbench, TS par
défaut. Conserver les seeds indépendantes des étapes, les paramètres, pins et
le replay URL ; versionner la sélection du moteur et la configuration Rust.
Un ancien lien continue à sélectionner TS. Une erreur Rust doit rester visible,
sans remplacement silencieux par un résultat TS.

Pour chaque cas : sauvegarder l'entrée, contrôler les invariants définis par le
design, inspecter les images et mesurer séparément le calcul natif/WASM,
l'initialisation, les conversions, transferts et le rendu. Une sortie différente
est acceptable si c'est le design demandé ; ne pas annoncer une équivalence.

## 3. Intégration progressive à l'application

Après validation du testbench, brancher un moteur optionnel dans les workers
existants. Préserver génération courante, annulation, résultats périmés, chargement
progressif et export. Rust reste facultatif pour le build et l'exécution TS.
Le passage par le renderer actuel nécessite un adaptateur temporaire vers `World`.
Ce format historique ne doit pas contraindre le modèle interne du nouveau moteur.

Vérifier dev, build statique, offline `file://`, refus de worker/WASM et reprise
des liens TS. Le bundle autonome actuel reste distribuable indépendamment.
Une distribution expérimentale peut avoir ses propres artefacts ; ne pas publier
ses fichiers dans `web/dist/` ni remplacer la release courante implicitement.

## 4. Remplacement du rendu

Garder génération et rendu sélectionnables séparément durant les essais.
Définir une interface de rendu au niveau de l'UI (vue, options, sélection,
overlays, export, événements) une fois les besoins connus. Le nouveau renderer
consomme le résultat Rust sans dépendre de `World` ou du Canvas actuel.
Seuls les menus/UI existants sont destinés à rester à terme.

La technologie du renderer, les formats binaires, le multithreading WASM et les
en-têtes COOP/COEP restent ouverts. Ne pas imposer un backend GPU ou la mémoire
partagée avant validation des contraintes de déploiement et d'offline.
