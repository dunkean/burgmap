# Lisières ouvertes et empreintes bâties

Les deux analyses demandées sont dans [ANALYSE_CONTOURS_2026-10-06.md](ANALYSE_CONTOURS_2026-10-06.md) et [ANALYSE_MAISONS_2026-10-06.md](ANALYSE_MAISONS_2026-10-06.md). La [revue unique Opus 5.5](REVIEW_OPUS_GLOBAL_2026-10-06.md) a fait corriger notamment l'audit des coordonnées arrondies, le repère des parcelles fusionnées et les contrats eager/lazy. Les implémentations ont été confiées aux agents Sol medium. La validation intégrée et les confirmations Sol xhigh sont décrites ci-dessous.

## Comportement obtenu

- Les limites de planification restent disponibles pour partitionner la ville. Leur bord ne sert plus à couper systématiquement les toits d'une ville ouverte : une maison peut dépasser sur le terrain extérieur libre et sec. La transaction vérifie aussi les autres propriétaires, les quartiers voisins, les réserves rurales, les murs, l'eau, les rues et les accès. Une enceinte physique reste une contrainte.
- Les voies visibles distinguent raccord régional, jonction réelle, dernière maison desservie et accès agricole. Une queue sans destination s'arrête après la dernière construction qu'elle dessert. Les contours de champs ne comptent plus comme des raccordements routiers. Les axes nécessaires aux partitions restent stables.
- Le sol public de la périphérie retourne progressivement au paysage, avec une lisière irrégulière déterministe en coordonnées du monde. Les routes utiles, places, bâtiments, réserves et jardins privés sont protégés. Les jardins irrigués et les espaces volontairement pavés gardent leur fonction. SVG et Canvas utilisent le même masque.
- La forêt suit une règle distincte du sol : elle est exclue de l'empreinte des quartiers, y compris de leurs terrains ordinaires non bâtis. Les seuls espaces où des patchs de forêt peuvent rester sont les parcs et jardins explicitement désignés. Les arrière-cours génériques ne sont pas des exceptions. Le masque commun suit les empreintes eager, les colonies secondaires et les quartiers lazy, sans contourner chaque toit. Cette règle de rendu, intégrée à `856cc1e`, ne modifie pas la génération.
- Les parcelles fusionnées retrouvent leur vrai repère de façade. La finition des maisons mesure les étranglements locaux, corrige les replis et teste les morceaux retenus contre tous les autres toits. Un toit triangulaire plausible est conservé ; une pointe excessive peut être émoussée sur la maison, sans modifier le quartier.
- Une réparation recherche d'abord une empreinte entière, puis des pièces desservies. Une maison ordinaire invalide peut être reconstruite dans une poche libre de sa propre parcelle, à déplacement et nombre d'essais bornés. Les pièces plus petites et le retour d'un remplissage minuscule en cour sont des derniers recours comptabilisés. Les cours, anneaux et programmes culturels volontairement étroits sont exclus de ces règles ordinaires.
- Une ruelle privée n'est publiée qu'après preuve de son raccord géométrique sur toute sa largeur à une rue ou place existante et du maintien des accès voisins. Les propositions refusées ne modifient ni jardins, ni terrain libre, ni propriétaires. Les indices restent stables pendant les retraits différés.

## Régressions natives

Les deux liens utilisateur correspondent à la même carte compacte, seed `xrv97g`, avec 14 pins de formes et 9 pins de découpes. Les tests emploient les options compactes originales, les coordonnées en mémoire et les mêmes options pour l'ancien et le nouveau producteur.

Deux cas illustrent la distinction entre limite administrative et obstacle réel :

- Le grand toit près de `(571,727)` garde toute son ancienne surface et reçoit une extension vérifiée sur l'extérieur libre. Son ancien étranglement est élargi sans perdre un morceau du toit.
- La maison près de `(931,408)` est reconstruite entière dans la poche occidentale libre de la même parcelle. Sa surface est conservée et ses voisins restent desservis ; aucune ruelle artificielle n'est nécessaire.

Le test natif contrôle notamment l'absence de polygones malformés, de chevauchements de bâtiments au-delà de 5 cm, de bâtiments hors propriétaire, de façade manquante et d'accès perdu. Les coutures numériques sont distinguées des collisions réelles par leur épaisseur, plutôt que par la seule aire d'un export arrondi.

## Validation et limites

La première intégration de génération est `f5ecca0`, avec ses régressions à `8d1df55`. Les mesures et captures ci-dessous portent sur cette étape ; le HTML correspondant a pour SHA256 `04dc6a3aba9abc714d30036e58c0adbdf266da42e92b1352eba4d89ea0a8b6ad`. La nouvelle référence médiévale à 43 pins est en cours de correction ; la révision finale et ses mesures seront ajoutées après validation.

