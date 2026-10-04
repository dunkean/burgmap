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

- Le problème de démarcation ville environnement vient de la ligne noire autour de la ville. Elle sert à rien vire là. Idem por les hameaux et extensions et le fait que les maison qui devraient être carrés soient coupés à la frontiere de la ville. Il faut garder le carré de la maison et qu'il déborde sur l'extérieur. En fait la fille avec enceinte coupe les maisons, celle sans, ne les coupe pas.
- Les maison le long de la route à la sortie des villes sont le long d'une bande et la connection avec la ville ne se fait pas, il faudrait joindre les aires. De meme, il devrait y avoir des cas ou les excroisssance de la cité le long de la route n'existent pas (ou pas sur toutes les routes)
- Le fait que le sol conserve la couleur de l'environnement ne marche pas avec toutes les villes. Par exemple avec wizard city. Check tous les modèles. Je veux pas que ca soit transparent, mais que ca donne pas l'impression d'une frontiere découpée, faut que la ville et l'environnment s'intègre naturellement, la vraiment c'est comme si c'était découpé et collé. Il faut vraiment travailler ca
- Les ports sont encore trop absent qu'and y a une cote.
- Les shantis towns sont hideuses, souvent trop géométrique et background blanc ca va pas !