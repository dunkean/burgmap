# Profiling — génération et affichage

5 octobre 2026 · code `a7974a1` · i7-10700K, 64 Gio, Windows 11, Node 24.10.0.
Génération : **3 processus neufs par scénario**. Affichage : **3 chargements par cas**,
Chromium 153, 1 400 × 900, DPR 1, OffscreenCanvas. Aucune optimisation du moteur appliquée.

## Plus gros blocs coûteux

| Priorité | Bloc | Coût mesuré | Piste à examiner ensuite |
| --- | --- | --- | --- |
| 1 | Réparation des toits : `finishEdgeRoofs` | 71,5 % du profil City ; 55,1 % du profil des 103 quartiers | Réduire les preuves géométriques répétées et les candidats à tester, en préservant les invariants |
| 2 | Sol urbain pendant `buildScene` | 14,24 s cumulées à 60k ; ~0,92 s par appel | Conserver les couches stables et mettre à jour les quartiers arrivés |
| 3 | Production du bitmap : `transferToImageBitmap` | 13,83 s cumulées à 60k ; ~0,89 s par appel | Examiner rasterisation/flush natifs avec une trace navigateur avant de choisir une modification |
| 4 | Sol rural, champs et chemins | 19,65 s du macro-plan 5 M ; 10,57 s dans les champs | Réduire les découpes et recherches spatiales sur la grande carte |
| 5 | Relief raster recréé pendant l’affichage | 6,67 s cumulées à 60k ; ~0,45 s par appel | Préserver ce bitmap lorsque seuls les quartiers changent |
| 6 | Parcelles et accès des quartiers | `cutPlots` 5,95 s ; `blockReach` 5,48 s dans le profil des 103 quartiers | Réduire les requêtes géométriques répétées |
| 7 | Érosion / relief de vallée | `mountainRelief` 1,75 s, 43,1 % du profil environnement vallée | Examiner les parcours de grille et les calculs de proximité |

Les temps imbriqués **ne s’additionnent pas**. Les pistes sont des décisions possibles,
pas des gains démontrés. Les références précises par cas suivent.

## Génération : temps par phase

Toutes les durées sont en secondes, médianes de 3 essais. Les phases ont leurs
propres médianes ; les petites phases site/routes/planner/noms ne figurent pas ici.

| Scénario | Total (s) | Min–max (s) | Terrain | Urbain / macro | Secondaires | Sol rural / naturel |
| --- | --- | --- | --- | --- | --- | --- |
| environment-flat | 1,70 | 1,58–1,70 | 1,41 | 0,00 | 0,00 | 0,27 |
| environment-valley | 3,56 | 3,36–3,69 | 3,23 | 0,00 | 0,00 | 0,33 |
| environment-mountains | 4,33 | 4,14–4,36 | 3,29 | 0,00 | 0,00 | 0,93 |
| hamlet | 1,53 | 1,46–1,62 | 0,84 | 0,11 | 0,00 | 0,31 |
| village | 2,54 | 2,48–2,58 | 1,00 | 0,35 | 0,00 | 0,49 |
| town | 9,10 | 8,79–9,32 | 1,16 | 5,87 | 0,19 | 0,97 |
| city | 45,60 | 44,79–50,35 | 1,39 | 40,13 | 0,18 | 2,46 |
| valley-city20k | 22,15 | 21,25–22,84 | 1,56 | 15,02 | 0,13 | 3,34 |
| open20k-10km | 45,04 | 43,82–47,39 | 2,94 | 33,29 | 0,91 | 5,67 |
| region-p4uefz | 46,05 | 43,44–46,53 | 2,48 | 36,27 | 0,89 | 4,59 |
| region-40km | 17,81 | 16,73–17,82 | 2,89 | 4,61 | 3,76 | 3,88 |
| medina | 5,01 | 4,87–5,07 | 1,10 | 1,71 | 0,21 | 1,14 |
| persian | 4,28 | 4,10–4,29 | 1,12 | 1,12 | 0,22 | 0,94 |
| capital | 5,25 | 5,22–5,34 | 1,67 | 0,48 | 0,00 | 2,06 |
| capital60k | 5,44 | 5,20–5,53 | 1,59 | 0,55 | 0,00 | 2,40 |
| mega5m | 26,78 | 26,01–28,58 | 3,15 | 2,17 | 0,00 | 19,65 |
| region-lazy | 45,36 | 40,95–46,14 | 2,56 | 36,55 | 0,00 | 4,37 |