La règle de forêt de `856cc1e` passe 91 tests ciblés, typecheck et build. Trente-deux captures natives comparent SVG/Canvas, quatre styles et les textures classiques ou peintes. La forêt disparaît du village secondaire `p4uefz`, y compris de ses espaces non bâtis, sans changer sa géométrie ni la forêt extérieure. Les preuves sont dans `C:/Users/grego/AppData/Local/Temp/burgmap-geometry-qa-20261006/forest-quarter-native/`. Ces captures remplacent la proposition de dégagement autour des bâtiments, qui n'a pas été retenue.

La comparaison exhaustive a révélé deux régressions du repère de parcelle. Une ruelle plus proche masquait le contact réel avec une grande rue ; la recherche vérifie maintenant aussi les autres rubans indexés avec leur largeur locale et un contact sur toute la façade candidate. Une façade fragmentée était également prise pour les deux lignes latérales : la reconstruction suit ses segments jusqu'au vrai tournant vers l'intérieur. Les six maisons de la parcelle chinoise et les deux extrémités arrondies de la maison iroquoise sont restaurées. Les tests natifs de ces cas passent.

Un troisième écart est un changement voulu du contrat de finition : le quartier mature ouvert `p4uefz` passe de 71,19 % à 69,87 % de couverture en réparant des formes, avec ses 648 bâtiments conservés (1,86 % de surface retirée). Le test observe sans mutation l'entrée de la passe, exige toujours le programme initial à 70 %, puis vérifie la réserve de 97 % de surface logement totale et le seuil mature correspondant après réparation. Les assertions de partitions, accès et occupation du sol sont conservées.

Les audits natifs portent sur la carte à 23 pins, Wizard Town et la ville ouverte `p4uefz`, avec leurs options exactes. Aucun polygone malformé, échec de booléen, chevauchement réel de bâtiments au-delà de 5 cm, bâtiment hors propriétaire ou accès perdu n'a été trouvé dans ces trois cas. Les coutures résiduelles mesurées sont inférieures à 0,55 mm.

| Cas natif | Toits finaux | Surface logement finale / ancien producteur `e695316` | Indicateurs de formes encore signalés |
| --- | ---: | ---: | ---: |
| Carte à 23 pins | 871 | 98,979 % | 1 atelier composé et habitable |
| Wizard Town | 803 | 97,789 % | 3 retours étroits conservés |
| Ville ouverte `p4uefz` | 1 111 | 97,210 % | 10 petits retours conservés |

Dans le troisième cas, 1 064 logements restent sur 1 068 dans l'ancien producteur (99,625 %). Le nombre de toits inclut aussi les bâtiments hors logement. La réserve cumulative de la passe finale est de 97 % de sa **propre surface logement initiale**, et de 98 % du nombre initial lors des retraits ; ces seuils ne sont pas des ratios garantis par rapport à l'ancien producteur.

Le navigateur réel passe les quatre modes Worker, rendu principal, fichier hors ligne et Worker refusé pour la carte utilisateur et Wizard Town. Les exports SVG, PNG et JSON sont comparés entre les modes, les courses de génération sont exercées, et le fichier hors ligne fonctionne sans requête HTTP. Les 32 captures de lisières couvrent les quatre styles, SVG/Canvas et DPR 1/2 : leur géométrie est cohérente malgré les différences de texture entre les rendus. Les références de voies des colonies secondaires sont vérifiées après fusion. Les sondes lazy vérifient aussi le dépassement réel des quartiers ouverts et l'absence de mutation de leur hôte.

Les captures finales sont dans `D:/Workspace/Self/RPG/city_generator_rendu_20261006/web/out/release-user-closeups/` (23 pins et 10 gros plans complémentaires) et `…/web/out/frame-ground/` (32 rendus de lisières). Les rapports `release-pins-{quality,audit}.json`, `frame-{wizard,fringe}-{quality,audit}.json`, `release-native-pins/results.json` et `frame-native-wizard/results.json` sont conservés dans le même `web/out/` ignoré. Les sondes lazy finales sont dans `frame-lazy-{open,walled}.log` ; leurs gardes sont également couvertes par la suite exhaustive finale.

La suite complète est en cours et est comparée à la référence exécutée avant modification : 1 377 tests, 1 320 réussites, 53 échecs préexistants et 4 tests en attente. Une première exécution parallèle s'est interrompue par manque de mémoire ; la relance conserve les 72 cas de villes, chacun dans un fichier de processus jetable, et toutes les autres suites, avec trois workers. Les résultats définitifs et la révision publiée seront ajoutés après cette comparaison.

Les recherches sont bornées et refusent une réparation non prouvée. Les indicateurs de largeur ne constituent pas à eux seuls un diagnostic visuel : un atelier composé, un triangle habitable ou un programme culturel peut rester signalé par un audit ordinaire. Les contrôles ne prétendent pas démontrer l'absence de toute forme résiduelle sur toutes les graines.
