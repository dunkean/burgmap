/**
 * Syllable / morpheme grammars for toponyms, one per language family.
 * Everything is generated from small morpheme tables and phonotactic joins (no lists of real places);
 * only tiny closed vocabularies (saints, crafts, compass words, street nouns) are listed.
 */
import type { Rng } from '../core/rng';
import type { NameFamily } from './types';

const VOW = 'aeiouyàâäéèêëîïôöùûüœ';
const isV = (c: string | undefined): boolean => !!c && VOW.includes(c.toLowerCase());
export const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Join two morphemes, smoothing vowel clashes and doubled letters. */
export function join(a: string, b: string): string {
  if (isV(a[a.length - 1]) && isV(b[0]) && b.length > 1) b = b.slice(1);
  if (a[a.length - 1] === b[0]) b = b.slice(1);
  return a + b;
}
/** Weighted pick. */
function w<T>(r: Rng, xs: readonly (readonly [T, number])[]): T {
  let tot = 0;
  for (const [, k] of xs) tot += k;
  let x = r.float() * tot;
  for (const [v, k] of xs) { x -= k; if (x <= 0) return v; }
  return xs[xs.length - 1][0];
}
/** Consonant-vowel(-coda) syllable. */
function syll(r: Rng, onsets: readonly string[], vowels: readonly string[], codas: readonly string[] = [''], pCoda = 0.3): string {
  return r.pick(onsets) + r.pick(vowels) + (r.chance(pCoda) ? r.pick(codas) : '');
}
/** stem + ending from two morpheme tables. */
const compose = (r: Rng, stems: readonly string[], ends: readonly string[]): string => {
  let s = '';
  for (let a = 0; a < 5; a++) { s = cap(join(r.pick(stems).toLowerCase(), r.pick(ends))); if (s.length >= 5) break; }
  return s;
};

export interface StreetVocab {
  main: string[]; market: string[]; ring: string[]; wall: string[]; quay: string[]; bridge: string[]; riverside: string[];
  church(s: string): string; dest(p: string): string; gate(p: string): string; craft(word: string): string; minor(r: Rng): string; road(p: string): string;
}
export interface Vocab {
  /** tier 0 = town, 1 = village, 2 = hamlet / farm cluster */
  place(r: Rng, tier: 0 | 1 | 2): string;
  /** Dedication: a saint in Europe, a deity / ancestor elsewhere. */
  saint(r: Rng): string;
  /** Bare river name. */
  water(r: Rng): string;
  /** Decorate a town name with its river ("Verdun-sur-Loire"), optional. */
  town?(base: string, river: string, r: Rng): string;
  old: string[];
  /** Quarter name for phase kind ring | edge | faubourg | village. */
  ward(r: Rng, kind: string, saint: string, dir: string, craft: string): string;
  /** N E S W */
  dirs: [string, string, string, string];
  /** craft id -> word used in street / quarter names. */
  crafts: Record<string, string>;
  st: StreetVocab;
  sq: { market: string[]; green: string[]; plain(r: Rng, saint: string): string; church(saint: string): string };
  worship(saint: string, big: boolean): string;
  castle(name: string): string;
  river(n: string): string; lake(n: string): string; sea(n: string): string; forest(n: string): string; hill(n: string): string; farm(n: string): string;
  gateDir(d: string): string;
  /** Gate named after the town the road leads to (optional; default "<p> Gate"). */
  gateOf?(p: string): string;
  /** Settlement class words: hamlet, village, market town, town, city. */
  class: [string, string, string, string, string];
}

/* ------------------------------------------------------------------ French */
const frDe = (n: string): string => (isV(n[0]) || n[0] === 'H' ? `d'${n}` : `de ${n}`);
const FR_SAINTS = ['Martin', 'Pierre', 'Jean', 'Étienne', 'Michel', 'Nicolas', 'Léger', 'Maurice', 'Denis', 'Sulpice', 'Médard', 'Laurent', 'Germain', 'Hilaire', 'Aubin', 'Rémy', 'Georges', 'Julien', 'Éloi', 'Benoît', 'Vincent', 'Saturnin', 'Marie', 'Anne', 'Catherine', 'Madeleine', 'Foy', 'Geneviève', 'Radegonde'];
const FR_FEM = new Set(['Marie', 'Anne', 'Catherine', 'Madeleine', 'Foy', 'Geneviève', 'Radegonde']);
const frSaint = (s: string): string => (FR_FEM.has(s) ? 'Sainte-' : 'Saint-') + s;
const FR_STEMS = ['Aub', 'Mor', 'Vern', 'Sanc', 'Cla', 'Lor', 'Bré', 'Chau', 'Mar', 'Bess', 'Rou', 'Gren', 'Ange', 'Verd', 'Ponc', 'Bour', 'Cam', 'Lan', 'Sau', 'Tour', 'Vil', 'Nev', 'Dam', 'Fon', 'Cor', 'Ber', 'Cha'];
const FR_ENDS = ['ac', 'ay', 'y', 'ières', 'ville', 'court', 'mont', 'val', 'eil', 'ens', 'on', 'igny', 'ère', 'ois', 'ange', 'ain', 'elles', 'as'];
const french: Vocab = {
  place(r, tier) {
    const p = w(r, [['se', 6], ['an', 3], ['sa', tier ? 2 : 0.6]] as const);
    if (p === 'se') return compose(r, FR_STEMS, FR_ENDS);
    if (p === 'an') {
      const adj = ['Beau', 'Bel', 'Haut', 'Bas', 'Neuf', 'Vieux', 'Grand', 'Petit', 'Clair', 'Fort'];
      const noun = ['mont', 'fontaine', 'val', 'pré', 'bois', 'roche', 'lac', 'port', 'champ', 'pont', 'bourg', 'château', 'mare', 'gué'];
      return compose(r, adj, noun);
    }
    return frSaint(r.pick(FR_SAINTS)) + (r.chance(0.35) ? '-' + compose(r, FR_STEMS, FR_ENDS) : '');
  },
  saint: (r) => r.pick(FR_SAINTS),
  water: (r) => compose(r, ['Sev', 'Loi', 'Mar', 'Ois', 'Vil', 'Aur', 'Ren', 'Sar', 'Drô', 'Gar', 'Ill', 'Lot', 'Vie'], ['re', 'ne', 'se', 'ron', 'y', 'ère', 'onne', 'ance', 'ain']),
  town: (b, rv, r) => (r.chance(0.35) ? `${b}-sur-${rv}` : b),
  old: ['Le Vieux-Bourg', 'La Cité', 'Le Bourg'],
  ward(r, kind, s, dir, craft) {
    if (kind === 'faubourg') return r.chance(0.5) ? `Faubourg ${frSaint(s)}` : `Faubourg ${dir}`;
    if (kind === 'village') return `Hameau ${frSaint(s)}`;
    return w(r, [[`Quartier ${frSaint(s)}`, 3], [`Quartier des ${craft}`, 3], ['Bourg-Neuf', 1], ['La Basse-Ville', 1], [`Le Clos ${frSaint(s)}`, 1]]);
  },
  dirs: ['du Nord', "de l'Est", 'du Sud', "de l'Ouest"],
  crafts: { tanner: 'Tanneurs', dyer: 'Teinturiers', smith: 'Forgerons', baker: 'Boulangers', fisher: 'Pêcheurs', potter: 'Potiers', weaver: 'Tisserands', mason: 'Maçons', butcher: 'Bouchers' },
  st: {
    main: ['Grand-Rue', 'Rue Maîtresse', 'Rue Principale'], market: ['Rue du Marché', 'Rue de la Halle'],
    ring: ['Rue des Fossés', 'Rue des Remparts', 'Rue de la Ceinture'], wall: ['Rue des Murs', 'Chemin de Ronde'],
    quay: ['Quai du Port', "Quai de l'Eau"], bridge: ['Rue du Pont', 'Rue du Vieux-Pont'], riverside: ['Rue de la Rivière', 'Rue du Gué', 'Rue des Lavoirs'],
    church: (s) => `Rue ${frSaint(s)}`, dest: (p) => `Rue ${frDe(p)}`, gate: (p) => `Rue de la Porte ${frDe(p)}`,
    craft: (x) => `Rue des ${x}`, road: (p) => `Route ${frDe(p)}`,
    minor(r) {
      const adj = ['Haute', 'Basse', 'Vieille', 'Neuve', 'Petite', 'Longue', 'Étroite', 'Tortueuse', 'Sombre'];
      const n = ['du Puits', 'des Tilleuls', 'du Four', 'des Écoles', 'du Moulin', 'de la Fontaine', 'des Jardins', 'du Cloître', "de l'Abreuvoir", 'des Champs'];
      return r.chance(0.5) ? `Rue ${r.pick(adj)}` : `Rue ${r.pick(n)}`;
    },
  },
  sq: { market: ['Place du Marché', 'Place de la Halle'], green: ['Le Pré', 'La Place Verte'], plain: (_r, s) => `Place ${frSaint(s)}`, church: (s) => `Parvis ${frSaint(s)}` },
  worship: (s, big) => (big ? `Cathédrale ${frSaint(s)}` : `Église ${frSaint(s)}`),
  castle: (n) => `Château ${frDe(n)}`,
  river: (n) => n, lake: (n) => `Étang ${frDe(n)}`, sea: (n) => `Mer ${frDe(n)}`, forest: (n) => `Forêt ${frDe(n)}`, hill: (n) => `Mont ${n}`, farm: (n) => `Ferme ${frDe(n)}`,
  gateDir: (d) => `Porte ${d}`,
  gateOf: (p) => `Porte ${frDe(p)}`,
  class: ['Hameau', 'Village', 'Bourg', 'Ville', 'Cité'],
};

