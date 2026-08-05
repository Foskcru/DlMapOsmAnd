'use strict';

(function () {
  const els = {
    search: document.getElementById('search'),
    kind: document.getElementById('kind'),
    group: document.getElementById('group'),
    sort: document.getElementById('sort'),
    refresh: document.getElementById('refresh'),
    status: document.getElementById('status'),
    results: document.getElementById('results'),
    empty: document.getElementById('empty'),
  };

  let allItems = [];
  const MAX_RENDER = 500; // limite d'affichage pour rester fluide

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

  function populateFilters(items) {
    const kinds = Array.from(new Set(items.map((i) => i.kind))).sort();
    const groups = Array.from(
      new Set(items.map((i) => i.region_group).filter(Boolean))
    ).sort();

    for (const k of kinds) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = kindLabel(k);
      els.kind.appendChild(opt);
    }
    for (const g of groups) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g.charAt(0).toUpperCase() + g.slice(1).replace('-', ' ');
      els.group.appendChild(opt);
    }
  }

  function getFiltered() {
    const q = els.search.value.trim().toLowerCase();
    const kind = els.kind.value;
    const group = els.group.value;
    const sort = els.sort.value;

    let out = allItems.filter((it) => {
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
      if (sort === 'date') return (b.timestamp || 0) - (a.timestamp || 0);
      return a.label.localeCompare(b.label, 'fr');
    });

    return out;
  }

  function render() {
    const filtered = getFiltered();
    els.results.innerHTML = '';

    if (filtered.length === 0) {
      els.empty.hidden = false;
    } else {
      els.empty.hidden = true;
    }

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
    setStatus(
      `${filtered.length} carte(s) sur ${allItems.length}${extra}`
    );
  }

  function setStatus(msg, isError) {
    els.status.textContent = msg;
    els.status.classList.toggle('error', !!isError);
  }

  async function load(force) {
    setStatus('Chargement de la liste des cartes…');
    els.results.innerHTML = '';
    try {
      const res = await fetch('/api/maps' + (force ? '?refresh=1' : ''));
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || 'Erreur inconnue');
      }
      allItems = data.items;
      populateFilters(allItems);
      render();
    } catch (e) {
      setStatus('Erreur : ' + e.message, true);
    }
  }

  // Événements
  els.search.addEventListener('input', debounce(render, 150));
  els.kind.addEventListener('change', render);
  els.group.addEventListener('change', render);
  els.sort.addEventListener('change', render);
  els.refresh.addEventListener('click', () => load(true));

  load(false);
})();