Les cas `capital`, `capital60k` et `mega5m` mesurent le **macro-plan initial**,
pas toutes les maisons. À 60k, le détail des 103 quartiers demande ensuite
**48,65 s en séquentiel Node** (45,97–49,96 s),
pour 42 833 enregistrements de bâtiments. Dans le navigateur, ces calculs utilisent deux workers.
Les 9 détails secondaires de `region-lazy` représentent environ 0,9 s au total.

À 5 M, le sol rural se décompose en classification **4,29 s**, vectorisation
**4,61 s**, champs **10,57 s**, prétraitement **0,17 s** ; ces sous-phases appartiennent
aux 19,65 s du tableau. Seuls quelques quartiers de ce cas ont été détaillés.

## Génération : blocs CPU coûteux

Profils V8 séparés des essais chronométrés. Temps inclusifs pondérés par les
intervalles d’échantillonnage ; pourcentage du profil, avec son surcoût de capture.
Un enfant figure déjà dans le coût de son parent.

| Bloc coûteux | Cas | Temps inclusif CPU (s) | Part du profil |
| --- | --- | --- | --- |
| `finishEdgeRoofs` | City seed 4 | 37,64 | 71,5 % |
| `finishEdgeRoofs` | 20k, vallée ouverte, 10 km | 20,58 | 51,0 % |
| `finishEdgeRoofs` | Région p4uefz, secondaires différés | 26,70 | 63,8 % |
| `finishEdgeRoofs` | 103 quartiers de la capitale 60k | 28,57 | 55,1 % |
| `cutPlots` | 103 quartiers de la capitale 60k | 5,95 | 11,5 % |
| `blockReach` | 103 quartiers de la capitale 60k | 5,48 | 10,6 % |
| `generateRural` | Macro-plan 5 M | 18,18 | 69,0 % |
| `partitionRegion` | Macro-plan 5 M — champs | 6,38 | 24,2 % |
| `pruneWays` | Macro-plan 5 M — chemins agricoles | 3,91 | 14,8 % |
| `generateSettlementUrban` | Région 40 km — secondaires | 3,18 | 19,1 % |
| `finishEdgeRoofs` | Région 40 km | 3,64 | 21,8 % |
| `mountainRelief` | Environnement vallée 10 km | 1,75 | 43,1 % |
| `priorityFlood` | Environnement vallée 10 km | 0,32 | 7,8 % |
| `generateUrban` | Town persan | 1,20 | 28,7 % |

Les opérations de `polygon-clipping` dominent le temps propre : **29,9 %** du
profil City et **28,3 %** du profil des 103 quartiers. Le wrapper `geo/bool.ts`
représente respectivement **15,1 %** et **13,2 %** supplémentaires en temps propre.
La réparation de densité européenne coûte seulement ~16 ms sur City ; elle
n’explique pas le coût de ces quartiers. Le cas russe a été interrompu pour
clôturer rapidement et n’entre pas dans cette campagne.

## Affichage : capitale « Medieval organic »

Seed 1, preset `capital`, culture `european-organic`, paramètres d’affichage par défaut.
Le deuxième cas impose `population=60000`. Les images sont mesurées depuis
la navigation ; « complète » exige tous les quartiers dans la scène effectivement présentée.

| Cas | Quartiers | Plan initial (s) | Première image (s) | Image complète (s) | Min–max image complète | Contrôle publié (1 essai) |
| --- | --- | --- | --- | --- | --- | --- |
| Capitale par défaut : 50 611 hab. | 95 | 4,39 | 7,19 | 33,55 | 33,11–35,39 | 33,76 s |
| Population explicite : 60 000 hab. | 103 | 4,31 | 7,24 | 45,64 | 43,42–45,64 | 46,26 s |

Le délai après le plan initial vient **à la fois du calcul différé des quartiers
et des reconstructions du rendu**. À 60k, tous les résultats sont reçus vers
33,94 s (médiane), puis l’image complète apparaît vers 45,64 s. Aucun échec de
quartier ni erreur de page dans les six chargements.

### Blocs d’affichage coûteux à 60k

« Cumulé » = somme des appels pendant le chargement, puis médiane des 3 essais.
« Par appel » = médiane des appels de chaque essai, puis médiane des 3 essais.
Les workers se chevauchent et les lignes avec ↳ sont incluses dans leur parent.