/* ----------------------------------------------------------------- English */
const EN_SAINTS = ['Mary', 'Peter', 'Paul', 'Michael', 'Nicholas', 'Giles', 'Andrew', 'Swithun', 'Oswald', 'Cuthbert', 'Edmund', 'Alban', 'Wilfrid', 'Botolph', 'Helen', 'Margaret', 'Chad', 'Bride', 'Martin', 'John'];
const english: Vocab = {
  place(r, tier) {
    const base = compose(r,
      ['Ash', 'Ox', 'Wick', 'Bram', 'Thorn', 'Stan', 'Win', 'Hex', 'Dor', 'Kin', 'Nor', 'Sud', 'Ast', 'Bed', 'Cal', 'Brad', 'Wen', 'Mal', 'Lud', 'Hart', 'Ald', 'Pen', 'Ket', 'Wor', 'Tam', 'Elm', 'Sax', 'Cran', 'Holm'],
      ['ford', 'ton', 'ham', 'bury', 'wick', 'by', 'stead', 'worth', 'ley', 'field', 'minster', 'mouth', 'bridge', 'combe', 'hurst', 'thorpe', 'well', 'wood', 'cester', 'ing', 'den', 'shaw']);
    const pre = tier ? w(r, [['', 6], ['Little ', 2], ['Upper ', 1], ['Nether ', 1], ['Great ', 1], ['West ', 1]] as const) : w(r, [['', 8], ['Market ', 1], ["King's ", 1]] as const);
    return pre + base;
  },
  saint: (r) => r.pick(EN_SAINTS),
  water: (r) => compose(r, ['Av', 'Ex', 'Tam', 'Wen', 'Sev', 'Ous', 'Kel', 'Tren', 'Wy', 'Ald', 'Cam', 'Ter', 'Nen', 'Wey', 'Dov'], ['on', 'e', 'wen', 'er', 'el', 'ey', 'ley', 'ern']),
  town: (b, rv, r) => (r.chance(0.3) ? `${b}-upon-${rv}` : b),
  old: ['Old Town', 'The Borough', 'The Burh'],
  ward(r, kind, s, dir, craft) {
    if (kind === 'faubourg') return r.chance(0.5) ? `St ${s}'s Suburb` : `${dir} Suburb`;
    if (kind === 'village') return `${s} End`;
    return w(r, [[`St ${s}'s Ward`, 3], [`${craft} Quarter`, 3], ['Newtown', 1], ['The Bailey', 1], [`${dir} Ward`, 2]]);
  },
  dirs: ['North', 'East', 'South', 'West'],
  crafts: { tanner: 'Tanners', dyer: 'Dyers', smith: 'Smiths', baker: 'Bakers', fisher: 'Fishers', potter: 'Potters', weaver: 'Weavers', mason: 'Masons', butcher: 'Butchers' },
  st: {
    main: ['High Street', 'Chepping Street', 'Main Street'], market: ['Market Street', 'Cornmarket', 'Butter Cross'],
    ring: ['Ditch Lane', 'Wall Street', 'Burgh Lane'], wall: ['Wall Lane', 'Rampart Walk'], quay: ['The Quay', 'Wharf Lane'], bridge: ['Bridge Street', 'Old Bridge Lane'], riverside: ['Water Lane', 'Waterside', 'Mill Lane'],
    church: (s) => `St ${s}'s Lane`, dest: (p) => `${p} Road`, gate: (p) => `${p} Gate Street`, craft: (x) => `${x} Lane`, road: (p) => `${p} Road`,
    minor(r) {
      const adj = ['Back', 'Crooked', 'Narrow', 'Little', 'Old', 'New', 'Long', 'Short', 'Well', 'Pig', 'Cock', 'Hog'];
      return `${r.pick(adj)} ${r.pick(['Lane', 'Row', 'Walk', 'Street', 'Alley', 'Close'])}`;
    },
  },
  sq: { market: ['Market Place', 'The Cross'], green: ['The Green', 'Village Green'], plain: (_r, s) => `St ${s}'s Square`, church: (s) => `St ${s}'s Close` },
  worship: (s, big) => (big ? `Cathedral of St ${s}` : `St ${s}'s Church`),
  castle: (n) => `${n} Castle`,
  river: (n) => `River ${n}`, lake: (n) => `${n} Mere`, sea: (n) => `${n} Sea`, forest: (n) => `${n} Forest`, hill: (n) => `${n} Hill`, farm: (n) => `${n} Farm`,
  gateDir: (d) => `${d} Gate`,
  gateOf: (p) => `${p} Gate`,
  class: ['Hamlet', 'Village', 'Market town', 'Town', 'City'],
};

