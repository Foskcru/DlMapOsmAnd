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
    mapHint: document.getElementById('mapHint'),
  };

  let allItems = [];
  let tokenCount = {}; // token pays -> nombre de cartes
  let subsByCountry = {}; // token pays -> [tokens de sous-régions]
  const MAX_RENDER = 500;

  // --- Carte ---
  let map = null;
  let geoLayer = null; // pays (monde)
  let regionLayer = null; // régions du pays sélectionné
  let worldLayers = []; // [{ name, layer }]
  let selectedToken = ''; // pays sélectionné (token OsmAnd)
  let selectedSub = ''; // sous-région sélectionnée (token)

  /* ---------------------------------------------------------------- utils */

  function norm(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  const ALIASES = {
    unitedstatesofamerica: 'us',
    unitedstates: 'us',
    unitedkingdom: 'greatbritain',
    czechia: 'czechrepublic',
    republicofkorea: 'southkorea',
    democraticrepublicofthecongo: 'congodr',
    ivorycoast: 'cotedivoire',
  };

  function formatSize(mb) {
    if (mb == null || Number.isNaN(mb)) return '—';
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' Go';
    return mb.toFixed(1) + ' Mo';
  }

  function kindLabel(kind) {
    const m = {
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
    return m[kind] || kind;
  }

  function debounce(fn, delay) {
    let t;
    return function () {
      clearTimeout(t);
      const a = arguments;
      t = setTimeout(() => fn.apply(null, a), delay);
    };
  }

  function dateVal(d) {
    const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(d || '');
    return m ? Number(m[3] + m[2] + m[1]) : 0;
  }

  /** Token pays OsmAnd correspondant au nom d'un pays GeoJSON, sinon null. */
  function tokenForCountry(name) {
    const n = norm(name);
    if (ALIASES[n] && tokenCount[ALIASES[n]]) return ALIASES[n];
    if (tokenCount[n]) return n;
    for (const t in tokenCount) {
      if (t.length >= 4 && (n === t || n.startsWith(t) || t.startsWith(n))) {
        return t;
      }
    }
    return null;
  }

  /** Nom (GeoJSON) d'un pays à partir de son token, ou null. */
  function nameForToken(token) {
    for (const w of worldLayers) {
      if (tokenForCountry(w.name) === token) return w.name;
    }
    return null;
  }

  /**
   * Sous-région OsmAnd correspondant à une entité région GeoJSON, sinon null.
   * Correspondance EXACTE (après normalisation) pour éviter les faux positifs
   * du type « Sachsen » ↔ « Sachsen-Anhalt ».
   */
  function subForRegion(props, token) {
    const cands = new Set(
      [props.name, props.name_local, props.name_alt].map(norm).filter(Boolean)
    );
    for (const sub of subsByCountry[token] || []) {
      // OsmAnd imbrique parfois région ET département (ex.
      // "occitania_herault"). On teste le token entier ET chacun de ses
      // segments -> "Hérault" correspond à "occitania_herault".
      const keys = [norm(sub)].concat(sub.split('_').map(norm));
      for (const k of keys) {
        if (k && cands.has(k)) return sub;
      }
    }
    return null;
  }

  /* -------------------------------------------------------------- filtres */

  function populateFilters(items) {
    const byCountry = {};
    for (const it of items) if (!byCountry[it.country]) byCountry[it.country] = it.country_label;
    Object.keys(byCountry)
      .sort((a, b) => byCountry[a].localeCompare(byCountry[b], 'fr'))
      .forEach((c) => {
        const o = document.createElement('option');
        o.value = c;
        o.textContent = `${byCountry[c]} (${tokenCount[c]})`;
        els.country.appendChild(o);
      });

    Array.from(new Set(items.map((i) => i.kind)))
      .sort()
      .forEach((k) => {
        const o = document.createElement('option');
        o.value = k;
        o.textContent = kindLabel(k);
        els.kind.appendChild(o);
      });

    Array.from(new Set(items.map((i) => i.region_group).filter(Boolean)))
      .sort()
      .forEach((g) => {
        const o = document.createElement('option');
        o.value = g;
        o.textContent = g.charAt(0).toUpperCase() + g.slice(1).replace('-', ' ');
        els.group.appendChild(o);
      });
  }

  function getFiltered() {
    const q = els.search.value.trim().toLowerCase();
    const country = els.country.value;
    const kind = els.kind.value;
    const group = els.group.value;
    const sort = els.sort.value;

    let out = allItems.filter((it) => {
      if (country && it.country !== country) return false;
      if (selectedSub && it.subregion !== selectedSub) return false;
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

  /* --------------------------------------------------------------- rendu */

  function render() {
    const filtered = getFiltered();
    els.results.innerHTML = '';
    els.empty.hidden = filtered.length !== 0;
    els.mapReset.hidden = !(selectedToken || els.country.value || selectedSub);

    const shown = filtered.slice(0, MAX_RENDER);
    const frag = document.createDocumentFragment();
    for (const it of shown) frag.appendChild(cardFor(it));
    els.results.appendChild(frag);

    const extra =
      filtered.length > MAX_RENDER
        ? ` (${MAX_RENDER} premiers affichés — affinez la recherche)`
        : '';
    setStatus(`${filtered.length} carte(s) sur ${allItems.length}${extra}`);
  }

  function cardFor(it) {
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
    return card;
  }

  function setStatus(msg, isError) {
    els.status.textContent = msg;
    els.status.classList.toggle('error', !!isError);
  }

  function setHint(msg) {
    if (els.mapHint) els.mapHint.textContent = msg || '';
  }

  /* ---------------------------------------------------------------- carte */

  function styleCountry(feature) {
    const token = tokenForCountry(feature.properties && feature.properties.name);
    const available = !!token;
    const selected = token && token === selectedToken;
    return {
      color: '#ffffff',
      weight: selected ? 1.5 : 0.6,
      fillColor: available ? '#ea7500' : '#cbd5e1',
      fillOpacity: available ? (selected ? 0.25 : 0.72) : 0.35,
    };
  }

  function styleRegion(feature) {
    const sub = subForRegion(feature.properties || {}, selectedToken);
    const available = !!sub;
    const selected = sub && sub === selectedSub;
    return {
      color: '#7c2d12',
      weight: selected ? 2.4 : 0.8,
      fillColor: selected ? '#c2410c' : available ? '#f59e0b' : '#e2e8f0',
      fillOpacity: available ? (selected ? 0.95 : 0.7) : 0.25,
    };
  }

  function initMap(geojson) {
    map = L.map('map', {
      attributionControl: false,
      worldCopyJump: true,
      minZoom: 1,
      maxZoom: 8,
    });

    geoLayer = L.geoJSON(geojson, {
      style: styleCountry,
      onEachFeature: function (feature, layer) {
        const name = feature.properties && feature.properties.name;
        worldLayers.push({ name, layer });

        layer.bindTooltip(
          function () {
            const t = tokenForCountry(name);
            return t ? `${name} — ${tokenCount[t]} carte(s)` : `${name} — aucune carte`;
          },
          { sticky: true }
        );

        layer.on({
          mouseover: function () {
            if (selectedToken) return;
            const t = tokenForCountry(name);
            layer.setStyle({ weight: 1.4, fillOpacity: t ? 0.9 : 0.5 });
          },
          mouseout: function () {
            if (!selectedToken) geoLayer.resetStyle(layer);
          },
          click: function () {
            const t = tokenForCountry(name);
            if (!t) {
              setStatus(`${name} : aucune carte disponible.`);
              return;
            }
            selectCountry(t, name);
          },
        });
      },
    }).addTo(map);

    map.fitBounds(geoLayer.getBounds(), { padding: [4, 4] });
    setHint('Cliquez un pays coloré pour zoomer et voir ses régions.');
  }

  function refreshCountryStyles() {
    if (geoLayer) geoLayer.setStyle(styleCountry);
  }

  function clearRegionLayer() {
    if (regionLayer) {
      map.removeLayer(regionLayer);
      regionLayer = null;
    }
  }

  /** Sélectionne un pays : filtre la liste, zoome et dessine ses régions. */
  async function selectCountry(token, name) {
    selectedToken = token;
    selectedSub = '';
    els.country.value = token;
    els.search.value = '';
    refreshCountryStyles();
    render();

    if (!name) name = nameForToken(token);

    // Zoom sur le pays.
    const w = worldLayers.find((x) => x.name === name);
    if (w) map.fitBounds(w.layer.getBounds(), { padding: [10, 10] });

    // Dessin des régions du pays.
    clearRegionLayer();
    setHint('Chargement des régions…');
    let feats = [];
    if (name) {
      try {
        const res = await fetch('/api/regions?country=' + encodeURIComponent(name));
        const gj = await res.json();
        feats = gj.features || [];
      } catch (_) {
        feats = [];
      }
    }

    const label = w ? w.name : token;
    if (feats.length) {
      regionLayer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
        style: styleRegion,
        onEachFeature: function (feature, layer) {
          const props = feature.properties || {};
          layer.bindTooltip(
            function () {
              const sub = subForRegion(props, selectedToken);
              return sub ? `${props.name} ✓ carte dispo` : `${props.name}`;
            },
            { sticky: true }
          );
          layer.on({
            mouseover: function () {
              layer.setStyle({ weight: 2 });
            },
            mouseout: function () {
              regionLayer.resetStyle(layer);
            },
            click: function (e) {
              if (e.originalEvent) e.originalEvent.stopPropagation();
              const sub = subForRegion(props, selectedToken);
              if (sub) {
                selectedSub = sub;
                regionLayer.setStyle(styleRegion);
                render();
              } else {
                selectedSub = '';
                render();
                setHint(
                  `« ${props.name} » n'a pas de carte dédiée — choisissez une région disponible dans la liste ci-dessous.`
                );
              }
              scrollToResults();
            },
          });
        },
      }).addTo(map);
      setHint(
        `${label} : cliquez une région colorée sur la carte, ou choisissez dans la liste ci-dessous.`
      );
    } else {
      setHint(
        `${label} : régions non disponibles sur la carte, choisissez dans la liste ci-dessous.`
      );
    }

    scrollToResults();
  }

  function scrollToResults() {
    const el = document.querySelector('.controls');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function resetSelection() {
    selectedToken = '';
    selectedSub = '';
    els.country.value = '';
    els.search.value = '';
    clearRegionLayer();
    refreshCountryStyles();
    render();
    if (geoLayer) map.fitBounds(geoLayer.getBounds(), { padding: [4, 4] });
    setHint('Cliquez un pays coloré pour zoomer et voir ses régions.');
  }

  async function loadGeo() {
    try {
      const res = await fetch('/data/countries.geo.json');
      const geo = await res.json();
      initMap(geo);
    } catch (e) {
      const el = document.getElementById('map');
      if (el)
        el.innerHTML = '<div class="map-error">Carte indisponible : ' + e.message + '</div>';
    }
  }

  async function loadMaps(force) {
    setStatus('Chargement de la liste des cartes…');
    try {
      const res = await fetch('/api/maps' + (force ? '?refresh=1' : ''));
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Erreur inconnue');
      allItems = data.items;
      tokenCount = {};
      subsByCountry = {};
      for (const it of allItems) {
        tokenCount[it.country] = (tokenCount[it.country] || 0) + 1;
        if (it.subregion) {
          (subsByCountry[it.country] = subsByCountry[it.country] || []).push(it.subregion);
        }
      }
      populateFilters(allItems);
      refreshCountryStyles();
      render();
    } catch (e) {
      setStatus('Erreur : ' + e.message, true);
    }
  }

  /* ------------------------------------------------------------ événements */

  els.search.addEventListener('input', debounce(render, 150));
  els.country.addEventListener('change', function () {
    const t = els.country.value;
    if (t) selectCountry(t);
    else resetSelection();
  });
  els.kind.addEventListener('change', render);
  els.group.addEventListener('change', render);
  els.sort.addEventListener('change', render);
  els.refresh.addEventListener('click', () => loadMaps(true));
  els.mapReset.addEventListener('click', resetSelection);

  loadGeo().then(() => loadMaps(false));
})();
