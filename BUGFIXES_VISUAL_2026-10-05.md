# Sols et bordures des agglomérations — 2026-10-05

Les corrections visuelles de `BUGS.md` sont intégrées dans `ad6e32a`, avec le
correctif de transfert des Workers dans `f842f9b`. Elles complètent le checkpoint
de performance protégé par `optimization-2026-10-05` et ne changent pas les
parcelles, les toits ou les options de génération.

Le checkpoint classique est publié et protégé par `pre-brushes-2026-10-05`
(`fe9ffa2`, Pages `9505299`). Les deux cas natifs ont aussi passé leurs huit
modes sur le site réellement servi, dont le HTML est identique au build contrôlé.
Voir `pre-brushes-publication-proof.json` dans le répertoire des preuves.

## Comportement

- Suppression de la bordure administrative des quartiers et des segments du
  cadastre qui la redessinaient. Les murs, enceintes, haies et séparations
  intérieures représentant des objets physiques restent visibles.
- Dans le désert, les cours et jardins résidentiels secs retrouvent le sol du
  paysage. Les rues et patios en terre des constructions sahéliennes suivent
  cette politique ; les espaces pavés et les jardins réellement irrigués restent
  distincts. La politique appartient à chaque implantation, y compris lorsque
  une ville secondaire utilise une autre culture.
- En climat tempéré ou forestier, les jardins périphériques peuvent retrouver
  le fond du paysage ; les jardins du centre et des compounds restent dédiés.
- Les campements ouverts se fondent dans leur environnement. Les petits vides
  de réserve extérieurs utilisent uniquement un couvert naturel voisin attesté,
  avec une recherche bornée. Champs, enclos, eau, maisons et espaces dédiés
  restent protégés. Une réserve ambiguë ne reçoit pas de couvert inventé.
- Le Worker de rendu conserve seulement les rasters `dWater` et `hab` lorsque
  le biome est désertique, pour distinguer les jardins irrigués. Les autres
  rasters d'analyse restent exclus du transfert. Le World complet retenu pour
  les exports reste intact.

## Vérification

Les revues de source ont précédé les exécutions. Le bloc visuel intégré passe
104 tests ciblés. Le correctif de projection passe 31 tests dans cinq fichiers,
dont les contrôles de jardins irrigués, le remplacement de rasters dans les
caches, les snapshots avec un site sans champs d'analyse, la copie structurée
et les 11 contrôles existants de terrain urbain/lotissements informels.
Typecheck et build du correctif réussissent.

Cinq Worlds ont été inspectés en SVG, Canvas vectoriel et Canvas raster, avec
leurs anciennes images comme référence : Sahel désertique avec une implantation
secondaire européenne, campement de steppe, citadelle pavée, hameaux tempérés et
village forestier. Les captures couvrent les centres, périphéries et secondaires,
deux styles et DPR 1/2 : 300 PNG, sans erreur du harnais. Chaque World conserve
son hash avant/après le rendu ; les hashes de générations indépendantes ne
servent pas à prétendre une parité entre DPR.

L'application complète construite a aussi été vérifiée sur :

```text
seed=7&size=village&culture=sahel&biome=desert&legend=1&style=parchment
seed=7&size=village&legend=1&style=illuminated
```

Les deux cas passent chacun les quatre modes : offscreen HTTP, main HTTP,
file:// et refus du constructeur Worker. Les exports SVG/JSON sont identiques
entre les modes, les PNG de 3 000 pixels sont valides, les déplacements et les
styles sont effectivement présentés, et deux demandes de génération terminent
sur la dernière génération. Les images natives ont été inspectées.

Le premier test natif après l'intégration visuelle a révélé une véritable
régression : le rendu accédait à `site.fields` alors que la projection du Worker
supprimait ce champ. Ce résultat est conservé, puis corrigé par `f842f9b` ; les
résultats réussis sont dans des répertoires distincts.

La capitale de 60 000 habitants termine aussi ses 103 quartiers et présente
ses 42 802 bâtiments, sans erreur du harnais. Le World complet conserve le
SHA256 canonique hors stats de la référence avant optimisation :
`432a775a6ae2e48c9a2080762644bd189fd8dd484f13e8f9f8cc88753c986074`.
L'image détaillée a été inspectée. Ce contrôle a tourné pendant les tests
étendus : ses durées sont diagnostiques et ne constituent pas un benchmark.

Preuves ignorées par Git :
`web/out/optimization-implementation-2026-10-05/bugs-ground/`, notamment
`verification-summary.json`, `root-integration-focused.*`,
`projection-focused.*`, `dpr1-v4/`, `dpr2-v4/`,
`native-root-sahel-fixed/`, `native-root-default-fixed/` et
`macro-current-diagnostic/model-parity.json`.

## Maisons coupées : rapport toujours ouvert

Les essais locaux de finition des toits ne sont pas livrés. Sur la
génération actuelle du cas muré seed 42, les huit maisons recensées restent
coupées : 279, 283, 471, 628, 676, 698, 700 et 766. Le modèle, les géométries et
les métadonnées restent exactement identiques avant/après cet essai, avec
1 080 bâtiments et 593 lots. L'amélioration d'un ancien World archivé ne prouve
donc aucune amélioration de cette génération actuelle.

Le diagnostic borné de déplacement rigide d'un seul toit voisin, sur les maisons
471 et 698, montre respectivement des refus physiques lors de la translation du
toit voisin et des collisions avec deux ou trois toits voisins. Il indique une
piste de repartition coordonnée de plusieurs
lots, ou d'intervention plus tôt dans la génération ; il ne prouve pas une
impossibilité géométrique. Les accès, la propriété et les murs physiques ne
doivent pas être sacrifiés pour rendre un toit carré.

Le texte original de l'utilisateur reste dans `BUGS.md`, accompagné d'un état
partiel. Aucun résultat expérimental sans gain sur la génération actuelle n'est
présenté comme un bug corrigé.