/* ------------------------------------------------------------------ German */
const DE_SAINTS = ['Martin', 'Peter', 'Nikolaus', 'Georg', 'Lorenz', 'Michael', 'Stephan', 'Sebald', 'Kilian', 'Gallus', 'Ulrich', 'Afra', 'Elisabeth', 'Katharina', 'Severin', 'Gereon', 'Johannes'];
const german: Vocab = {
  place(r, tier) {
    const b = compose(r,
      ['Wald', 'Stein', 'Berg', 'Linden', 'Eichen', 'Rosen', 'Hohen', 'Nieder', 'Ober', 'Grün', 'Fried', 'Hirsch', 'Wolfs', 'Adler', 'Reichen', 'Hein', 'Lauen', 'Kirch', 'Alt', 'Neu', 'Salz', 'Rot'],
      ['burg', 'dorf', 'heim', 'stadt', 'bach', 'feld', 'hausen', 'stein', 'au', 'ingen', 'berg', 'brück', 'furt', 'tal', 'see', 'hof', 'wald', 'kirchen', 'münster']);
    return tier === 0 && r.chance(0.12) ? `Bad ${b}` : b;
  },
  saint: (r) => r.pick(DE_SAINTS),
  water: (r) => compose(r, ['Ems', 'Lah', 'Nab', 'Wup', 'Sieg', 'Fuld', 'Werr', 'Wes', 'Isar', 'Rot', 'Lech', 'Saal', 'Mur', 'Nah'], ['a', 'e', 'ach', 'au', 'ar', 'ena', 'ig']),
  town: (b, rv, r) => (r.chance(0.3) ? `${b} an der ${rv}` : b),
  old: ['Altstadt', 'Kernstadt', 'Burgviertel'],
  ward(r, kind, s, dir, craft) {
    if (kind === 'faubourg') return r.chance(0.5) ? `${s}vorstadt` : `${dir}vorstadt`;
    if (kind === 'village') return `${s}hof`;
    return w(r, [[`${s}viertel`, 3], [`${craft}viertel`, 3], ['Neustadt', 2], [`${dir}stadt`, 1]]);
  },
  dirs: ['Nord', 'Ost', 'Süd', 'West'],
  crafts: { tanner: 'Gerber', dyer: 'Färber', smith: 'Schmiede', baker: 'Bäcker', fisher: 'Fischer', potter: 'Töpfer', weaver: 'Weber', mason: 'Maurer', butcher: 'Metzger' },
  st: {
    main: ['Hauptstraße', 'Große Gasse', 'Breite Straße'], market: ['Marktstraße', 'Marktgasse'],
    ring: ['Grabenstraße', 'Wallstraße', 'Ringgasse'], wall: ['Mauergasse', 'Zwinger'], quay: ['Hafenstraße', 'Am Kai'], bridge: ['Brückenstraße', 'Brückengasse'], riverside: ['Uferstraße', 'Wassergasse', 'Mühlgasse'],
    church: (s) => `St.-${s}-Gasse`, dest: (p) => `${p}er Straße`, gate: (p) => `${p}er Torgasse`, craft: (x) => `${x}gasse`, road: (p) => `${p}er Landstraße`,
    minor(r) {
      const a = ['Enge', 'Krumme', 'Lange', 'Kurze', 'Hintere', 'Obere', 'Untere', 'Schmale'];
      const t = ['Brunnen', 'Linden', 'Kirch', 'Schul', 'Mühl', 'Garten', 'Pfarr'];
      return r.chance(0.5) ? `${r.pick(a)} ${r.pick(['Gasse', 'Straße', 'Zeile', 'Winkel'])}` : `${r.pick(t)}gasse`;
    },
  },
  sq: { market: ['Marktplatz', 'Rathausplatz'], green: ['Anger', 'Dorfplatz'], plain: (_r, s) => `${s}splatz`, church: (s) => `${s}skirchplatz` },
  worship: (s, big) => (big ? `Dom St. ${s}` : `St.-${s}-Kirche`),
  castle: (n) => `Burg ${n}`,
  river: (n) => n, lake: (n) => (/see$/.test(n) ? n : `${n}see`), sea: (n) => `${n}meer`, forest: (n) => (/wald$/.test(n) ? n : `${n}wald`), hill: (n) => (/berg$/.test(n) ? n : `${n}berg`), farm: (n) => (/hof$/.test(n) ? n : `${n}hof`),
  gateDir: (d) => `${d}tor`,
  gateOf: (p) => `${p}er Tor`,
  class: ['Weiler', 'Dorf', 'Marktflecken', 'Stadt', 'Großstadt'],
};

