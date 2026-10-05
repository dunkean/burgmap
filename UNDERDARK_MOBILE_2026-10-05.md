# Underdark et cadres sur petits écrans

## Interface compacte

Les cartouches interactifs avaient des dimensions fixes : titre de 244×104 px
et légende pouvant dépasser 330 px de large. Sur téléphone, ils occupaient
presque toute la largeur de la carte.

Lorsque la zone de dessin est étroite ou peu haute, les grands cartouches
passent dans **Map info**, accessible dans la barre d'outils. La carte conserve
une petite échelle liée au zoom. Le dialogue reprend les mêmes symboles et
couleurs que le renderer, avec le titre, la population et la semence. Il suit
la carte effectivement présentée, y compris pendant une nouvelle génération.
Fit, Pin et la minicarte restent accessibles ; le HUD de diagnostic est masqué
sur les petits écrans. Les exports gardent leurs cartouches habituels.

## Paysage et implantations

Le biome `underdark` décrit le sol d'un bassin souterrain : roche, eaux
souterraines, fonges humides et cultures fongiques près des implantations.
La couverture naturelle et l'agriculture ont des classifications séparées.
Les paramètres de biome et de culture restent indépendants et sont conservés
dans les liens et exports.

Trois cultures sont ajoutées :

- `drow-enclave` : enclave dense, cours et sanctuaires de pierre sombre ;
- `duergar-hold` : grands halls, forges et fortifications compactes ;
- `myconid-colony` : habitat fongique arrondi et implantation ouverte.

Les cultures existantes gardent leurs recettes. SVG et Canvas partagent la
palette et les motifs souterrains. Underdark utilise ses motifs vectoriels
également lorsque les textures peintes sont activées ; les atlas de plantes
de surface restent réservés à leurs six biomes.

## Validation et publication

Les groupes ciblés passent : 21 tests de génération Underdark, 23 tests de
rendu/Workers/interface, 14 tests d'information et de présentation des frames,
et les quatre tests de biomes existants (60 tests distincts, deux communs aux
groupes d'interface). Typecheck et le build autonome passent.

Les six Worlds de surface et les recettes existantes sont identiques au
checkpoint `daba01b`. La correction de géométrie duergar est locale : un retrait
de 2 cm traite un cas numérique ambigu, uniquement si les contrôles prouvent
que le nouveau toit reste dans l'ancien et dans son lot. Le témoin seed 42 et
son assertion de containment stricte sont conservés.

Les preuves locales sont dans `web/out/underdark-2026-10-05/` et
`web/out/underdark-mobile-2026-10-05/`. Ces contrôles ciblés ne certifient pas
une suite complète verte ; les limites antérieures restent documentées.

Cinq cas natifs passent sur le HTML final : carte classique en offscreen et
main (portrait, paysage puis bureau), et les trois cultures souterraines.
Map info s'ouvre et se ferme sans régénération ; les exports conservent leurs
cartouches. Les deux SVG classiques sont identiques octet pour octet à la
publication précédente. Aucune erreur JavaScript n'est observée.

Le harnais attend une nouvelle frame présentée et ses dimensions CSS après
rotation. Les attributs width/height du canvas bitmaprenderer restent ceux
du canvas initial dans Chromium et ne constituent pas un oracle de resize.
L'attente de fermeture du dialogue inclut également son événement close.
