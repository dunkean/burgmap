# Magna Urbis

**Magna Urbis est inspiré de [TownGeneratorOS de Watabou (Oleg Dolya)](https://github.com/watabou/TownGeneratorOS) et de son [Medieval Fantasy City Generator](https://watabou.itch.io/medieval-fantasy-city-generator).** Le premier prototype Python est issu d'un port de TownGeneratorOS ; les implémentations TypeScript et Rust poursuivent cette exploration.

**Projet en cours de développement · alpha · prototype.** Magna Urbis génère des implantations pré-modernes et leurs paysages pour la cartographie et le jeu de rôle. Les résultats, les performances et les interfaces évoluent encore : le projet n'est pas un logiciel achevé.

Deux implémentations sont en développement : **TypeScript**, aujourd'hui la plus complète, et **Rust / WebAssembly**, encore en retard sur son périmètre fonctionnel mais qui le rattrape progressivement.

À terme, **Magna Urbis sera intégré à [Neural Earth](https://github.com/dunkean/neural-earth)**, le projet de monde procédural développé dans Infinite Map, pour inscrire les villes et villages dans un paysage régional et planétaire. Cette intégration est un objectif futur ; elle n'est pas encore livrée.

## Aperçus du prototype

Captures réelles de l'application TypeScript : trois villes de 30 000 habitants et un village de 600 habitants. Elles illustrent différentes morphologies urbaines et les rendus **Parchemin** et **Atlas**, avec les imperfections actuelles du prototype.

### Ville médiévale · Parchemin

![Ville médiévale et rivière, rendu Parchemin](docs/images/medieval-city.png)

### Médina dans le désert · Atlas

![Médina dans un paysage désertique, rendu Atlas](docs/images/desert-medina.png)

### Ville chinoise planifiée · Atlas

![Ville chinoise planifiée, rendu Atlas](docs/images/chinese-city.png)

### Village et campagne · Parchemin

![Village entouré de campagne, rendu Parchemin](docs/images/village.png)

Les [graines, réglages et vues des captures](docs/images/screenshots.json) permettent de reproduire ces exemples avec la version correspondante. Rust ne génère pas encore ces villes.

## TypeScript et Rust

| | TypeScript · `web/` | Rust / WASM · `rust/` |
| --- | --- | --- |
| État | Prototype le plus complet, application de référence | Nouveau moteur en cours de développement |
| Paysage | Relief, biomes, côtes, cours d'eau, lacs et occupation rurale | Relief, érosion, côtes, lacs et réseaux de rivières |
| Implantations | Hameaux, villages, villes ; quartiers, rues, parcelles, bâtiments et monuments | Génération urbaine encore à développer |
| Interface | Carte interactive, paramètres, graines, partage et exports SVG / PNG / JSON | Intégration navigateur en cours |
| Calcul | TypeScript dans le navigateur, sans serveur de génération | Rust compilé en WebAssembly, avec des chemins WebGPU selon les étapes |

TypeScript explore les tracés organiques, les bastides, les médinas, les plans chinois et japonais, ainsi que des cultures fantastiques. Plusieurs cultures peuvent se combiner au fil des phases de croissance. Les grandes populations et leur détail progressif restent expérimentaux.

Rust porte progressivement la génération vers un nouveau moteur. Les performances et la précision dépendent encore des grilles de calcul, du relief et des capacités CPU/GPU du navigateur. Il n'est pas encore un remplacement complet de TypeScript.

L'interface actuelle doit être conservée à terme. Le rendu existant est une aide d'intégration provisoire ; le futur moteur de rendu reste à développer.

## Lancer l'application TypeScript

Prérequis : Node.js LTS récent et npm.

```sh
cd web
npm ci
npm run dev
```

Ouvrir l'adresse indiquée par Vite, généralement **http://localhost:5173/**. Choisir l'environnement, puis les implantations, leur population et leur culture. Générer la carte et explorer au zoom. Une graine et les mêmes paramètres reproduisent une génération pour une même version du moteur.

```sh
npm run build
```

Le build produit `web/dist/index.html`, une page autonome utilisable hors ligne. Le développement et le build TypeScript ne nécessitent pas Rust.

## Développer le moteur Rust

Installer la toolchain définie dans `rust/rust-toolchain.toml`, la cible `wasm32-unknown-unknown` et `wasm-pack`. Sous Windows, prévoir les outils de compilation C++ de Visual Studio et le SDK Windows.

Après installation des dépendances npm, depuis `web/` :

```sh
npm run wasm:terrain   # Compiler le module WebAssembly
npm run check:terrain  # Vérifier le code Rust et sa compilation WASM
```

Les modules générés restent dans `rust/pkg/wasm/`, ignoré par Git. Voir le [README Rust](rust/README.md) pour l'organisation du moteur.

## Organisation

```text
web/src/gen/      Génération TypeScript
web/src/render/   Rendu SVG et Canvas actuel
web/src/ui/       Interface et workers
web/tests/        Tests TypeScript
web/scripts/      Captures et outils de vérification
rust/crates/core/ Moteur Rust sans navigateur
rust/crates/wasm/ Bindings WebAssembly
rust/bridge/      Adaptateurs temporaires vers l'interface et le rendu
rust/scripts/     Commandes Rust
town_generator/  Ancien prototype Python, conservé comme référence
tests/           Tests du prototype Python
docs/images/     Captures du README et réglages de reproduction
```

Le prototype Python est historique ; il ne constitue pas un troisième moteur actif.

## Contribuer

Depuis `web/`, `npm run typecheck`, `npm run test:fast` et `npm run build` permettent de vérifier les modifications. `npm test` inclut la matrice exhaustive des villes et cultures et peut prendre plusieurs dizaines de minutes.

Pour signaler un problème, joindre la version, la graine, les paramètres et le lien de partage, avec une capture si possible. L'application propose des pins et la copie d'un rapport de bug. Les formats, résultats et liens peuvent évoluer pendant cette alpha.

## Crédits et licence

Merci à **Watabou** pour TownGeneratorOS et Medieval Fantasy City Generator, à l'origine de ce projet et toujours une référence majeure.

Magna Urbis est distribué sous la **GNU GPL v3** ; voir [LICENSE](LICENSE). Le prototype Python conserve sa filiation avec TownGeneratorOS. Les ressources et dépendances tierces gardent leurs propres notices de licence et de provenance.
