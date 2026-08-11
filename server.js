'use strict';

/**
 * Serveur Node.js sans dépendance externe.
 *
 * Rôle :
 *   1. Servir le frontend statique (dossier ./public).
 *   2. Exposer une API /api/maps qui va chercher la liste des cartes sur
 *      download.osmand.net (list.php), transforme le XML en JSON et le met
 *      en cache. Ce proxy est nécessaire car list.php ne renvoie pas
 *      d'en-têtes CORS : un fetch direct depuis le navigateur serait bloqué.
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
// Version de l'application (lue dans package.json), affichée au démarrage.
let VERSION = 'inconnue';
try {
  VERSION = require('./package.json').version || VERSION;
} catch (e) {
  /* ignore */
}
const OSMAND_LIST_URL = 'https://download.osmand.net/list.php';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 heure

const PUBLIC_DIR = path.join(__dirname, 'public');
// Fichier des régions (états/provinces), côté serveur uniquement.
const ADMIN1_PATH = path.join(__dirname, 'data', 'admin1.min.geo.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

// Cache mémoire simple.
let cache = { data: null, fetchedAt: 0 };

// Régions admin-1 chargées paresseusement puis indexées par pays (normalisé).
let admin1ByCountry = null;

function normCountry(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');
}

function loadAdmin1() {
  if (admin1ByCountry) return admin1ByCountry;
  admin1ByCountry = {};
  try {
    const gj = JSON.parse(fs.readFileSync(ADMIN1_PATH, 'utf8'));
    for (const f of gj.features) {
      const key = normCountry(f.properties && f.properties.admin);
      if (!key) continue;
      (admin1ByCountry[key] = admin1ByCountry[key] || []).push(f);
    }
  } catch (e) {
    console.warn('admin1 indisponible :', e.message);
  }
  return admin1ByCountry;
}

function getRegionsForCountry(country) {
  const idx = loadAdmin1();
  return idx[normCountry(country)] || [];
}

/* --------- Corrélation carte OsmAnd <-> régions géographiques (admin1) ------ */

// Régions administratives -> slug OsmAnd (cas traduits).
const REGION_ALIAS = {
  occitanie: 'occitania',
  grandest: 'greateast',
  nouvelleaquitaine: 'newaquitaine',
  bretagne: 'brittany',
  normandie: 'normandy',
  centrevaldeloire: 'centreloirevalley',
};
// Alias de pays (token OsmAnd -> clé admin1).
const COUNTRY_ALIAS = {
  us: 'unitedstatesofamerica',
  greatbritain: 'unitedkingdom',
  czechrepublic: 'czechia',
  congodr: 'democraticrepublicofthecongo',
  cotedivoire: 'ivorycoast',
};
// Mots génériques ignorés dans l'appariement par mots.
const STOP = new Set([
  'nord', 'sud', 'est', 'ouest', 'north', 'south', 'east', 'west', 'central',
  'centre', 'region', 'province', 'regione', 'valle', 'valley', 'vallee',
  'great', 'grand', 'island', 'islands', 'saint', 'republic', 'republique',
  'district', 'oblast', 'krai', 'prefecture', 'upper', 'lower', 'haute', 'basse',
]);

function regionKey(name) {
  const k = normCountry(name);
  return REGION_ALIAS[k] || k;
}
function wordsOf(s) {
  return String(s || '')
    .split(/[^A-Za-zÀ-ÿ0-9]+/)
    .map(normCountry)
    .filter((w) => w.length >= 5 && !STOP.has(w));
}

let admin1Keys = null; // { countryKeys:Set, regionKeys:Map(ck->Set) }
function buildAdmin1Keys() {
  if (admin1Keys) return admin1Keys;
  const idx = loadAdmin1();
  const countryKeys = new Set();
  const regionKeys = new Map();
  for (const ck in idx) {
    countryKeys.add(ck);
    const set = new Set();
    regionKeys.set(ck, set);
    for (const f of idx[ck]) {
      const p = f.properties || {};
      [p.name, p.name_local, p.name_alt].forEach((n) => {
        if (n) {
          set.add(normCountry(n));
          wordsOf(n).forEach((w) => set.add(w));
        }
      });
      if (p.region) {
        set.add(regionKey(p.region));
        wordsOf(p.region).forEach((w) => set.add(w));
      }
    }
  }
  admin1Keys = { countryKeys, regionKeys };
  return admin1Keys;
}

function matchCountryKey(token) {
  const { countryKeys } = buildAdmin1Keys();
  const nt = normCountry(token);
  if (countryKeys.has(nt)) return nt;
  if (COUNTRY_ALIAS[nt] && countryKeys.has(COUNTRY_ALIAS[nt])) return COUNTRY_ALIAS[nt];
  for (const ck of countryKeys) {
    if (ck.length >= 4 && (nt === ck || nt.startsWith(ck) || ck.startsWith(nt))) return ck;
  }
  return null;
}

// Renvoie true (localisée sur la carte), false (carte OsmAnd non reliée à une
// région géographique) ou null (non applicable : voix, polices…).
function computeLocated(item) {
  if (item.kind === 'voice' || item.kind === 'fonts') return null;
  const ck = matchCountryKey(item.country);
  if (!item.subregion) return !!ck; // carte du pays entier
  if (!ck) return false;
  const keys = buildAdmin1Keys().regionKeys.get(ck) || new Set();
  const subKeys = new Set();
  subKeys.add(normCountry(item.subregion));
  item.subregion.split('_').forEach((seg) => subKeys.add(normCountry(seg)));
  wordsOf(item.subregion.replace(/_/g, ' ')).forEach((w) => subKeys.add(w));
  for (const k of subKeys) {
    if (k && keys.has(k)) return true;
  }
  return false;
}

/**
 * Décompresse un buffer selon le Content-Encoding, ou selon les octets
 * magiques (gzip = 1f 8b) si le serveur ne renvoie pas l'en-tête.
 */
function decompress(buffer, encoding) {
  const enc = (encoding || '').toLowerCase();
  const isGzipMagic = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer).toString('utf-8');
    if (enc.includes('gzip') || isGzipMagic)
      return zlib.gunzipSync(buffer).toString('utf-8');
    if (enc.includes('deflate')) return zlib.inflateSync(buffer).toString('utf-8');
  } catch (e) {
    // En dernier recours on tente le gunzip si les octets magiques sont là.
    if (isGzipMagic) {
      try {
        return zlib.gunzipSync(buffer).toString('utf-8');
      } catch (_) {
        /* on retombe sur le texte brut */
      }
    }
  }
  return buffer.toString('utf-8');
}

