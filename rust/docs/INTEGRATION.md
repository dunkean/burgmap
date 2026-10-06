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
suivent la même surface. La projection régionale est apériodique. La caldeira ouverte
est un type dédié et la caverne ignore l'érosion.
`bridge/` adapte ces données au rendu de terrain actuel. Le modèle `World`
n'est pas le modèle du moteur Rust. Voir [README](../README.md) pour le
contrat, les commandes et les limites de cette première étape.

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
