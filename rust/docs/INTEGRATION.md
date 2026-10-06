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
avec des hauteurs, crêtes et largeurs de raccord propres à chaque îlot. Le relief
est continu entre les branches d'un même îlot, puis soumis à l'érosion commune.
Un fork `islet-sizes` mélange trois classes de rayon rapportées à la carte
(0,25–0,85 %, 0,9–2,3 %, 2,5–4,5 %). Les premières cibles comprennent une grande
et deux moyennes. Le placement tient compte de leur emprise, des formes déjà
placées et du continent ; une cible trop grande rétrécit progressivement si
les secteurs maritimes n'offrent pas assez de place. CPU/GPU consomment le même
plan de formes et de tailles.

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
