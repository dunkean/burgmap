Lancer le serveur : python -m uvicorn town_generator.webapp.app:app --host 127.0.0.1 --port 9000 --reload
Ouvrir http://127.0.0.1:9000/tools/geology/
Tester chaque taille (hameau -> agglo) avec seed=42
Verifier les 3 vues (elevation, topo, biomes)
Tester avec/sans cote, 0-4 rivieres, avec/sans lacs, relief/plaine
Verifier que les rivieres ont des meandres et largeur variable
Verifier que les courbes de niveau sont correctes (lignes fermees, pas de croisements)
Verifier le determinisme : meme seed = meme resultat
python -m pytest tests/ -x -q pour ne pas casser les tests existants