/**
 * Récupère le contenu de list.php (suivi des redirections HTTP simples).
 * Résout avec { body, status, headers, contentType }.
 */
function fetchOsmandList(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('Trop de redirections'));
      return;
    }
    const target = new URL(url);
    const client = target.protocol === 'http:' ? http : https;

    const req = client.get(
      target,
      {
        headers: {
          // Certains serveurs refusent les clients sans User-Agent classique.
          'User-Agent':
            'Mozilla/5.0 (compatible; DlMapOsmAnd/1.0; +https://osmand.net)',
          Accept: 'application/xml,text/xml,*/*',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        timeout: 30000,
      },
      (res) => {
        const status = res.statusCode || 0;

        // Redirection.
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // vider le flux
          const next = new URL(res.headers.location, target).toString();
          resolve(fetchOsmandList(next, redirects + 1));
          return;
        }

        if (status !== 200) {
          res.resume();
          reject(new Error(`Réponse HTTP ${status} depuis ${target.host}`));
          return;
        }

        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const body = decompress(buf, res.headers['content-encoding']);
          resolve({
            body,
            status,
            headers: res.headers,
            contentType: res.headers['content-type'] || '',
          });
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('Délai dépassé (timeout)')));
    req.on('error', reject);
  });
}

/**
 * Décode les entités XML de base présentes dans les attributs.
 */
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Extrait tous les attributs d'un fragment de balise.
 */
function parseAttributes(tagBody) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tagBody)) !== null) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  return attrs;
}

// Derniers segments de nom correspondant à un « groupe » (continent ou grand
// pays subdivisé), à retirer pour isoler pays et sous-région.
const GROUPS = [
  'africa',
  'asia',
  'australia-oceania',
  'centralamerica',
  'europe',
  'north-america',
  'northamerica',
  'south-america',
  'southamerica',
  'us',
  'russia',
  'gb',
  'germany',
  'france',
  'italy',
  'spain',
];