/* ----------------------------------------------------------------- Italian */
const IT_SAINTS = ['Marco', 'Pietro', 'Giovanni', 'Francesco', 'Lorenzo', 'Zeno', 'Ambrogio', 'Michele', 'Nicola', 'Stefano', 'Maria', 'Caterina', 'Giustina', 'Apollinare', 'Petronio', 'Antonio'];
const itDi = (n: string): string => (isV(n[0]) ? `d'${n}` : `di ${n}`);
const italian: Vocab = {
  place(r, tier) {
    const base = compose(r,
      ['Mont', 'Casal', 'Pia', 'Orv', 'Verc', 'Chia', 'Mara', 'Taor', 'Lucc', 'Cer', 'Bard', 'Sal', 'Nor', 'Terr', 'Fabr', 'Cam', 'Vit', 'Mod', 'Fer', 'Bel'],
      ['ano', 'ino', 'ella', 'etto', 'iano', 'ara', 'ona', 'aro', 'ese', 'ole', 'ento', 'ale', 'ia', 'ello', 'ate']);
    const pre = w(r, [['', 6], ['Castel ', 2], ['Monte ', 2], ['Borgo ', 1], ['Villa ', 1], ['Ponte ', 1], ['Rocca ', 1], ['San ', tier ? 2 : 0.7]] as const);
    return pre === 'San ' ? 'San ' + r.pick(IT_SAINTS) : pre + base;
  },
  saint: (r) => r.pick(IT_SAINTS),
  water: (r) => compose(r, ['Tic', 'Ad', 'Minc', 'Arn', 'Tev', 'Pia', 'Ser', 'Ofan', 'Bren', 'Sar', 'Ombr', 'Nur', 'Pad'], ['o', 'a', 'ino', 'ara', 'one', 'ella']),
  town: (b, rv, r) => (r.chance(0.25) ? `${b} sul ${rv}` : b),
  old: ['Centro Storico', 'Città Vecchia', 'Il Borgo'],
  ward(r, kind, s, dir, craft) {
    if (kind === 'faubourg') return r.chance(0.5) ? `Borgo San ${s}` : `Borgo ${dir}`;
    if (kind === 'village') return `Casale ${s}`;
    return w(r, [[`Rione San ${s}`, 3], [`Quartiere dei ${craft}`, 3], ['Borgo Nuovo', 1], ['Contrada Alta', 1]]);
  },
  dirs: ['Nord', 'Est', 'Sud', 'Ovest'],
  crafts: { tanner: 'Conciatori', dyer: 'Tintori', smith: 'Fabbri', baker: 'Fornai', fisher: 'Pescatori', potter: 'Vasai', weaver: 'Tessitori', mason: 'Muratori', butcher: 'Macellai' },
  st: {
    main: ['Via Maestra', 'Corso Grande', 'Via Larga'], market: ['Via del Mercato', 'Via della Loggia'],
    ring: ['Via delle Mura', 'Via del Fossato'], wall: ['Via del Bastione', 'Via dei Merli'], quay: ['Fondamenta del Porto', 'Via della Riva'], bridge: ['Via del Ponte', 'Via Pontevecchio'], riverside: ['Via del Fiume', 'Lungofiume', 'Via dei Lavatoi'],
    church: (s) => `Via San ${s}`, dest: (p) => `Via ${p}`, gate: (p) => `Via di Porta ${p}`, craft: (x) => `Via dei ${x}`, road: (p) => `Strada per ${p}`,
    minor(r) {
      const a = ['Stretta', 'Nuova', 'Vecchia', 'Bassa', 'Alta', 'Lunga', 'Storta', 'Buia'];
      const n = ['del Pozzo', 'dei Tigli', 'del Forno', 'della Fontana', 'dei Giardini', 'del Chiostro', 'dei Cipressi'];
      return r.chance(0.5) ? `Via ${r.pick(a)}` : `Via ${r.pick(n)}`;
    },
  },
  sq: { market: ['Piazza del Mercato', 'Piazza Maggiore'], green: ['Il Prato', 'Piazza Verde'], plain: (_r, s) => `Piazza San ${s}`, church: (s) => `Sagrato di San ${s}` },
  worship: (s, big) => (big ? `Duomo di San ${s}` : `Chiesa di San ${s}`),
  castle: (n) => `Castello ${itDi(n)}`,
  river: (n) => `Fiume ${n}`, lake: (n) => `Lago ${itDi(n)}`, sea: (n) => `Mare ${itDi(n)}`, forest: (n) => `Bosco ${itDi(n)}`, hill: (n) => `Monte ${n}`, farm: (n) => `Podere ${n}`,
  gateDir: (d) => `Porta ${d}`,
  gateOf: (p) => `Porta ${p}`,
  class: ['Casale', 'Villaggio', 'Borgo', 'Città', 'Metropoli'],
};

/* ------------------------------------------------------------------- Arabic */
const AR_C = ['b', 'd', 'f', 'h', 'j', 'k', 'l', 'm', 'n', 'q', 'r', 's', 't', 'z', 'kh', 'sh', 'gh', 'w'];
const arRoot = (r: Rng): string => cap(r.pick(AR_C) + 'a' + r.pick(AR_C) + r.pick(['a', 'i', 'u']) + r.pick(AR_C));
const arabic: Vocab = {
  place(r, tier) {
    const root = arRoot(r);
    const p = w(r, [['root', 3], ['iya', 2], ['abad', 1], ['qasr', tier === 2 ? 0 : 1], ['bab', tier === 2 ? 0 : 1], ['ain', tier === 2 ? 0 : tier ? 2 : 1], ['mad', tier ? 0 : 1]] as const);
    switch (p) {
      case 'root': return 'Al-' + root;
      case 'iya': return root.slice(0, 3) + 'iya';
      case 'abad': return root.slice(0, 3) + 'abad';
      case 'qasr': return 'Qasr ' + root;
      case 'bab': return 'Bab al-' + root;
      case 'ain': return 'Ain ' + root;
      default: return 'Madinat ' + root;
    }
  },
  saint: (r) => r.pick(['Idris', 'Hamza', 'Salim', 'Nur', 'Fath', 'Yusuf', 'Zayd', 'Musa', 'Khalid', 'Hasan']),
  water: (r) => 'Wadi ' + arRoot(r),
  old: ['Al-Madina al-Qadima', 'Al-Qasba', 'Harat al-Wasat'],
  ward(r, kind, s, dir, craft) {
    if (kind === 'faubourg') return `Rabad al-${dir}`;
    if (kind === 'village') return `Dawwar ${s}`;
    return w(r, [[`Harat ${s}`, 3], [`Hayy al-${craft}`, 3], ['Al-Hara al-Jadida', 1]]);
  },
  dirs: ['Shamal', 'Sharq', 'Janub', 'Gharb'],
  crafts: { tanner: 'Dabbaghin', dyer: 'Sabbaghin', smith: 'Haddadin', baker: 'Khabbazin', fisher: 'Sayyadin', potter: 'Fakhkharin', weaver: 'Nassajin', mason: 'Bannain', butcher: 'Jazzarin' },
  st: {
    main: ['Al-Sharia al-Kabira', 'Darb al-Sultan'], market: ['Suq al-Kabir', 'Suq al-Attarin'],
    ring: ['Darb al-Sur', 'Zuqaq al-Khandaq'], wall: ['Tariq al-Hiraa'], quay: ['Mina al-Nahr'], bridge: ['Tariq al-Qantara'], riverside: ['Darb al-Nahr', 'Zuqaq al-Ma'],
    church: (s) => `Zuqaq ${s}`, dest: (p) => `Tariq ${p}`, gate: (p) => `Darb Bab ${p}`, craft: (x) => `Suq al-${x}`, road: (p) => `Tariq ${p}`,
    minor: (r) => r.pick(['Zuqaq', 'Darb', 'Aqaba']) + ' ' + r.pick(['al-Bir', 'al-Yasmin', 'al-Nakhil', 'al-Jawz', 'al-Hammam', 'al-Ain', 'al-Zaitun']),
  },
  sq: { market: ['Rahba al-Suq', 'Saha al-Kabira'], green: ['Al-Rawda'], plain: (_r, s) => `Rahba ${s}`, church: (s) => `Saha ${s}` },
  worship: (s, big) => (big ? "Jami' al-Kabir" : `Masjid ${s}`),
  castle: (n) => `Qasba ${n}`,
  river: (n) => n, lake: (n) => `Buhayra ${n}`, sea: (n) => `Bahr ${n}`, forest: (n) => `Ghaba ${n}`, hill: (n) => `Jabal ${n}`, farm: (n) => `Dayaa ${n}`,
  gateDir: (d) => `Bab al-${d}`,
  gateOf: (p) => `Bab ${p}`,
  class: ['Dawwar', 'Qarya', 'Bulayda', 'Madina', 'Madina Kubra'],
};