| Bloc — capitale 60k | Travail cumulé (s) | Coût médian par appel (s) | Observation |
| --- | --- | --- | --- |
| Calcul des 103 quartiers | 54,29 | 0,24 | 2 workers ; fenêtre murale 29,40 s |
| Quartier le plus lent, id 58 | — | 11,57 | 723 bâtiments ; même quartier le plus lent dans les 3 essais |
| Reconstruction de scène | 18,36 | 1,16 | 15–16 reconstructions |
| ↳ Calcul des permissions de sol : `currentLandscapeGround` | 14,24 | 0,92 | Inclus dans la scène ; unions/différences géométriques |
| Frame complète du renderer | 23,06 | 1,49 | Dessin + bitmap + mini-carte |
| ↳ Dessin Canvas | 9,14 | 0,62 | Inclut le relief raster |
| ↳ `renderTerrainRaster` | 6,67 | 0,45 | 13–15 appels ; recalcul après remplacement du renderer |
| ↳ `transferToImageBitmap` | 13,83 | 0,89 | Coût absent du chrono actuel `st.ms` / `__perf.frames` |
| ↳ Mini-carte | 0,005 | 0,0003 | Environ 0,3 ms par appel |
| Réception du résultat d’un quartier | — | 0,006 | 5,6–6,1 ms médians ; pas le poste dominant |
| Présentation sur la page | 0,004 | 0,0003 | Environ 0,3 ms par bitmap |

À chaque lot de quartiers, [`onQuarters`](web/src/ui/renderWorker.ts) crée un
nouveau World et reconstruit la scène. Le cache du
[sol](web/src/gen/landuse/landscapeGround.ts) dépend du World ; le remplacement du
[CanvasRenderer](web/src/render/canvas.ts) réinitialise les caches de chemins et
de relief. Cela explique la répétition des gros blocs ci-dessus.
Le coût bitmap est une durée murale native : cette campagne headless ne sépare
pas CPU, GPU et attente de rasterisation.

## Taille des données et coût de scène initiale

Scènes mesurées dans Node, hors Canvas ; World initial sans ajout des quartiers différés.

| World initial | Scène froide / répétée (s) | Clonage (ms) | Binaire V8 (Mio) | RSS après génération (Mio) |
| --- | --- | --- | --- | --- |
| city | 0,54 / 0,17 | 134 | 18,9 | 489 |
| open20k-10km | 1,73 / 0,75 | 404 | 36,6 | 734 |
| capital60k | 0,75 / 0,22 | 77 | 20,0 | 445 |
| mega5m | 8,79 / 2,10 | 853 | 54,1 | 981 |

RSS = processus entier, pas taille minimale du World ni preuve de fuite.
Les exports complets, le fallback de rendu sur le thread principal et le DPR 2 restent hors mesure.

## État et preuves

- Tout était committé et poussé avant les mesures ; seul le worktree principal reste enregistré.
  Les deux fichiers de cache de l’ancien worktree ont été archivés hors du dépôt.
- [GitHub Pages](https://dunkean.github.io/burgmap/) publie le code audité :
  `gh-pages` `49a0213`. Le HTML servi correspond exactement au build de contrôle.
- Harnais conservés : [génération](web/scripts/audit_generation.ts),
  [affichage](web/scripts/audit_display.mjs). Queries exactes dans ces scripts.
- JSON, profils CPU, Worlds et captures locaux : `web/out/optimization-audit-2026-10-05/`
  (ignoré par Git ; junction vers `E:/CodexArtifacts/city-generator-2026-10-04/root-out/`).
- Essais écartés : chevauchement initial City/publication, alias russe invalide,
  première condition d’affichage qui s’arrêtait avant l’incorporation des derniers quartiers.
  Les tableaux utilisent les essais corrigés. Les anciens hashes binaires V8 ne sont pas
  des preuves d’équivalence ; les temps sont pris avant hashing/clonage/sérialisation.
- Validation : typecheck et build de production réussis ; sources du moteur inchangées.
  Les 6 captures navigateur se terminent avec tous les quartiers, sans erreur.

Ces mesures couvrent 17 scénarios, avec une seule seed par scénario et les autres
applications Windows ouvertes. Elles localisent les coûts sur ces cas précis.