/**
 * Retire les suffixes de fichier et le numéro de version, renvoie les
 * segments (pays, sous-région…, groupe).
 */
function baseParts(fileName) {
  const base = fileName
    .replace(
      /(_road)?(_srtm(_feet)?|_wiki|_depth)?\.(obf|extra|sqlite|tif|tif\.zip|wikivoyage\.obf)(\.zip)?$/i,
      ''
    )
    .replace(/\.(zip|gz|sqlite|tif|obf)$/i, '')
    .replace(/_\d+$/, ''); // numéro de version
  return base.split('_').filter(Boolean);
}

/**
 * Construit un nom lisible + continent à partir du nom de fichier OsmAnd.
 * Ex : "Afghanistan_asia_2.obf.zip" -> { label: "Afghanistan", region_group: "asia" }
 */
function humanizeName(fileName) {
  const parts = baseParts(fileName);

  let regionGroup = '';
  const lastLower = (parts[parts.length - 1] || '').toLowerCase();
  if (GROUPS.includes(lastLower)) {
    regionGroup = parts.pop();
  }

  const label = parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    label: label || fileName,
    region_group: regionGroup.toLowerCase(),
  };
}

/**
 * Isole le token de sous-région (segments entre le pays et le groupe).
 * "France_ile-de-france_europe_2.obf.zip" -> "ile-de-france"
 * "US_alabama_northamerica_2.obf.zip"      -> "alabama"
 * "France_europe_2.obf.zip"                -> "" (carte du pays entier)
 */
function subregionToken(fileName) {
  const parts = baseParts(fileName);
  if (parts.length && GROUPS.includes(parts[parts.length - 1].toLowerCase())) {
    parts.pop(); // groupe/continent
  }
  parts.shift(); // pays
  return parts.join('_').toLowerCase();
}

/**
 * Devine un type lisible à partir de l'attribut type et du nom de fichier.
 */
function detectKind(attrs) {
  const type = (attrs.type || '').toLowerCase();
  const name = (attrs.name || '').toLowerCase();

  if (type) return type;
  if (name.includes('_srtm')) return 'srtm_map';
  if (name.includes('_wiki')) return 'wikipedia';
  if (name.includes('.wikivoyage')) return 'wikivoyage';
  if (name.includes('_depth')) return 'depth';
  if (name.includes('_road.obf')) return 'road_map';
  if (name.endsWith('.ttf.zip')) return 'fonts';
  if (name.endsWith('_tts.js') || name.endsWith('_voice.zip')) return 'voice';
  if (name.includes('hillshade')) return 'hillshade';
  if (name.includes('slope')) return 'slope';
  if (name.endsWith('.obf.zip')) return 'map';
  return 'autre';
}

/**
 * Supprime les balises HTML internes d'un fragment et décode les entités.
 */
function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Construit un objet carte normalisé à partir des champs bruts.
 */
function buildItem({ name, date, size, description, type }) {
  const human = humanizeName(name);
  const sizeMb = size != null ? parseFloat(String(size).replace(',', '.')) : NaN;
  // Le premier segment du nom de fichier correspond au pays (ou entité de
  // premier niveau) : France_europe_2.obf.zip -> "france",
  // US_alabama_northamerica_2.obf.zip -> "us".
  const countryToken = name.split(/[_.]/)[0].toLowerCase();
  return {
    name,
    label: human.label,
    region_group: human.region_group,
    country: countryToken,
    country_label:
      countryToken.charAt(0).toUpperCase() + countryToken.slice(1),
    subregion: subregionToken(name),
    kind: detectKind({ name, type: type || '' }),
    type: type || '',
    description: description || '',
    date: date || '',
    size: Number.isFinite(sizeMb) ? sizeMb : null, // en Mo
    downloadUrl: `https://download.osmand.net/download.php?standard=yes&file=${encodeURIComponent(
      name
    )}`,
  };
}

/**
 * Parse le tableau HTML renvoyé par list.php.
 * Structure : <tr><td><a href="download?standard=yes&file=NOM">NOM</a></td>
 *                 <td>DATE</td><td>SIZE</td><td>DESCRIPTION</td></tr>
 */
