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

- Les cultures qui sont faites pour être en tribus (genre nordic), lorsqu'on demande du gros, il faut faire une ville primitive au lieu des tribus. En gros on adapte l'archi urbaine à la taille de la pop + culture
- sans town wall, le tour des villes est vraiment pas beau à cause de la couleur uniforme du background des quartiers. Sur les quatiers periphériques ca serait bien que le rendu "hors ville" se merge ou remplace le fond de texture des quarties.
- Les estuaires ont toujours une forme arrondi. Il faut plus de diversité donc juste un élargement de la riviere.
- De très nimbreux town plan construire les quartiers sur l'eau sans en tenir compte. Il faut corriger
- pouvoir choisir le centroid de la ville (et potentiellement de villages autour)
- lignes de contours et interne des champs scale avec la taille de l'image. Sur de très grande map ca devient hideux.