/* ------------------------------------------------------------------ Chinese */
const PY = {
  A: { i: ['b', 'p', 'm', 'd', 't', 'n', 'l'], f: ['a', 'ai', 'an', 'ang', 'ao', 'e', 'en', 'eng', 'i', 'ian', 'iao', 'ie', 'in', 'ing', 'ong', 'ou', 'u', 'uan', 'un', 'ui', 'uo'] },
  B: { i: ['g', 'k', 'h', 'zh', 'ch', 'sh', 'z', 'c', 's'], f: ['a', 'ai', 'an', 'ang', 'ao', 'e', 'en', 'eng', 'ong', 'ou', 'u', 'uan', 'un', 'ui', 'uo'] },
  C: { i: ['j', 'q', 'x'], f: ['i', 'ian', 'iang', 'iao', 'ie', 'in', 'ing', 'iu', 'iong', 'uan', 'un'] },
  D: { i: ['f'], f: ['a', 'an', 'ang', 'en', 'eng', 'ou', 'u'] },
};
function pinyin(r: Rng): string {
  const g = PY[w(r, [['A', 5], ['B', 5], ['C', 4], ['D', 1]] as const)];
  return r.pick(g.i) + r.pick(g.f);
}
const chinese: Vocab = {
  place(r, tier) {
    const n = cap(pinyin(r) + pinyin(r));
    return n + (tier === 0 ? r.pick([' Fu', ' Zhou', ' Cheng', '']) : tier === 1 ? r.pick([' Zhen', ' Cun', '']) : '');
  },
  saint: (r) => cap(pinyin(r)) + cap(pinyin(r)),
  water: (r) => cap(pinyin(r) + pinyin(r)),
  old: ['Nei Cheng', 'Gu Cheng'],
  ward: (r, kind, s, dir, craft) => (kind === 'faubourg' ? `${dir} Guan` : kind === 'village' ? `${s} Cun` : r.chance(0.5) ? `${craft} Fang` : `${s} Fang`),
  dirs: ['Bei', 'Dong', 'Nan', 'Xi'],
  crafts: { tanner: 'Pige', dyer: 'Ranfang', smith: 'Tiejiang', baker: 'Bing', fisher: 'Yuren', potter: 'Taoqi', weaver: 'Zhifang', mason: 'Shijiang', butcher: 'Rou' },
  st: {
    main: ['Da Jie', 'Zhong Da Jie', 'Zhengyang Jie'], market: ['Shi Jie', 'Shichang Jie'], ring: ['Huancheng Lu', 'Cheng Gen Jie'], wall: ['Cheng Qiang Lu'], quay: ['Matou Lu'], bridge: ['Qiao Tou Jie'], riverside: ['He Yan Jie', 'Binhe Lu'],
    church: (s) => `${s} Miao Jie`, dest: (p) => `${p} Lu`, gate: (p) => `${p} Men Jie`, craft: (x) => `${x} Xiang`, road: (p) => `${p} Guan Dao`,
    minor: (r) => cap(pinyin(r) + pinyin(r)) + r.pick([' Xiang', ' Hutong', ' Jie']),
  },
  sq: { market: ['Shichang Guangchang', 'Gu Lou Guangchang'], green: ['Lüdi'], plain: (r) => cap(pinyin(r) + pinyin(r)) + ' Guangchang', church: (s) => `${s} Guangchang` },
  worship: (s, big) => (big ? 'Chenghuang Miao' : `${s} Si`),
  castle: (n) => `${n} Yamen`,
  river: (n) => `${n} He`, lake: (n) => `${n} Hu`, sea: (n) => `${n} Hai`, forest: (n) => `${n} Lin`, hill: (n) => `${n} Shan`, farm: (n) => `${n} Zhuang`,
  gateDir: (d) => `${d} Men`,
  gateOf: (p) => `${p} Men`,
  class: ['Zhuang', 'Cun', 'Zhen', 'Xian Cheng', 'Fu Cheng'],
};

/* ----------------------------------------------------------------- Japanese */
const japanese: Vocab = {
  place(r, tier) {
    const b = compose(r,
      ['matsu', 'take', 'kita', 'minami', 'higashi', 'nishi', 'naka', 'shira', 'kuro', 'aka', 'yama', 'kawa', 'ishi', 'sakura', 'fuji', 'tsuru', 'kame', 'hana', 'mizu', 'taka', 'kami', 'shimo', 'wada', 'ao', 'sugi'],
      ['moto', 'gawa', 'yama', 'saki', 'hara', 'mura', 'shima', 'da', 'zaka', 'ura', 'machi', 'oka', 'shiro', 'no', 'ji', 'be', 'mori', 'kubo']);
    return tier === 0 && r.chance(0.2) ? b + '-jo' : b;
  },
  saint: (r) => cap(r.pick(['inari', 'hachiman', 'tenjin', 'kannon', 'jizo', 'bishamon', 'ebisu', 'suwa', 'atago'])),
  water: (r) => compose(r, ['tama', 'kiso', 'shina', 'tone', 'yoshi', 'kuma', 'sada', 'abu', 'mogami'], ['gawa', 'kawa']),
  old: ['Joka', 'Honmaru', 'Naka-machi'],
  ward(r, kind, s, dir, craft) {
    if (kind === 'faubourg') return `${dir}-machi`;
    if (kind === 'village') return `${s}-mura`;
    return w(r, [[`${craft}-machi`, 3], [`${s}-cho`, 3], ['Bukeyashiki', 1], ['Teramachi', 1]]);
  },
  dirs: ['Kita', 'Higashi', 'Minami', 'Nishi'],
  crafts: { tanner: 'Kawaya', dyer: "Kon'ya", smith: 'Kaji', baker: 'Panya', fisher: 'Ryoshi', potter: 'Tojiki', weaver: 'Hata', mason: 'Ishiya', butcher: 'Nikuya' },
  st: {
    main: ['Omote-dori', 'Ote-suji', 'Honmachi-dori'], market: ['Ichiba-dori', 'Ichi-machi'], ring: ['Horibata-dori', 'Mawari-michi'], wall: ['Doi-michi'], quay: ['Minato-dori'], bridge: ['Hashi-dori'], riverside: ['Kawabata-dori', 'Kawa-zoi'],
    church: (s) => `${s}-michi`, dest: (p) => `${p}-kaido`, gate: (p) => `${p}-mon-dori`, craft: (x) => `${x}-machi`, road: (p) => `${p}-kaido`,
    minor: (r) => compose(r, ['yanagi', 'sakura', 'take', 'matsu', 'ume', 'fuji', 'tsuki'], ['-dori', '-suji', '-koji', '-zaka']),
  },
  sq: { market: ['Ichiba-hiroba', 'Hiroba'], green: ['Niwa'], plain: (_r, s) => `${s}-hiroba`, church: (s) => `${s}-keidai` },
  worship: (s, big) => (big ? `${s} Taisha` : `${s} Jinja`),
  castle: (n) => `${n}-jo`,
  river: (n) => n, lake: (n) => `${n}-ko`, sea: (n) => `${n}-nada`, forest: (n) => `${n}-no-mori`, hill: (n) => `${n}-yama`, farm: (n) => `${n}-mura`,
  gateDir: (d) => `${d}-mon`,
  gateOf: (p) => `${p}-mon`,
  class: ['Shuraku', 'Mura', 'Machi', 'Jokamachi', 'Miyako'],
};