function parseHtmlTable(html) {
  const items = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(html)) !== null) {
    const row = rm[1];
    const cells = [];
    const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cm;
    while ((cm = cellRe.exec(row)) !== null) cells.push(cm[1]);
    if (cells.length === 0) continue; // ligne d'en-tête (<th>) ou de mise en page

    // Première cellule : lien de téléchargement contenant le nom de fichier.
    const link = /href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(cells[0]);
    if (!link) continue;
    const href = decodeEntities(link[1]);
    if (!/file=/.test(href) && !/download/i.test(href)) continue;

    let name = stripTags(link[2]);
    if (!name) {
      const fp = /[?&]file=([^&"]+)/i.exec(href);
      if (fp) {
        try {
          name = decodeURIComponent(fp[1]);
        } catch (_) {
          name = fp[1];
        }
      }
    }
    if (!name) continue;

    items.push(
      buildItem({
        name,
        date: cells[1] ? stripTags(cells[1]) : '',
        size: cells[2] ? stripTags(cells[2]) : '',
        description: cells[3] ? stripTags(cells[3]) : '',
      })
    );
  }
  return items;
}

/**
 * Parse le format XML <osmand_regions> (endpoint get_indexes) — conservé en
 * repli au cas où la source renverrait du XML.
 */
function parseXml(xml) {
  const items = [];
  const tagRe = /<([\w:-]+)\b([^>]*?)\/?>/g;
  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    const tagName = m[1];
    const body = m[2];
    if (tagName === 'osmand_regions' || tagName === '?xml') continue;
    if (!/name\s*=/.test(body)) continue;

    const attrs = parseAttributes(body);
    if (!attrs.name) continue;

    items.push(
      buildItem({
        name: attrs.name,
        date: attrs.date,
        size: attrs.size,
        description: attrs.description,
        type: attrs.type,
      })
    );
  }
  return items;
}

/**
 * Détecte le format (HTML ou XML) et parse en conséquence.
 */
function parseList(body) {
  if (!body) return [];
  if (/<osmand_regions/i.test(body) || /<region\b[^>]*\bname\s*=/i.test(body)) {
    const xmlItems = parseXml(body);
    if (xmlItems.length) return xmlItems;
  }
  return parseHtmlTable(body);
}

// Jeu de données factice pour prévisualiser l'interface hors ligne
// (activé avec la variable d'environnement MOCK_MAPS=1).
function mockItems() {
  const raw = [
    ['France_europe_2.obf.zip', '17.09.2024', '520.0'],
    ['France_ile-de-france_europe_2.obf.zip', '17.09.2024', '85.0'],
    ['France_bretagne_europe_2.obf.zip', '17.09.2024', '60.0'],
    ['France_occitania_herault_europe_2.obf.zip', '17.09.2024', '30.0'],
    ['France_brittany_europe_2.obf.zip', '16.09.2024', '70.0'],
    ['France_normandy_europe_2.obf.zip', '16.09.2024', '65.0'],
    ['Germany_bayern_europe_2.obf.zip', '17.09.2024', '210.0'],
    ['Germany_sachsen_europe_2.obf.zip', '16.09.2024', '95.0'],
    ['Slovenia_europe_2.obf.zip', '11.09.2024', '55.0'],
    ['Spain_europe_2.obf.zip', '15.09.2024', '410.0'],
    ['Italy_europe_2.obf.zip', '14.09.2024', '390.0'],
    ['Russia_central-fed-district_europe_2.obf.zip', '10.09.2024', '150.0'],
    ['US_alabama_northamerica_2.obf.zip', '12.09.2024', '95.0'],
    ['Brazil_southamerica_2.obf.zip', '09.09.2024', '480.0'],
    ['China_asia_2.obf.zip', '08.09.2024', '600.0'],
    ['India_asia_2.obf.zip', '08.09.2024', '350.0'],
    ['Australia_australia-oceania_2.obf.zip', '07.09.2024', '300.0'],
    ['Japan_asia_2.obf.zip', '06.09.2024', '250.0'],
    ['Canada_northamerica_2.obf.zip', '05.09.2024', '700.0'],
    ['Morocco_africa_2.obf.zip', '04.09.2024', '90.0'],
    ['Egypt_africa_2.obf.zip', '03.09.2024', '110.0'],
    ['Argentina_southamerica_2.obf.zip', '02.09.2024', '260.0'],
  ];
  return raw.map(([name, date, size]) =>
    buildItem({ name, date, size, description: 'Carte de démonstration' })
  );
}

