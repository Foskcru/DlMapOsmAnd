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
    themeToggle: document.getElementById('themeToggle'),
  };

  /* ---------------------------------------------------------------- thème */

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem('theme', t);
    } catch (e) {
      /* ignore */
    }
    if (els.themeToggle) els.themeToggle.textContent = t === 'dark' ? '☀️' : '🌙';
  }
  applyTheme(currentTheme());
  if (els.themeToggle) {
    els.themeToggle.addEventListener('click', function () {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });
  }

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

  // Retire les accents d'un texte affiché (en gardant la casse), pour un
  // rendu uniforme et sans souci d'accents.
  function noAccent(s) {
    return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
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

  /* ------------------------------------------------------ traduction FR */

  // Continents / grands groupes OsmAnd -> français.
  const GROUP_FR = {
    africa: 'Afrique',
    asia: 'Asie',
    'australia-oceania': 'Australie-Océanie',
    centralamerica: 'Amérique centrale',
    europe: 'Europe',
    'north-america': 'Amérique du Nord',
    northamerica: 'Amérique du Nord',
    'south-america': 'Amérique du Sud',
    southamerica: 'Amérique du Sud',
    us: 'États-Unis',
    russia: 'Russie',
    gb: 'Royaume-Uni',
    germany: 'Allemagne',
    france: 'France',
    italy: 'Italie',
    spain: 'Espagne',
  };

  // Régions françaises (slug OsmAnd -> nom français), clés normalisées.
  const REGION_FR = {
    iledefrance: 'Île-de-France',
    provencealpescotedazur: 'Provence-Alpes-Côte d’Azur',
    auvergnerhonealpes: 'Auvergne-Rhône-Alpes',
    bourgognefranchecomte: 'Bourgogne-Franche-Comté',
    brittany: 'Bretagne',
    centreloirevalley: 'Centre-Val de Loire',
    greateast: 'Grand Est',
    hautsdefrance: 'Hauts-de-France',
    newaquitaine: 'Nouvelle-Aquitaine',
    normandy: 'Normandie',
    occitania: 'Occitanie',
    paysdelaloire: 'Pays de la Loire',
    corse: 'Corse',
  };

  // Pays (token OsmAnd normalisé -> français). Liste des principaux ; les
  // autres retombent sur une version « jolie » du nom d'origine.
  const COUNTRY_FR = {
    france: 'France', germany: 'Allemagne', spain: 'Espagne', italy: 'Italie',
    portugal: 'Portugal', belgium: 'Belgique', netherlands: 'Pays-Bas',
    luxembourg: 'Luxembourg', switzerland: 'Suisse', austria: 'Autriche',
    poland: 'Pologne', czechrepublic: 'Tchéquie', slovakia: 'Slovaquie',
    hungary: 'Hongrie', romania: 'Roumanie', bulgaria: 'Bulgarie',
    greece: 'Grèce', croatia: 'Croatie', slovenia: 'Slovénie',
    serbia: 'Serbie', bosniaandherzegovina: 'Bosnie-Herzégovine',
    montenegro: 'Monténégro', albania: 'Albanie', northmacedonia: 'Macédoine du Nord',
    macedonia: 'Macédoine du Nord', kosovo: 'Kosovo', denmark: 'Danemark',
    sweden: 'Suède', norway: 'Norvège', finland: 'Finlande', iceland: 'Islande',
    ireland: 'Irlande', greatbritain: 'Royaume-Uni', unitedkingdom: 'Royaume-Uni',
    england: 'Angleterre', scotland: 'Écosse', wales: 'Pays de Galles',
    estonia: 'Estonie', latvia: 'Lettonie', lithuania: 'Lituanie',
    belarus: 'Biélorussie', ukraine: 'Ukraine', moldova: 'Moldavie',
    russia: 'Russie', turkey: 'Turquie', cyprus: 'Chypre', malta: 'Malte',
    us: 'États-Unis', unitedstatesofamerica: 'États-Unis', canada: 'Canada',
    mexico: 'Mexique', brazil: 'Brésil', argentina: 'Argentine', chile: 'Chili',
    peru: 'Pérou', colombia: 'Colombie', venezuela: 'Venezuela', bolivia: 'Bolivie',
    ecuador: 'Équateur', paraguay: 'Paraguay', uruguay: 'Uruguay',
    china: 'Chine', japan: 'Japon', southkorea: 'Corée du Sud', northkorea: 'Corée du Nord',
    india: 'Inde', pakistan: 'Pakistan', bangladesh: 'Bangladesh', vietnam: 'Viêt Nam',
    thailand: 'Thaïlande', cambodia: 'Cambodge', laos: 'Laos', myanmar: 'Birmanie',
    malaysia: 'Malaisie', singapore: 'Singapour', indonesia: 'Indonésie',
    philippines: 'Philippines', taiwan: 'Taïwan', mongolia: 'Mongolie',
    kazakhstan: 'Kazakhstan', uzbekistan: 'Ouzbékistan', afghanistan: 'Afghanistan',
    iran: 'Iran', iraq: 'Irak', syria: 'Syrie', lebanon: 'Liban', jordan: 'Jordanie',
    israel: 'Israël', saudiarabia: 'Arabie saoudite', yemen: 'Yémen', oman: 'Oman',
    unitedarabemirates: 'Émirats arabes unis', qatar: 'Qatar', kuwait: 'Koweït',
    georgia: 'Géorgie', armenia: 'Arménie', azerbaijan: 'Azerbaïdjan',
    morocco: 'Maroc', algeria: 'Algérie', tunisia: 'Tunisie', libya: 'Libye',
    egypt: 'Égypte', sudan: 'Soudan', ethiopia: 'Éthiopie', kenya: 'Kenya',
    tanzania: 'Tanzanie', uganda: 'Ouganda', nigeria: 'Nigéria', ghana: 'Ghana',
    ivorycoast: 'Côte d’Ivoire', cotedivoire: 'Côte d’Ivoire', senegal: 'Sénégal',
    cameroon: 'Cameroun', southafrica: 'Afrique du Sud', namibia: 'Namibie',
    botswana: 'Botswana', zimbabwe: 'Zimbabwe', mozambique: 'Mozambique',
    madagascar: 'Madagascar', angola: 'Angola', congo: 'Congo',
    congodr: 'République démocratique du Congo', mali: 'Mali', niger: 'Niger',
    chad: 'Tchad', mauritania: 'Mauritanie', australia: 'Australie',
    newzealand: 'Nouvelle-Zélande',
  };

  function prettify(token) {
    return String(token || '')
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  function frCountry(token) {
    return noAccent(COUNTRY_FR[norm(token)] || prettify(token));
  }

  function frGroup(g) {
    return noAccent(GROUP_FR[g] || prettify(g));
  }

  function frSub(sub) {
    return noAccent(
      String(sub || '')
        .split('_')
        .filter(Boolean)
        .map((seg) => REGION_FR[norm(seg)] || prettify(seg))
        .join(' — ')
    );
  }

  // Titre français d'une carte, ex. "France — Occitanie — Herault".
  function frLabel(item) {
    const c = frCountry(item.country);
    return item.subregion ? c + ' — ' + frSub(item.subregion) : c;
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
  // Régions administratives (nom Natural Earth) -> slug OsmAnd normalisé,
  // pour les cas où OsmAnd traduit/renomme (surtout la France).
  const REGION_ALIAS = {
    occitanie: 'occitania',
    grandest: 'greateast',
    nouvelleaquitaine: 'newaquitaine',
    bretagne: 'brittany',
    normandie: 'normandy',
    centrevaldeloire: 'centreloirevalley',
  };

  function regionKey(regionName) {
    const k = norm(regionName);
    return REGION_ALIAS[k] || k;
  }

  /**
   * Sous-région OsmAnd correspondant à une entité région GeoJSON, sinon null.
   * 1) correspondance au niveau du département (nom de l'entité) -> carte dédiée
   * 2) sinon correspondance au niveau de la région parente -> carte de région
   */
  function subForRegion(props, token) {
    const selfKeys = new Set(
      [props.name, props.name_local, props.name_alt].map(norm).filter(Boolean)
    );
    const parentKey = props.region ? regionKey(props.region) : '';

    const subs = subsByCountry[token] || [];
    let regionMatch = null;
    for (const sub of subs) {
      const segs = sub.split('_').map(norm);
      // 1) département : un segment == nom de l'entité (le plus précis)
      if (segs.some((s) => selfKeys.has(s))) return sub;
      // 2) région : un segment == région parente (mémorisé en repli)
      if (!regionMatch && parentKey && segs.some((s) => s === parentKey)) {
        regionMatch = sub;
      }
    }
    return regionMatch;
  }

  /* -------------------------------------------------------------- filtres */

  function populateFilters(items) {
    const countries = Array.from(new Set(items.map((i) => i.country)));
    countries
      .sort((a, b) => frCountry(a).localeCompare(frCountry(b), 'fr'))
      .forEach((c) => {
        const o = document.createElement('option');
        o.value = c;
        o.textContent = `${frCountry(c)} (${tokenCount[c]})`;
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
      .sort((a, b) => frGroup(a).localeCompare(frGroup(b), 'fr'))
      .forEach((g) => {
        const o = document.createElement('option');
        o.value = g;
        o.textContent = frGroup(g);
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
        const hay = (
          frLabel(it) + ' ' + it.label + ' ' + it.name + ' ' + it.description
        ).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    out.sort((a, b) => {
      if (sort === 'size') return (b.size || 0) - (a.size || 0);
      if (sort === 'date') return dateVal(b.date) - dateVal(a.date);
      return frLabel(a).localeCompare(frLabel(b), 'fr');
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
    h3.textContent = frLabel(it); // nom en français
    card.appendChild(h3);

    const fn = document.createElement('div');
    fn.className = 'filename';
    fn.textContent = it.name; // vrai nom de fichier conservé
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
      b2.textContent = frGroup(it.region_group);
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
    // Pays sélectionné : on masque complètement son contour (basse résolution)
    // car les régions détaillées prennent le relais par-dessus. Ça évite le
    // « double littoral » disgracieux.
    if (selected) {
      return { weight: 0, opacity: 0, fillOpacity: 0 };
    }
    // Quand on est en mode zoom/régions, on estompe les autres pays.
    const dimmed = !!selectedToken;
    return {
      color: '#ffffff',
      weight: 0.6,
      fillColor: available ? '#ea7500' : '#cbd5e1',
      fillOpacity: dimmed
        ? available
          ? 0.28
          : 0.18
        : available
        ? 0.72
        : 0.35,
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
            const disp = t ? frCountry(t) : name;
            return t ? `${disp} — ${tokenCount[t]} carte(s)` : `${disp} — aucune carte`;
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

    const label = frCountry(token);
    if (feats.length) {
      regionLayer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
        style: styleRegion,
        onEachFeature: function (feature, layer) {
          const props = feature.properties || {};
          layer.bindTooltip(
            function () {
              const sub = subForRegion(props, selectedToken);
              const nm = noAccent(props.name);
              return sub ? `${nm} ✓ carte dispo` : `${nm}`;
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
                  `« ${noAccent(props.name)} » n'a pas de carte dédiée — choisissez une région disponible dans la liste ci-dessous.`
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
    // Pas de défilement automatique ici : on reste sur la carte pour pouvoir
    // cliquer une région. Le défilement vers la liste se fait au clic région.
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