/* ----------------------------------------------------------------- Sanskrit */
const SK_ON = ['k', 'r', 'm', 'n', 's', 't', 'v', 'p', 'd', 'g', 'bh', 'dh', 'th', 'sh', 'l', 'y', 'ch', 'j'];
const SK_V = ['a', 'a', 'i', 'u', 'e', 'o', 'aa'];
const sanskrit: Vocab = {
  place(r, tier) {
    const root = syll(r, SK_ON, SK_V, [], 0) + syll(r, SK_ON, SK_V, ['n', 'm', 'l'], 0.3) + (r.chance(0.4) ? syll(r, SK_ON, SK_V, [], 0) : '');
    return cap(join(root, r.pick(tier === 0 ? ['pura', 'nagara', 'puram', 'giri', 'vati', 'prastha'] : ['palli', 'halli', 'gram', 'ganj', 'pet', 'kund', 'ur', 'wadi'])));
  },
  saint: (r) => cap(join(syll(r, ['sh', 'k', 'r', 'v', 'g', 'h', 'l', 'm'], ['i', 'a', 'u'], [], 0), r.pick(['va', 'shna', 'nath', 'deva', 'laya', 'ma', 'ndra', 'raja']))),
  water: (r) => cap(join(syll(r, ['g', 'k', 'y', 'n', 's', 't', 'b', 'c'], ['a', 'i', 'u'], ['n', 'r'], 0.4), r.pick(['ga', 'vati', 'ri', 'na', 'yini', 'dri']))),
  old: ['Mandir Nagari', 'Purana Pura', 'Nagara Kendra'],
  ward(r, kind, s, dir, craft) {
    if (kind === 'faubourg') return `${dir} Pura`;
    if (kind === 'village') return `${s} Gram`;
    return w(r, [[`${s} Tola`, 3], [`${craft} Mohalla`, 3], ['Nava Nagar', 1]]);
  },
  dirs: ['Uttara', 'Purva', 'Dakshina', 'Pashchima'],
  crafts: { tanner: 'Charmakar', dyer: 'Rangrez', smith: 'Lohar', baker: 'Halwai', fisher: 'Machhua', potter: 'Kumhar', weaver: 'Julaha', mason: 'Rajmistri', butcher: 'Khatik' },
  st: {
    main: ['Raja Marg', 'Maha Marg', 'Rath Marg'], market: ['Bazaar Marg', 'Haat Gali'], ring: ['Pradakshina Marg', 'Parikrama Path'], wall: ['Prakara Marg'], quay: ['Ghat Marg'], bridge: ['Setu Marg'], riverside: ['Nadi Path', 'Ghat Gali'],
    church: (s) => `${s} Mandir Marg`, dest: (p) => `${p} Marg`, gate: (p) => `${p} Dwar Marg`, craft: (x) => `${x} Gali`, road: (p) => `${p} Path`,
    minor: (r) => cap(r.pick(['tulsi', 'nim', 'amra', 'kamal', 'chandan', 'mala'])) + ' Gali',
  },
  sq: { market: ['Mandi Chowk', 'Bazaar Chowk'], green: ['Udyan'], plain: (_r, s) => `${s} Chowk`, church: (s) => `${s} Mandap` },
  worship: (s, big) => (big ? `Maha ${s} Mandir` : `${s} Mandir`),
  castle: (n) => `${n} Durg`,
  river: (n) => `${n} Nadi`, lake: (n) => `${n} Sarovar`, sea: (n) => `${n} Sagar`, forest: (n) => `${n} Van`, hill: (n) => `${n} Giri`, farm: (n) => `${n} Wadi`,
  gateDir: (d) => `${d} Dwar`,
  gateOf: (p) => `${p} Dwar`,
  class: ['Wadi', 'Gram', 'Nagarika', 'Nagara', 'Maha-Nagara'],
};

/* -------------------------------------------------------------------- Norse */
const norse: Vocab = {
  place(r, tier) {
    const b = compose(r,
      ['Skar', 'Hel', 'Ulf', 'Bjorn', 'Sig', 'Thor', 'Orm', 'Vik', 'Ravn', 'Gran', 'Stor', 'Sol', 'Kald', 'Brand', 'Eyr', 'Hof', 'Njord', 'Ask', 'Dyr', 'Fjord', 'Ringe', 'Gaut', 'Hav', 'Tyr'],
      ['by', 'vik', 'stad', 'holm', 'fjord', 'nes', 'torp', 'gard', 'heim', 'vang', 'ey', 'borg', 'sund', 'dal', 'lund', 'bo']);
    return tier === 1 && r.chance(0.2) ? 'Nedre ' + b : b;
  },
  saint: (r) => r.pick(['Olav', 'Magnus', 'Knut', 'Eirik', 'Sunniva', 'Hallvard', 'Botolf', 'Thorlak', 'Erlend']),
  water: (r) => compose(r, ['Gaul', 'Nid', 'Lag', 'Sku', 'Tor', 'Sor', 'Vor', 'Glom', 'Ran', 'Ork'], ['a', 'elv', 'ena', 'dal']),
  old: ['Gamlebyen', 'Hovedgard', 'Kaupang'],
  ward(r, kind, s, dir, craft) {
    if (kind === 'faubourg') return `${dir}-bygda`;
    if (kind === 'village') return `${s}stad`;
    return w(r, [[`${s}s Kvarter`, 2], [`${craft}gata-kvarteret`, 2], ['Nybyen', 2]]);
  },
  dirs: ['Nord', 'Ost', 'Sor', 'Vest'],
  crafts: { tanner: 'Garvar', dyer: 'Farvar', smith: 'Smed', baker: 'Baker', fisher: 'Fisker', potter: 'Pottemaker', weaver: 'Vever', mason: 'Mur', butcher: 'Slakter' },
  st: {
    main: ['Storgata', 'Kongsgata', 'Hovedgata'], market: ['Torggata', 'Kaupmannagata'], ring: ['Vollgata', 'Ringgata'], wall: ['Gardsgata'], quay: ['Bryggegata', 'Kaigata'], bridge: ['Brugata'], riverside: ['Elvegata', 'Vassgata'],
    church: (s) => `${s}s gate`, dest: (p) => `${p}veien`, gate: (p) => `${p}porten`, craft: (x) => `${x}gata`, road: (p) => `${p}veien`,
    minor: (r) => cap(r.pick(['linde', 'ask', 'birke', 'furu', 'bekk', 'molle', 'skole', 'kirke'])) + r.pick(['gata', 'stredet', 'smuget']),
  },
  sq: { market: ['Torget', 'Kaupangstorget'], green: ['Tunet'], plain: (_r, s) => `${s}s plass`, church: (s) => `${s}s kirkeplass` },
  worship: (s, big) => (big ? `${s}s domkirke` : `${s}s kirke`),
  castle: (n) => `${n} borg`,
  river: (n) => `${n}elva`, lake: (n) => `${n}vatnet`, sea: (n) => `${n}fjorden`, forest: (n) => `${n}skogen`, hill: (n) => `${n}fjell`, farm: (n) => `${n}gard`,
  gateDir: (d) => `${d}porten`,
  gateOf: (p) => `${p}porten`,
  class: ['Gard', 'Bygd', 'Kaupang', 'By', 'Storby'],
};