// Ajoute le champ `located` à chaque carte (corrélation avec la carte géo).
function addLocated(items) {
  try {
    for (const it of items) it.located = computeLocated(it);
  } catch (e) {
    console.warn('calcul localisation impossible :', e.message);
  }
  return items;
}

async function getMaps(force = false) {
  const now = manualNow();
  if (process.env.MOCK_MAPS === '1') {
    return { items: addLocated(mockItems()), cached: false, fetchedAt: now };
  }
  if (!force && cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { items: cache.data, cached: true, fetchedAt: cache.fetchedAt };
  }
  const res = await fetchOsmandList(OSMAND_LIST_URL);
  const items = addLocated(parseList(res.body));
  cache = { data: items, fetchedAt: now };
  return { items, cached: false, fetchedAt: now };
}

// Petit wrapper pour lire l'heure (facilite les tests / le remplacement).
function manualNow() {
  return new Date().getTime();
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(
    PUBLIC_DIR,
    pathname === '/' ? 'index.html' : pathname
  );

  // Protection basique contre le path traversal.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // HTML/JS/CSS : pas de cache -> une mise à jour est visible au 1er rechargement.
    // Données/images (fonds de carte lourds) : cache 1 jour.
    const noCache = ext === '.html' || ext === '.js' || ext === '.css';
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;

  if (pathname === '/api/maps') {
    try {
      const force = parsed.searchParams.get('refresh') === '1';
      const result = await getMaps(force);
      sendJson(res, 200, {
        ok: true,
        count: result.items.length,
        cached: result.cached,
        fetchedAt: result.fetchedAt,
        source: OSMAND_LIST_URL,
        items: result.items,
      });
    } catch (e) {
      sendJson(res, 502, {
        ok: false,
        error: e.message || String(e),
        hint: 'Impossible de joindre download.osmand.net. Vérifiez la connexion réseau du serveur.',
      });
    }
    return;
  }

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Renvoie les polygones des régions (états/provinces) d'un pays donné,
  // à la demande (le fichier complet reste côté serveur).
  if (pathname === '/api/regions') {
    const country = parsed.searchParams.get('country') || '';
    try {
      const features = getRegionsForCountry(country);
      sendJson(res, 200, {
        type: 'FeatureCollection',
        country,
        features,
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  // Endpoint de diagnostic : renvoie un extrait BRUT de la réponse de list.php
  // ainsi que le nombre d'éléments détectés. Utile pour comprendre le format
  // réel quand aucune carte ne remonte.
  if (pathname === '/api/raw') {
    try {
      const n = Math.min(
        parseInt(parsed.searchParams.get('n') || '4000', 10) || 4000,
        200000
      );
      const r = await fetchOsmandList(OSMAND_LIST_URL);
      const items = parseList(r.body);
      sendJson(res, 200, {
        ok: true,
        source: OSMAND_LIST_URL,
        httpStatus: r.status,
        contentType: r.contentType,
        contentEncoding: r.headers['content-encoding'] || null,
        bodyLength: r.body.length,
        detectedItems: items.length,
        firstItem: items[0] || null,
        sample: r.body.slice(0, n),
      });
    } catch (e) {
      sendJson(res, 502, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  serveStatic(req, res, pathname);
});

// Ne démarre le serveur que si le fichier est exécuté directement
// (permet d'importer les fonctions pour les tests).
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`DlMapOsmAnd v${VERSION} — écoute sur le port interne ${PORT}`);
    if (process.env.PUBLIC_URL) {
      console.log(`Accès : ${process.env.PUBLIC_URL}`);
    }
    console.log(`Source des cartes : ${OSMAND_LIST_URL}`);
  });
}

module.exports = {
  parseList,
  parseHtmlTable,
  parseXml,
  humanizeName,
  subregionToken,
  detectKind,
  parseAttributes,
  decompress,
};
