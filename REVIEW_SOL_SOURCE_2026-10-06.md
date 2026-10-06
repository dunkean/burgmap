# Confirmation de la source intégrée

Une revue Sol xhigh a examiné le bloc intégré `4b44ae4` et demandé les corrections de validation des pièces, d'accès, de croissance lazy et de repli des intersections. Les corrections ont été intégrées et couvertes par leurs régressions.

Une confirmation ciblée et en lecture seule par **Sol xhigh en CLI** a ensuite porté sur `19c4d50`, particulièrement `footprintFinal.ts`, `roomReconstruct.ts` et les gardes de `edgeFinish.ts`. Verdict : **APPROVE**, aucun blocage matériel trouvé dans ce bloc. Elle couvre les transactions de jardins/terrain libéré, le propriétaire, les voisins, les obstacles physiques, les accès, les cours et les extrémités libres.

## Source finale intégrée

Les confirmations suivantes ont identifié puis fait corriger trois problèmes matériels : les pièces retenues après séparation devaient toutes être vérifiées contre les toits voisins ; une ruelle privée devait partager une véritable arête publique sur sa largeur, sans un recul de quelques millimètres ; les pertes de surface de plusieurs réparations devaient être comptabilisées cumulativement.

Sol xhigh a validé le bloc intégré `275280c`, puis la source `3da0804` : **APPROVE**, aucun blocage matériel dans le contexte fourni. Cette dernière confirmation conserve une réserve uniforme de 97 % de la surface logement au début de la passe et 98 % du nombre de logements lors des retraits. Le seuil de 97 % est un choix de réparation ; il ne signifie pas 97 ou 98 % de la surface d'un ancien producteur. Les candidats reconstruits gardent leurs critères habituels. Seuls les petits toits existants presque triangulaires et plausibles bénéficient d'une protection spécifique, avec absence de collision et preuve d'accès.

Le contexte de revue a été extrait de la révision indiquée, dans le checkout intégré. La revue CLI était limitée au texte fourni et n'a pas exécuté les tests : la validation native et la suite complète restent des preuves séparées. Les sorties de confirmation sont conservées dans `web/out/approved-sol-review.txt` et `web/out/approved-sol-review.jsonl` du checkout de validation.

La revue unique Opus 5.5 reste [REVIEW_OPUS_GLOBAL_2026-10-06.md](REVIEW_OPUS_GLOBAL_2026-10-06.md). Les revues portent sur la correction du code ; elles ne prouvent pas à elles seules l'absence de formes résiduelles sur toutes les cartes. Les audits géométriques et visuels sont consignés séparément.

## Ajustement après comparaison exhaustive

La source intégrée inclut ensuite `f5ecca0`, correction ciblée du repère des parcelles, examinée par l'agent principal et couverte par les régressions `8d1df55`. La recherche de contact ne laisse plus une petite ruelle cacher la vraie façade d'une grande rue ; les côtés suivent une façade fragmentée jusqu'au tournant intérieur au lieu d'adopter sa tangente. Les contrôles natifs restaurent les six maisons chinoises et la maison iroquoise entière, avec les invariants culturels et d'accès inchangés. Les critères de candidats, propriétaires, obstacles et budgets de la passe finale restent identiques. Cette correction n'a pas fait l'objet d'une nouvelle revue Opus ou d'une nouvelle confirmation Sol xhigh. Les preuves de tests et de navigateur sont détaillées dans [FIXES_GLOBAUX_2026-10-06.md](FIXES_GLOBAUX_2026-10-06.md).
