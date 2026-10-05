# Bugs and feedback

## How to report a bug (optional helper)

1. Open the map that shows the problem (any seed, size, culture, style).
2. Move the mouse to the spot: the corner readout shows its map coordinates in meters (x, y from the top-left) and the zoom.
3. Drop a pin on each problem place: use the "Pin" button (or Alt-click), then type a short note in the popover. Pins are listed in the "Pins" panel section.
4. Press "Copy bug report" and paste the result here (or to the agent). It holds the link (options, pins and view), the seed and options, the pins with coordinates and notes, and the command that reproduces each spot:
   `npm run preview:png -- --seed S --size Z --opt k=v --crop x,y,w --out out/bug.png`
5. "Copy link" alone shares the exact map, the pins and the view (`pins=x,y,note;...&view=cx,cy,scale`). Pins and the view never change the generation.

Agents: fix the open reports; parallel work is allowed. Remove a report after its fix passes the required code reviews, tests and visual checks. Keep outstanding user text unchanged.

## List (written by the user)

- Le problème de démarcation ville environnement vient de la ligne noire autour de la ville. Elle sert à rien vire là. Idem por les hameaux et extensions et le fait que les maison qui devraient être carrés soient coupés à la frontiere de la ville. Il faut garder le carré de la maison et qu'il déborde sur l'extérieur. En fait la fille avec enceinte coupe les maisons, celle sans, ne les coupe pas. Et tu remplis systématiquement les quatrier de gardens/yards et de fait le background est tout vert et ca peut choquer. Il serait bien que quelques quartier de la périphérique soit avec un background équivalent à lenvironnement. Regarde ce que tu peux faire pour améliorer ce visuel. Les background de jardins dans les villes doivent vraiment globalement être dans le style du biome. Par exemple une ville desertique comme tombouctou semble être construite à meme le desert. Vue de dessus, la ville ne se découpe pas, on ne voit que les maisons. J'aimerai qu'on puisse retrouver ca selon le biome et le type de ville. (Un citadelle est marquée parce que pavée ou autre, une tribu indienne dans la plain non, etc. etc.)

État partiel du 2026-10-05 : bordures administratives supprimées et sols adaptés
au biome/type d'implantation (`ad6e32a`, projection des Workers corrigée dans
`f842f9b`). Revues, tests ciblés, captures SVG/Canvas DPR 1/2 et contrôles natifs
offscreen/main/offline réussis. Les murs physiques et jardins irrigués restent
préservés. Les maisons coupées restent ouvertes : huit dans la génération
actuelle du cas muré seed 42 ; les essais locaux ne donnent aucun gain
et ne sont pas intégrés. Voir [les résultats et limites](BUGFIXES_VISUAL_2026-10-05.md).
