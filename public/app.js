'use strict';

(function () {
  const els = {
    search: document.getElementById('search'),
    country: document.getElementById('country'),
    kind: document.getElementById('kind'),
    group: document.getElementById('group'),
    sort: document.getElementById('sort'),
    refresh: document.getElementById('refresh'),
    status: document.getElementById('status'),
    results: document.getElementById('results'),
    empty: document.getElementById('empty'),
    mapReset: document.getElementById('mapReset'),
  };

  let allItems = [];
  let tokenCount = {}; // token pays -> nombre de cartes
  const MAX_RENDER = 500;

  // --- Carte ---
  let map = null;
  let geoLayer = null;
  let selectedToken = '';

  /* ---------------------------------------------------------------- utils */

  function norm(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z]/g, '');
  }

  // Correspondances explicites entre noms du GeoJSON et tokens OsmAnd
  // (utile là où les deux diffèrent fortement).
  const ALIASES = {
    unitedstatesofamerica: 'us',
    unitedstates: 'us',
    unitedkingdom: 'greatbritain',
    russia: 'russia',
    czechia: 'czechrepublic',
    southkorea: 'southkorea',
    republicofkorea: 'southkorea',
    democraticrepublicofthecongo: 'congodr',
    republicofthecongo: 'congo',
    ivorycoast: 'cotedivoire',
    bosniaandherzegovina: 'bosniaandherzegovina',
  };

  function formatSize(mb) {
    if (mb == null || Number.isNaN(mb)) return '—';
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' Go';
    return mb.toFixed(1) + ' Mo';
  }

  function kindLabel(kind) {
    const map = {
      map: 'Carte',
      road_map: 'Carte routière',
      srtm_map: 'Courbes de niveau',
      wikipedia: 'Wikipédia',
      wikivoyage: 'Wikivoyage',
      depth: 'Bathymétrie',
      hillshade: 'Ombrage',
      slope: 'Pente',
      fonts: 'Polices',
      voice: 'Voix',
      autre: 'Autre',
    };
    return map[kind] || kind;
  }

  function debounce(fn, delay) {
    let t;
    return function () {
      clearTimeout(t);
      const args = arguments;
      t = setTimeout(() => fn.apply(null, args), delay);
    };
  }

  /**
   * Retourne le token pays OsmAnd correspondant à une entité GeoJSON,
   * ou null s'il n'existe pas de carte pour ce pays.
   */
  function tokenForCountry(name) {
    const n = norm(name);
    if (ALIASES[n] && tokenCount[ALIASES[n]]) return ALIASES[n];

    // correspondance exacte
    if (tokenCount[n]) return n;

    // le nom du pays commence par le token (ex. token "czechrepublic")
    for (const t in tokenCount) {
      if (t.length >= 4 && (n === t || n.startsWith(t) || t.startsWith(n))) {
        return t;
      }
    }
    return null;
  }

  /* -------------------------------------------------------------- filtres */

  function populateFilters(items) {
    // Pays
    const byCountry = {};
    for (const it of items) {
      if (!byCountry[it.country]) byCountry[it.country] = it.country_label;
    }
    const countries = Object.keys(byCountry).sort((a, b) =>
      byCountry[a].localeCompare(byCountry[b], 'fr')
    );
    for (const c of countries) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = `${byCountry[c]} (${tokenCount[c]})`;
      els.country.appendChild(opt);
    }

    const kinds = Array.from(new Set(items.map((i) => i.kind))).sort();
    for (const k of kinds) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = kindLabel(k);
      els.kind.appendChild(opt);
    }

    const groups = Array.from(
      new Set(items.map((i) => i.region_group).filter(Boolean))
    ).sort();
    for (const g of groups) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g.charAt(0).toUpperCase() + g.slice(1).replace('-', ' ');
      els.group.appendChild(opt);
    }
  }

  function getFiltered() {
    const q = els.search.value.trim().toLowerCase();
    const country = els.country.value;
    const kind = els.kind.value;
    const group = els.group.value;
    const sort = els.sort.value;

    let out = allItems.filter((it) => {
      if (country && it.country !== country) return false;
      if (kind && it.kind !== kind) return false;
      if (group && it.region_group !== group) return false;
      if (q) {
        const hay = (it.label + ' ' + it.name + ' ' + it.description).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    out.sort((a, b) => {
      if (sort === 'size') return (b.size || 0) - (a.size || 0);
      if (sort === 'date') return dateVal(b.date) - dateVal(a.date);
      return a.label.localeCompare(b.label, 'fr');
    });

    return out;
  }

  // "17.09.2024" -> nombre comparable
  function dateVal(d) {
    const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(d || '');
    return m ? Number(m[3] + m[2] + m[1]) : 0;
  }

  /* --------------------------------------------------------------- rendu */

  function render() {
    const filtered = getFiltered();
    els.results.innerHTML = '';
    els.empty.hidden = filtered.length !== 0;
    els.mapReset.hidden = !(selectedToken || els.country.value);

    const shown = filtered.slice(0, MAX_RENDER);
    const frag = document.createDocumentFragment();

    for (const it of shown) {
      const card = document.createElement('article');
      card.className = 'card';

      const h3 = document.createElement('h3');
      h3.textContent = it.label;
      card.appendChild(h3);

      const fn = document.createElement('div');
      fn.className = 'filename';
      fn.textContent = it.name;
      card.appendChild(fn);

      const badges = document.createElement('div');
      badges.className = 'badges';
      const b1 = document.createElement('span');
      b1.className = 'badge';
      b1.textContent = kindLabel(it.kind);
      badges.appendChild(b1);
      if (it.region_group) {
        const b2 = document.createElement('span');
        b2.className = 'badge group';
        b2.textContent = it.region_group;
        badges.appendChild(b2);
      }
      card.appendChild(badges);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const size = document.createElement('span');
      size.textContent = formatSize(it.size);
      const date = document.createElement('span');
      date.textContent = it.date || '';
      meta.appendChild(size);
      meta.appendChild(date);
      card.appendChild(meta);

      const dl = document.createElement('a');
      dl.className = 'dl';
      dl.href = it.downloadUrl;
      dl.textContent = '⬇ Télécharger';
      dl.rel = 'noopener';
      card.appendChild(dl);

      frag.appendChild(card);
    }

    els.results.appendChild(frag);

    const extra =
      filtered.length > MAX_RENDER
        ? ` (${MAX_RENDER} premiers affichés — affinez la recherche)`
        : '';
    setStatus(`${filtered.length} carte(s) sur ${allItems.length}${extra}`);
  }

  function setStatus(msg, isError) {
    els.status.textContent = msg;
    els.status.classList.toggle('error', !!isError);
  }

  /* ---------------------------------------------------------------- carte */

  function styleFeature(feature) {
    const token = tokenForCountry(feature.properties && feature.properties.name);
    const available = !!token;
    const selected = token && token === selectedToken;
    return {
      color: '#ffffff',
      weight: selected ? 2 : 0.6,
      fillColor: selected ? '#c2410c' : available ? '#ea7500' : '#cbd5e1',
      fillOpacity: available ? (selected ? 0.95 : 0.75) : 0.35,
    };
  }

  function initMap(geojson) {
    map = L.map('map', {
      attributionControl: false,
      zoomControl: true,
      worldCopyJump: true,
      minZoom: 1,
      maxZoom: 6,
    });

    geoLayer = L.geoJSON(geojson, {
      style: styleFeature,
      onEachFeature: function (feature, layer) {
        const name = feature.properties && feature.properties.name;

        // Contenu calculé à l'ouverture -> reste juste même si les données
        // arrivent après l'affichage de la carte.
        layer.bindTooltip(
          function () {
            const t = tokenForCountry(name);
            return t
              ? `${name} — ${tokenCount[t]} carte(s)`
              : `${name} — aucune carte`;
          },
          { sticky: true }
        );

        layer.on({
          mouseover: function () {
            const t = tokenForCountry(name);
            layer.setStyle({ weight: 1.6, fillOpacity: t ? 0.9 : 0.5 });
          },
          mouseout: function () {
            geoLayer.resetStyle(layer);
          },
          click: function () {
            const t = tokenForCountry(name);
            if (!t) {
              setStatus(`${name} : aucune carte disponible.`);
              return;
            }
            selectedToken = t;
            els.country.value = t;
            els.search.value = '';
            geoLayer.setStyle(styleFeature);
            render();
            document
              .querySelector('.controls')
              .scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        });
      },
    }).addTo(map);

    map.fitBounds(geoLayer.getBounds(), { padding: [4, 4] });
  }

  function refreshMapStyles() {
    if (geoLayer) geoLayer.setStyle(styleFeature);
  }

  async function loadGeo() {
    try {
      const res = await fetch('/data/countries.geo.json');
      const geo = await res.json();
      initMap(geo);
    } catch (e) {
      const el = document.getElementById('map');
      if (el) el.innerHTML =
        '<div class="map-error">Carte indisponible : ' + e.message + '</div>';
    }
  }

  /* ----------------------------------------------------------- chargement */

  async function loadMaps(force) {
    setStatus('Chargement de la liste des cartes…');
    try {
      const res = await fetch('/api/maps' + (force ? '?refresh=1' : ''));
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Erreur inconnue');
      allItems = data.items;
      tokenCount = {};
      for (const it of allItems) {
        tokenCount[it.country] = (tokenCount[it.country] || 0) + 1;
      }
      populateFilters(allItems);
      refreshMapStyles();
      render();
    } catch (e) {
      setStatus('Erreur : ' + e.message, true);
    }
  }

  function resetSelection() {
    selectedToken = '';
    els.country.value = '';
    els.search.value = '';
    refreshMapStyles();
    render();
  }

  /* ------------------------------------------------------------ événements */

  els.search.addEventListener('input', debounce(render, 150));
  els.country.addEventListener('change', function () {
    selectedToken = els.country.value;
    refreshMapStyles();
    render();
  });
  els.kind.addEventListener('change', render);
  els.group.addEventListener('change', render);
  els.sort.addEventListener('change', render);
  els.refresh.addEventListener('click', () => loadMaps(true));
  els.mapReset.addEventListener('click', resetSelection);

  // Démarrage : carte d'abord (locale, rapide), puis les données OsmAnd.
  loadGeo().then(() => loadMaps(false));
})();
