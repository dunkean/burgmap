# Brosses naturelles optionnelles

Implémentation revue : `65187de26a584bea16f06ede2549115f96ad46f6`.
Intégration : `b23225125fa4c63372d0ad0cbceb8e1d94d7fba6`.
Le rendu classique reste celui par défaut, protégé et publié sous
`pre-brushes-2026-10-05`. L'option **Customize → Appearance → Painted natural
textures** change l'apparence immédiatement, sans régénérer la carte.
`brushes=painted` conserve ce choix dans les liens et rapports de reproduction.

## Publication

La version est publiée sur https://dunkean.github.io/burgmap/ : source `ea6223a`,
tag annoté `biome-brushes-2026-10-05`, Pages `734770c`. Le SHA256 du fichier servi
correspond au build intégré ci-dessous. Les deux cartes réelles passent aussi
les **16 scénarios sur le site publié**, dont le fichier hors ligne sans requête
réseau. Preuves : `brushes/publication-proof.json`,
`brushes/native-published-default/results.json` et
`brushes/native-published-sahel/results.json` dans le dossier de vérification.

## Planches de présentation

Cinq PNG de **6400×3040**, chacun avec huit vraies cartes : tempéré, forêt,
désert, steppe/toundra et tropical. Ils couvrent six biomes et 32 cultures,
avec des conditions de rivière et de littoral variées. Les brosses sont activées.
Les captures utilisent le HTML publié ci-dessus et conservent les liens,
Worlds, SVG et métadonnées de cadrage/eau dans
`web/out/optimization-implementation-2026-10-05/presentation-boards/final/`.
Les cinq compositions sont livrées directement, sans nouvelle revue visuelle,
selon la dernière demande de l'utilisateur.

## Rendu et variété

Les six biomes ont leurs plantes et mélanges déterministes par graine : arbres,
arbustes et végétation basse, avec des espèces fruitières pour les vergers.
Les dunes, rochers, roseaux, jardins et cultures utilisent une seconde planche.
Les vergers gardent leur grille ; les autres motifs ont des placements décalés.
Les motifs restent périodiques : forêt 72 m, verger 88 m. Cette répétition permet
de garder un coût et des exports bornés.

Les zones et leurs trous découpent les textures. Les arbres isolés conservent
leurs positions et rayons ; champs, sillons, rues, bâtiments et murs gardent
leur géométrie. Aucun paramètre de génération ni objet World n'est ajouté ou
modifié. Les styles monochromes appliquent une teinte commune SVG/Canvas ;
le mode nuit éclaircit seulement les brosses pour rendre le feuillage lisible.

Les deux atlas ont été créés avec **ImageGen intégré**, à la demande de
l'utilisateur. Les originaux RGBA sélectionnés sont conservés sans retouche
manuelle. La végétation v2 corrige les deux cases vues de côté signalées par
l'utilisateur. Aucune nouvelle retouche après sa demande de garder les planches.

- [Végétation, six biomes](web/src/render/assets/biome-vegetation-v2.png).
- [Dunes, rochers, herbes, marais, jardins et cultures](web/src/render/assets/terrain-cultivation-v1.png).
- [Prompts de génération et d'édition](web/src/render/assets/prompts.json),
  [provenance et hashes](web/src/render/assets/PROVENANCE.md).

## Coût et fonctionnement

Les PNG pèsent **3 497 089 octets**. Le HTML autonome passe de 3 478 068 à
8 162 103 octets, soit **+4 684 035 octets**, même si l'option est désactivée.
Le build compressé gzip est d'environ 4,74 Mo. Les atlas figurent une fois dans
le bundle principal ; les cinq Workers décodés, dont le Worker de quartier
imbriqué, n'en contiennent aucune copie.

Le décodage est différé jusqu'à l'activation, dans le thread qui dessine.
Les deux atlas décodés occupent environ 12 Mio. Les motifs ont un LRU de
16 Mio par renderer ; les styles monochromes ajoutent environ 12 Mio d'atlas
teintés. Le cache de tuiles raster existant est distinct. Ces chiffres ne sont
pas une borne de mémoire totale de l'application ou de ses exports.

Une erreur de décodage conserve le rendu classique. Un décodage tardif respecte
la carte et le style courants, y compris après désactivation et nouvelle carte.
SVG embarque chaque atlas une fois, PNG restitue le choix courant, et JSON reste
le même modèle. Le fichier autonome fonctionne hors ligne.

## Validation

La source a été relue par blocs avant exécution. **20 tests ciblés**, typecheck
et build passent sur le candidat. La sonde compare une source classique
indépendante : **72 cas**, six biomes, trois styles, deux zooms, DPR 1/2 et
**216 PNG**. Option désactivée : zéro canal pixel différent et SVG identiques
octet par octet ; hashes World inchangés. Les motifs respectent les trous.
Les écarts entre dessin direct et tuiles raster sont faibles et inspectés,
principalement sur les fins contours et sillons antialiasés.

L'intégration passe **61 tests dans dix fichiers**, typecheck et build. Son
HTML est identique au candidat testé : SHA256
`c69b5e7d3b946b4ca24b26be7435e5073fb40d57fbda4190709840f1789da1c5`.

Deux vraies cartes, tempérée et sahélienne désertique, passent chacune :

- quatre backends : offscreen, main, fichier hors ligne, refus des Workers ;
- activation, exports SVG/PNG/JSON, restauration exacte des pixels classiques,
  même génération et même World, liens de partage/reproduction, rechargement ;
- quatre cas de résilience : échec et retard de décodage en main/offscreen,
  puis désactivation, changement de style et nouvelle génération.

Les premières tentatives du harnais sont conservées : comparaison DOM incluant
HUD/minimap, état initial gen=0 accepté trop tôt, puis nouvelle carte non encore
démarrée pendant son debounce. Les remèdes comparent le Canvas seul, attendent
une génération positive puis le nouvel identifiant demandé. Aucune assertion
de géométrie ou production n'a été assouplie pour ces remèdes.

Preuves dans `web/out/optimization-implementation-2026-10-05/brushes/` :
`verification-v2-summary.json`, `bundle-worker-assets-v2.json`,
`native-worktree-default-v5/results.json`, `native-worktree-sahel-v5/results.json`.
Les temps des sondes sont exclus des comparaisons de performance, car la suite
étendue tournait en parallèle. Le gain de rendu précédemment mesuré concerne
le rendu classique ; aucun gain supplémentaire des brosses n'est certifié ici.

La suite étendue historique reste incomplète et comporte des échecs hérités.
Voir [l'optimisation et ses limites](OPTIMIZATION_IMPLEMENTATION_2026-10-05.md),
[le garde polygonal](POLYGON_TRAVERSAL_FIX_2026-10-05.md) et
[le statut partiel des bugs visuels](BUGFIXES_VISUAL_2026-10-05.md).