/* -------------------------------------------------------------------- Elven */
const EL_ON = ['l', 'r', 'n', 'm', 'th', 's', 'v', 'f', 'c', 'ael', 'el', 'ith', 'cal', 'mel', 'gal', 'ar', 'en', 'sil', 'lor', 'il', 'quel', 'fae', 'lir', 'ny', 'ta'];
const EL_V = ['a', 'e', 'i', 'o', 'ae', 'ia', 'ei', 'ë', 'ui'];
function elvenWord(r: Rng, ends: string[]): string {
  let s = syll(r, EL_ON, EL_V, ['l', 'n', 'r', 's', 'th'], 0.25) + syll(r, ['l', 'r', 'n', 'v', 'th', 's', 'm', 'nd'], EL_V, ['n', 'l', 'r'], 0.2);
  if (r.chance(0.2)) s += syll(r, ['l', 'r', 'n', 'v', 'w'], ['a', 'e', 'i'], [], 0);
  return cap(join(s, r.pick(ends)));
}
const elven: Vocab = {
  place: (r, tier) => elvenWord(r, tier === 0 ? ['ion', 'indor', 'lond', 'orin', 'thir', 'nost', 'dell'] : ['iel', 'wen', 'ael', 'eth', 'arë', 'wë']),
  saint: (r) => elvenWord(r, ['iel', 'wen', 'ael', 'eth']),
  water: (r) => elvenWord(r, ['duin', 'loth', 'rill', 'ash']),
  old: ['The Heartwood', 'Aran Nost', 'The Elder Grove'],
  ward: (r, kind, s, dir) => (kind === 'faubourg' ? `${dir} Glade` : kind === 'village' ? `${s} Hollow` : w(r, [[`${s} Bower`, 3], [`The ${s} Weave`, 2], [`${dir} Canopy`, 2]])),
  dirs: ['Northern', 'Eastern', 'Southern', 'Western'],
  crafts: { tanner: 'Leather-singers', dyer: 'Colour-weavers', smith: 'Silversmiths', baker: 'Bread-bakers', fisher: 'Streamfolk', potter: 'Clay-shapers', weaver: 'Loom-keepers', mason: 'Stone-singers', butcher: 'Hunters' },
  st: {
    main: ['The Silver Way', 'Aran Path', 'The High Bough Walk'], market: ['Market Glade Path', 'The Trading Bough'], ring: ['The Ring Path', 'Circle of Boughs'], wall: ['The Hedge Path'], quay: ['Rillside Walk'], bridge: ['The Leaf Bridge Path'], riverside: ['Streamside Path', 'Rillwalk'],
    church: (s) => `Path of ${s}`, dest: (p) => `${p} Way`, gate: (p) => `${p} Gate Path`, craft: (x) => `Path of the ${x}`, road: (p) => `${p} Road`,
    minor: (r) => `${elvenWord(r, ['iel', 'orin', 'eth'])} ${r.pick(['Path', 'Walk', 'Way', 'Bough'])}`,
  },
  sq: { market: ['The Moot Glade', 'Market Glade'], green: ['The Sacred Grove'], plain: (_r, s) => `${s} Glade`, church: (s) => `${s} Grove` },
  worship: (s, big) => (big ? `The Great Grove of ${s}` : `Shrine of ${s}`),
  castle: (n) => `${n} Tower`,
  river: (n) => n, lake: (n) => `${n} Mere`, sea: (n) => `Sea of ${n}`, forest: (n) => `${n} Wood`, hill: (n) => `${n} Tor`, farm: (n) => `${n} Orchard`,
  gateDir: (d) => `${d} Archway`,
  class: ['Glade', 'Grove', 'Bower', 'Haven', 'Sanctuary'],
};

/* ------------------------------------------------------------------- Dwarven */
const dwarven: Vocab = {
  place: (r, tier) => compose(r,
    ['Kaz', 'Khaz', 'Dur', 'Bar', 'Thor', 'Grim', 'Brom', 'Dor', 'Kor', 'Bol', 'Gim', 'Zul', 'Mor', 'Bal', 'Dum', 'Thrain', 'Nar', 'Fun', 'Dwal', 'Krag', 'Ulg', 'Azg'],
    tier === 0 ? ['adûm', 'gar', 'dûr', 'zund', 'baraz', 'nar', 'khal', 'hold', 'delve'] : ['ak', 'im', 'rak', 'in', 'bek', 'gund', 'ar']),
  saint: (r) => compose(r, ['Dur', 'Thor', 'Grim', 'Bal', 'Mor', 'Bor', 'Nal'], ['in', 'ek', 'gar', 'din', 'li', 'rim']),
  water: (r) => compose(r, ['Kib', 'Zir', 'Ngul', 'Celed', 'Run', 'Nar'], ['il', 'ak', 'nud', 'dûr']),
  old: ['The Deep Halls', 'Gate-Hold', 'The Anvil Ring'],
  ward: (r, kind, s, dir, craft) => (kind === 'faubourg' ? `${dir} Terraces` : kind === 'village' ? `${s}'s Outpost` : w(r, [[`${craft} Hall`, 3], [`${s}'s Terrace`, 3], ['Lower Delve', 1]])),
  dirs: ['North', 'East', 'South', 'West'],
  crafts: { tanner: 'Tanners', dyer: 'Dyers', smith: 'Forgemasters', baker: 'Bakers', fisher: 'Lake-fishers', potter: 'Potters', weaver: 'Weavers', mason: 'Stonewrights', butcher: 'Butchers' },
  st: {
    main: ['The Great Stair', 'Hammer Way', "Kings' Causeway"], market: ['Trade Stair', 'Anvil Market Way'], ring: ['Ring Terrace', 'Girdle Way'], wall: ['Shieldwall Walk'], quay: ['Lakeside Stair'], bridge: ['Stone Span Way'], riverside: ['Streamside Stair', 'Waterfall Way'],
    church: (s) => `${s}'s Stair`, dest: (p) => `${p} Road`, gate: (p) => `${p} Gate Way`, craft: (x) => `${x}' Way`, road: (p) => `${p} Road`,
    minor: (r) => r.pick(['Low', 'High', 'Deep', 'Iron', 'Coal', 'Rune', 'Gem', 'Slate']) + ' ' + r.pick(['Stair', 'Way', 'Terrace', 'Gallery']),
  },
  sq: { market: ['The Grand Hall Square', 'Forge Court'], green: ['Mushroom Terrace'], plain: (_r, s) => `${s}'s Court`, church: (s) => `${s}'s Forecourt` },
  worship: (s, big) => (big ? `Great Hall of ${s}` : `${s}'s Shrine`),
  castle: (n) => `${n} Keep`,
  river: (n) => n, lake: (n) => `Lake ${n}`, sea: (n) => `${n} Sea`, forest: (n) => `${n} Wood`, hill: (n) => `${n} Peak`, farm: (n) => `${n} Steading`,
  gateDir: (d) => `${d} Door`,
  class: ['Outpost', 'Steading', 'Delve', 'Hold', 'Great Hold'],
};

