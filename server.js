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
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const OSMAND_LIST_URL = 'https://download.osmand.net/list.php';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 heure

const PUBLIC_DIR = path.join(__dirname, 'public');

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

/**
 * Récupère le contenu de list.php (suivi des redirections HTTP simples).
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
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
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

/**
 * Construit un nom lisible + continent à partir du nom de fichier OsmAnd.
 * Ex : "Afghanistan_asia_2.obf.zip" -> { region: "Afghanistan", region_group: "asia" }
 */
function humanizeName(fileName) {
  let base = fileName
    // suffixes connus
    .replace(
      /(_road)?(_srtm(_feet)?|_wiki|_depth)?\.(obf|extra|sqlite|tif|tif\.zip|wikivoyage\.obf)(\.zip)?$/i,
      ''
    )
    .replace(/\.(zip|gz|sqlite|tif|obf)$/i, '')
    .replace(/_\d+$/, ''); // numéro de version

  const parts = base.split('_').filter(Boolean);
  const groups = [
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

  let regionGroup = '';
  const lastLower = (parts[parts.length - 1] || '').toLowerCase();
  if (groups.includes(lastLower)) {
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
 * Parse le XML de list.php en tableau d'objets.
 */
function parseList(xml) {
  const items = [];
  // Chaque carte est une balise auto-fermante <... .../> à l'intérieur de <osmand_regions>.
  const tagRe = /<([\w:-]+)\b([^>]*?)\/?>/g;
  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    const tagName = m[1];
    const body = m[2];
    if (tagName === 'osmand_regions' || tagName === '?xml') continue;
    if (!/name\s*=/.test(body)) continue; // il faut au moins un nom de fichier

    const attrs = parseAttributes(body);
    if (!attrs.name) continue;

    const human = humanizeName(attrs.name);
    const sizeMb = attrs.size ? parseFloat(attrs.size) : null;

    items.push({
      name: attrs.name,
      label: human.label,
      region_group: human.region_group,
      kind: detectKind(attrs),
      type: attrs.type || '',
      description: attrs.description || '',
      date: attrs.date || '',
      timestamp: attrs.timestamp ? Number(attrs.timestamp) : null,
      size: Number.isFinite(sizeMb) ? sizeMb : null, // en Mo (décompressé)
      targetsize: attrs.targetsize ? parseFloat(attrs.targetsize) : null,
      containerSize: attrs.containerSize ? Number(attrs.containerSize) : null,
      contentSize: attrs.contentSize ? Number(attrs.contentSize) : null,
      downloadUrl: `https://download.osmand.net/download.php?standard=yes&file=${encodeURIComponent(
        attrs.name
      )}`,
    });
  }
  return items;
}

async function getMaps(force = false) {
  const now = manualNow();
  if (!force && cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { items: cache.data, cached: true, fetchedAt: cache.fetchedAt };
  }
  const xml = await fetchOsmandList(OSMAND_LIST_URL);
  const items = parseList(xml);
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
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
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

  serveStatic(req, res, pathname);
});

// Ne démarre le serveur que si le fichier est exécuté directement
// (permet d'importer les fonctions pour les tests).
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`DlMapOsmAnd démarré sur http://localhost:${PORT}`);
    console.log(`Source des cartes : ${OSMAND_LIST_URL}`);
  });
}

module.exports = { parseList, humanizeName, detectKind, parseAttributes };
