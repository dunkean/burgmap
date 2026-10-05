# Terminaison des opérations géométriques — 2026-10-05

Le garde de terminaison `64638e4` est intégré dans `0db97c8`, après les corrections
visuelles et la projection des Workers. Il répare la boucle constatée dans les
deux tests japonais `p4uefz` pendant la certification des optimisations.

Les deux workers bloqués avaient exactement les mêmes arguments de différence
polygonale : 20 sommets du sujet, 13 opérandes. L'appel capturé ne terminait pas
dans les replays supervisés de la baseline et de la version optimisée, arrêtés
chacun après dix secondes. Cette observation concerne cet appel précis ; elle
n'est pas une exécution complète de la baseline.

Le module verrouillé `polygon-clipping@0.15.7` est conservé dans `src/vendor/`.
Deux boucles de recherche de voisin consommé sont bornées chacune par la taille
de leur arbre plus un. Dépasser ce nombre déclenche une erreur d'invariant ; le
module ne retourne pas un résultat partiel. Le wrapper géométrique conserve ses
retries et ses résultats d'échec existants. Aucun seuil de temps, heuristique
de géométrie ou nouveau nettoyage de contour n'est ajouté. Le test mécanique
reconstitue exactement le fichier amont en retirant les deux gardes et l'en-tête.
La notice MIT est préservée dans le HTML et dans les cinq scripts de Workers.

Les quatre régressions couvrent l'appel capturé, 96 opérations normales identiques
au module amont, les échecs explicites et la copie mécanique. Les 16 contrôles
existants de géométrie et de preuves de toits passent aussi. Après intégration,
40 tests dans sept fichiers, typecheck et build passent. Les deux cas natifs
Sahel/tempéré passent leurs huit modes, exports, styles, déplacements et
supersessions de génération sur le nouveau HTML construit.

Le checkpoint `pre-brushes-2026-10-05` (`fe9ffa2`) est publié sur Pages `9505299`.
Le HTML distant est identique au build local contrôlé ; les huit contrôles natifs
réussissent aussi sur cette publication réelle.

La génération japonaise termine avec le garde. Les tests existants, sans changer
leurs attentes, donnent **5 réussites et 2 échecs de disposition** : aire de la
zone libérée 3 196,9609 m² attendue sous 500, et plus grand lot intermédiaire
162 083,9377 m² attendu sous 15 000. Les mêmes valeurs apparaissent dans la
baseline munie du seul même garde. Les Worlds complets, tableaux et métadonnées
compris, ont exactement le même hash canonique hors champs `stats` :
`476dc204234668dab361a3267b881c392c8eef67bd992c6f881373958ba6fcc2`.
Cela attribue leur différence vis-à-vis des attentes à un comportement déjà
présent avec cette baseline réparée ; cela ne certifie pas une génération
complète de la baseline sans garde ni une suite exhaustive verte.

Les contrôles existants de partitions, accès et surfaces ne signalent aucun
débordement de surface de toit sur ce World. Un audit direct plus strict retrouve
cependant deux contours repliés : segments antiparallèles de 0,452749 m et
0,393608 m, sans surface positive mesurable (aire locale sous 1e−12 m²), dont le
trait peut dépasser du lot de
0,1741 m et 0,1334 m. Les témoins sont identiques dans les deux Worlds. Ces défauts
de contour restent ouverts ; une aire de différence nulle ne les efface pas.
Deux landmarks portuaires rencontrent aussi le masque d'eau : ce diagnostic
ne certifie pas leur conformité à tous les usages portuaires.

Preuves : `web/out/optimization-implementation-2026-10-05/polygon-traversal/`,
en particulier `verification-summary.json`, `world-parity.json`,
`roof-hairpin-witness.json`, `geometry-witnesses.json`, `blob-notices.json`,
`japanese-existing.*`, `root-integration-focused.*` et `native-root-*/`.