/* -------------------------------------------------------------------- Orcish */
const ORC_STEMS = ['Gor', 'Grak', 'Ug', 'Mog', 'Zug', 'Krul', 'Bag', 'Shag', 'Dur', 'Gash', 'Nar', 'Ghash', 'Lurz', 'Skar', 'Ogh', 'Thrak', 'Mur', 'Vrag'];
const orcish: Vocab = {
  place(r, tier) {
    const b = compose(r, ORC_STEMS, tier === 0 ? ['ush', 'ak', 'gash', 'gul', 'dush', 'rok', 'nazg', 'mog'] : ['ub', 'uk', 'urz', 'akh']);
    return r.chance(0.25) ? b + '-' + r.pick(ORC_STEMS) : b;
  },
  saint: (r) => compose(r, ['gor', 'krul', 'mog', 'zug', 'ugh', 'shag'], ['ash', 'uk', 'rak', 'gul']),
  water: (r) => compose(r, ['gul', 'sharg', 'bur', 'nazg'], ['ash', 'ub', 'ukh']),
  old: ['The Warcamp', 'Skull Mound', 'The Pit'],
  ward: (r, kind, s, dir, craft) => (kind === 'faubourg' ? `${dir} Sprawl` : kind === 'village' ? `${s}'s Camp` : w(r, [[`${s}'s Pack`, 3], [`${craft} Pens`, 2], ['The Bonefield', 1]])),
  dirs: ['North', 'East', 'South', 'West'],
  crafts: { tanner: 'Skinners', dyer: 'Blood-dyers', smith: 'Blademakers', baker: 'Meat-roasters', fisher: 'Fish-gutters', potter: 'Potters', weaver: 'Hide-weavers', mason: 'Wall-breakers', butcher: 'Butchers' },
  st: {
    main: ['Warlord Way', 'Skull Road', 'The Brute Mile'], market: ['Loot Row', 'Trade-Pit Way'], ring: ['Stake Ring', 'Palisade Path'], wall: ['Spike Row'], quay: ['Riverpit Row'], bridge: ['Plank Crossing'], riverside: ['Mudbank Row', 'Gore Creek Way'],
    church: (s) => `${s}'s Path`, dest: (p) => `${p} Trail`, gate: (p) => `${p} Gate Row`, craft: (x) => `${x} Row`, road: (p) => `${p} Trail`,
    minor: (r) => r.pick(['Bone', 'Mud', 'Ash', 'Ruin', 'Rust', 'Gore', 'Tusk']) + ' ' + r.pick(['Row', 'Trail', 'Pit', 'Alley']),
  },
  sq: { market: ['The Loot Pit', 'Blood Market'], green: ['The Bone Yard'], plain: (_r, s) => `${s}'s Pit`, church: (s) => `${s}'s Altar-Yard` },
  worship: (s, big) => (big ? `Skull-Throne of ${s}` : `${s}'s Altar`),
  castle: (n) => `${n} Hold`,
  river: (n) => n, lake: (n) => `${n} Bog`, sea: (n) => `${n} Sea`, forest: (n) => `${n} Thicket`, hill: (n) => `${n} Mound`, farm: (n) => `${n} Pen`,
  gateDir: (d) => `${d} Spikegate`,
  class: ['Camp', 'Den', 'Warren', 'Stronghold', 'Horde-City'],
};

/* ------------------------------------------------------------------ Halfling */
const halfling: Vocab = {
  place(r, tier) {
    const pre = tier ? w(r, [['', 5], ['Little ', 2], ['Much ', 1], ['Nether ', 1]] as const) : '';
    return pre + compose(r,
      ['Bramble', 'Tuck', 'Hob', 'Bolger', 'Green', 'Under', 'Bag', 'Whit', 'Tea', 'Honey', 'Mush', 'Pip', 'Lob', 'Bun', 'Dell', 'Brook', 'Puddle', 'Apple', 'Thistle', 'Cider', 'Clover', 'Dumble', 'Fern'],
      ['by', 'wick', 'hollow', 'burrow', 'dell', 'ton', 'den', 'end', 'bottom', 'ford', 'hill', 'meadow', 'comb', 'brook', 'stead']);
  },
  saint: (r) => r.pick(['Pip', 'Hob', 'Rosie', 'Tobold', 'Lobelia', 'Dell', 'Bilba', 'Perry', 'Mungo']),
  water: (r) => compose(r, ['Bran', 'Wind', 'Bur', 'Lit', 'Dew'], ['dyn', 'rill', 'beck', 'wen', 'bourne']),
  old: ['The Old Hill', 'Bagshot Row', 'The Smials'],
  ward: (r, kind, s, dir, craft) => (kind === 'faubourg' ? `${dir} Farthing End` : kind === 'village' ? `${s}'s Hollow` : w(r, [[`${craft} Row`, 3], [`${s}'s Burrows`, 3], ['Upper Hill', 1]])),
  dirs: ['North', 'East', 'South', 'West'],
  crafts: { tanner: 'Tanners', dyer: 'Dyers', smith: 'Smiths', baker: 'Bakers', fisher: 'Fishers', potter: 'Potters', weaver: 'Weavers', mason: 'Masons', butcher: 'Butchers' },
  st: {
    main: ['The Hill Road', 'Bagshot Row', 'Hobbit Lane'], market: ['Market Lane', 'Pudding Lane'], ring: ['Hedge Lane', 'Round Lane'], wall: ['Hedgerow Path'], quay: ['Wharf Lane'], bridge: ['Bridge Lane'], riverside: ['Water Lane', 'Mill Lane'],
    church: (s) => `${s}'s Lane`, dest: (p) => `${p} Road`, gate: (p) => `${p} Gate Lane`, craft: (x) => `${x} Row`, road: (p) => `${p} Road`,
    minor: (r) => r.pick(['Cosy', 'Crooked', 'Sunny', 'Hollow', 'Muddy', 'Honey', 'Buttercup', 'Thimble', 'Cider']) + ' ' + r.pick(['Lane', 'Row', 'Walk', 'Way']),
  },
  sq: { market: ['The Party Field', 'Market Green'], green: ['The Green', 'Party Field'], plain: (_r, s) => `${s}'s Green`, church: (s) => `${s}'s Corner` },
  worship: (s) => `Chapel of ${s}`,
  castle: (n) => `${n} Hall`,
  river: (n) => `${n} Water`, lake: (n) => `${n} Pond`, sea: (n) => `${n} Sea`, forest: (n) => `${n} Wood`, hill: (n) => `${n} Hill`, farm: (n) => `${n} Farm`,
  gateDir: (d) => `${d} Round Door`,
  class: ['Burrow', 'Hamlet', 'Village', 'Town', 'Shire-Town'],
};

export const VOCAB: Record<NameFamily, Vocab> = { french, english, german, italian, arabic, chinese, japanese, sanskrit, norse, elven, dwarven, orcish, halfling };
