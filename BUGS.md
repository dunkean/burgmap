# Bugs and feedback

## How to report a bug (optional helper)

1. Open the map that shows the problem (any seed, size, culture, style).
2. Move the mouse to the spot: the corner readout shows its map coordinates in meters (x, y from the top-left) and the zoom.
3. Drop a pin on each problem place: use the "Pin" button (or Alt-click), then type a short note in the popover. Pins are listed in the "Pins" panel section.
4. Press "Copy bug report" and paste the result here (or to the agent). It holds the link (options, pins and view), the seed and options, the pins with coordinates and notes, and the command that reproduces each spot:
   `npm run preview:png -- --seed S --size Z --opt k=v --crop x,y,w --out out/bug.png`
5. "Copy link" alone shares the exact map, the pins and the view (`pins=x,y,note;...&view=cx,cy,scale`). Pins and the view never change the generation.

Agents: fix entries in order, then mark each one fixed with the commit hash (e.g. `→ fixed in abc1234`). Never delete or rewrite the user's text.

## List (written by the user)

- La légende n'apparait plus → fixed in 2f65f13
- Les shanty towns doivent avoir des formes de maison/tentes plus réalistes → fixed in 264fc02
- Quand il n'y a pas de rue qui séparent des zones de batiments, la jointure entre les zones produit des batiments qui s'overlap parfois ou qui on des formes vraiment bizarres. Il faut ptet merge les zones avant de mettre les batiments ou trouver une heuristique pour adapter la forme ou eviter l'overlap. (testé en "medieval organic") → fixed in 0b8b5b9 (seed=p4uefz, size=city: retain earlier riverbank districts in later enclosures; quarters and buildings in separate blocks no longer overlap)
- Il faut ajouter des biomes (désert, foret, etc.) → fixed in 1508eb4 (six selectable biomes; climate/water-aware land use, SVG/Canvas palettes, share links and visual/UI checks)
- les douves autour de "chinese walled city" en bleu, coupent tout n'importe comment. D'ailleurs douves devrait être une option mais bien pensée. La c'est un polygone border bleu qui entoure géométriquement la ville au dessus de tout les autres objets. Autre choses, certains quartier en "chinese" sont quasi vide et identiques, c'est bizarre. → fixed in 6f78c19, d0b5f99, 5dd7025 (optional exterior moats and accessible, varied siheyuan wards; reviewed code/visuals, 46 final targeted tests and browser checks)
- "japanese castle town" (seed=p4uefz&size=city&culture=japanese-jokamachi&legend=1): j'ai des surface totalement vide (que relief) collées à la ville. Est-ce normal ? (idem en seed=p4uefz&size=city&culture=roman-core&legend=1 et peut être d'autres) → fixed in 0340ace, 01171fe (unserved reserve released; connected merchant roji fill the crescent and western ward; Roman riverbank gardens verified intentional)
- En mode inca, le rendu des terrasses est dégueulasse. Il faut le revoir → fixed in 84543a1, 9980f54
- Retire les "up to metropolis", il faudra que tout marche → fixed in 5ccbc5e (caps removed on every preset; camp cultures grow into clusters, d48b251)
- "Venitian lagoon" certaines rivieres ne sont pas connectés à rien → fixed in e2c4514 (all canal components reach natural water; short shore outlets and dry bridge landings preserve access)
- "Stilt town" se construit au dessus des rivieres et tout. Il faut quand meme adapter au relief/eau → fixed in 4a4e493 (shore-adapted quarters, open navigation channels, connected terrain-safe boardwalks and local council platform; reviewed geometry and visuals)
- "barbarian (germanic village)" est hideux. Les patatoides font tout la meme taille, les maison sont trop similaire, la cloture est trop géometrique au rendu on dirait des patates. → fixed in d48b251
- En fait tous les barbarian sont médiocres (le sol est un patch marron), on a 4 fois le meme village. Il faut raffiner et adapter à l'environnement, et revoir la diversité et le rendu → fixed in d48b251, 4d99db4, a728b3b
- Idem "North Ring": il faut arreter de copier le meme style poru les villages périphérique. comme les tribus. Soit y a de la diversité, soit y en a qu'un seul, idem pour Kraal, Native American → fixed in d48b251, 87065a2
- Maya city, rendu horrible - rien de va. cest pas fini ni testé comme boulot Idem pour Khmer, Celtic oppidum, Halfling Shire, Native Americans (les deux) → fixed in 4d99db4, 415772a, 87065a2, d9294b9
- orcish war camp merite une meilleur texture sous les tentes → fixed in 264fc02
- Entre certains champs y a un trait vert, c'est pas beau et trop visible.
- Les traits de terrasses sont pas jolis non 
- dans les open town, il faut que la frontière ne soit pas tracée nette. Mais que les maison déborde hors du cadre de la ville un peu.
- Les cultures qui sont faites pour être en tribus (genre nordic), lorsqu'on demande du gros, il faut faire une ville primitive au lieu des tribus. En gros on adapte l'archi urbaine à la taille de la pop + culture