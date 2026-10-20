/* Mapa de calor de la droguería: ubica cada laboratorio en un anaquel (sin partirlo) y colorea
   los anaqueles según su movimiento o stock.
   - Piso 1: laboratorios "pesados" (leches, jarabes, cloruros, sueros…), los de más movimiento cerca de despacho.
   - Piso 2, anaqueles 1: el resto, repartido para que cada anaquel (y su responsable) tenga una carga pareja.
   - Piso 2, anaqueles 2 (zona del fondo): Colgate, dermocosmética y dental.
   Las zonas de cada laboratorio y los responsables se pueden cambiar y se guardan (proy_config/mapa). */
(() => {
  const $ = id => document.getElementById(id);
  const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const nf0 = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 0 });

  // Planos: los croquis en PDF pasados a SVG (planos/pisoN.svg) y, encima, cada anaquel con sus medidas del PDF (en puntos)
  const R = (id, x0, y0, x1, y1, extra = {}) => ({ id, x: x0, y: y0, w: x1 - x0, h: y1 - y0, ...extra });
  const racks = [];
  for (let k = 0; k < 8; k++) {
    const x0 = 412 + k * 30.75;
    racks.push(R('R' + (k + 1), x0, 238, x0 + 30.75, 267, { t: String(k + 1) }), R('R' + (k + 9), x0, 268, x0 + 30.75, 298, { t: String(k + 9) }));
  }
  const PISOS = {
    1: {
      nombre: 'Primer piso', fondo: 'planos/piso1.svg?v=202610201700', vb: '55 62 715 470',
      anaqueles: [
        R('A1', 415, 136, 660, 159, { t: 'Aprobados 1' }), R('A2', 415, 185, 661, 209, { t: 'Aprobados 2' }),
        R('A3', 371, 111, 383, 250, { t: 'A3' }), R('A4', 618, 93, 688, 112, { t: 'A4' }), R('A5', 690, 102, 714, 243, { t: 'A5' }),
        ...racks,
        R('R17', 656, 326, 689, 358, { t: '17' }), R('R18', 660, 358, 692, 390, { t: '18' }),
        R('R19', 640, 425, 668, 455, { t: '19' }), R('R20', 640, 458, 668, 481, { t: '20' }), R('R23', 670, 458, 698, 481, { t: '23' }),
        R('R21', 640, 483, 668, 505, { t: '21' }), R('R22', 670, 483, 698, 505, { t: '22' }),
        R('K1', 503, 376, 530, 408, { t: 'K1' }), R('K2', 573, 376, 604, 406, { t: 'K2' }), R('K3', 578, 478, 600, 500, { t: 'K3' }),
        R('E1', 605, 397, 617, 502, { t: 'E1' }), R('E2', 723, 407, 738, 511, { t: 'E2' })
      ],
      cerca: [448, 440] // despacho: lo que más se mueve va más cerca
    },
    2: {
      nombre: 'Segundo piso', fondo: 'planos/piso2.svg?v=202610201700', vb: '85 90 660 415',
      anaqueles: [
        R('P1', 201, 129, 238, 425, { t: 'Anaquel 1', zona: 'p2' }), R('P2', 249, 129, 286, 426, { t: 'Anaquel 2', zona: 'p2' }),
        R('P3', 296, 130, 334, 427, { t: 'Anaquel 3', zona: 'p2' }), R('P4', 343, 130, 382, 427, { t: 'Anaquel 4', zona: 'p2' }),
        R('P5', 391, 130, 428, 427, { t: 'Anaquel 5', zona: 'p2' }), R('P6', 438, 131, 461, 361, { t: 'Anaquel 6', zona: 'p2' }),
        R('Z1', 460, 364, 723, 378, { t: 'Zona 2 · A', zona: 'z2' }), R('Z2', 708, 379, 722, 477, { t: 'Zona 2 · B', zona: 'z2' }),
        R('Z3', 482, 403, 679, 432, { t: 'Zona 2 · C', zona: 'z2' })
      ]
    }
  };

  const PESADO = /LECHE|FORMULA|\bNAN\b|ENFA|SIMILAC|NUTRILON|PEDIASURE|ENSURE|GLUCERNA|JARABE|\bJBE\b|SUSP|CLORURO|SUERO|DEXTROSA|SOLUCION|\bSOL\b|\bFCO\b|FRASCO|GALON|\b1\s?L\b|1000\s?ML|500\s?ML|AGUA|ALCOHOL|ELECTROLIT/;
  const ZONA2 = /COLGATE|ORAL B|DENTAID|DENTWORLD|DENTAL|EUCERIN|BIODERMA|ISDIN|LAROCHE|LA ROCHE|ISISPHARMA|AVENE|GALDERMA|CERAVE|VICHY|SESDERMA|URIAGE|DERMATOLOG/;
  const ZONAS = { p1: 'Piso 1 · pesados', p2: 'Piso 2 · anaqueles 1', z2: 'Piso 2 · zona 2 (Colgate, dermo, dental)' };

  const M = { piso: 2, medida: 'mov', sel: null, cfg: null, cargando: false };

  async function cargarCfg() {
    if (M.cfg || M.cargando) return; M.cargando = true;
    try { const d = await S.db?.doc('config/mapa').get(); M.cfg = d?.exists ? d.data() : {}; } catch { M.cfg = {}; }
    M.cfg.zona ??= {}; M.cfg.resp ??= {}; M.cfg.fijo ??= {}; M.cargando = false; pintar();
  }
  let tGuardar;
  function guardar() { clearTimeout(tGuardar); tGuardar = setTimeout(() => S.db?.doc('config/mapa').set(M.cfg).catch(() => toast('No se pudo guardar el mapa')), 500); }

  // movimiento (cajas al mes, promedio 3 meses), stock en droguería y peso de cada laboratorio
  function laboratorios() {
    const L = new Map();
    for (const p of S.P.p) {
      const lab = labDe(p.c) || 'SIN LABORATORIO', mov = Math.max(0, S.calc.get(p.c)?.prom || 0), st = Math.max(0, p.sd || 0);
      const x = L.get(lab) || L.set(lab, { lab, mov: 0, st: 0, n: 0, pes: 0, z2: 0 }).get(lab);
      x.mov += mov; x.st += st; x.n++;
      const peso = mov || st || .01;
      if (PESADO.test(p.n)) x.pes += peso;
      if (/DENTAL|CEPILLO|ENJUAGUE|COLGATE|BUCAL|SPF|PROTECTOR SOLAR|DERMO/.test(p.n)) x.z2 += peso;
      x.tot = (x.tot || 0) + peso;
    }
    for (const x of L.values()) {
      x.zAuto = ZONA2.test(x.lab) || x.z2 / x.tot >= .6 ? 'z2' : x.pes / x.tot >= .5 ? 'p1' : 'p2';
      x.zona = M.cfg?.zona?.[x.lab] || x.zAuto;
    }
    M.sinLab = L.get('SIN LABORATORIO') || null; L.delete('SIN LABORATORIO');
    return [...L.values()];
  }
  // reparto equitativo: el laboratorio que más se mueve va al anaquel con menos carga (los anaqueles más cercanos primero)
  // los laboratorios que el usuario fijó a un anaquel van primero; el resto se reparte sumando a esa carga
  function repartir(labs, anaqs, val, fijos = new Map()) {
    const carga = new Map(anaqs.map(a => [a.id, 0])), de = new Map(anaqs.map(a => [a.id, []]));
    for (const [id, l] of fijos) if (de.has(id)) for (const x of l) { de.get(id).push(x); carga.set(id, carga.get(id) + val(x)); }
    for (const x of [...labs].sort((a, b) => val(b) - val(a))) {
      let mejor = anaqs[0]; for (const a of anaqs) if (carga.get(a.id) < carga.get(mejor.id)) mejor = a;
      carga.set(mejor.id, carga.get(mejor.id) + val(x)); de.get(mejor.id).push(x);
    }
    return de;
  }
  const TODOS = Object.values(PISOS).flatMap(P => P.anaqueles), anaqDe = new Map(TODOS.map(a => [a.id, a]));
  const zonaAnaq = id => id.startsWith('P') ? 'p2' : id.startsWith('Z') ? 'z2' : 'p1';
  function distribucion() {
    const todos = laboratorios(), asig = new Map(), v = x => x.mov || x.st * .1, fijos = new Map();
    for (const x of todos) { const id = M.cfg?.fijo?.[x.lab]; if (id && anaqDe.has(id)) { x.fijo = id; (fijos.get(id) || fijos.set(id, []).get(id)).push(x); } }
    const labs = todos.filter(x => !x.fijo);
    const p1 = PISOS[1], c = p1.cerca, d = a => Math.hypot(a.x + a.w / 2 - c[0], a.y + a.h / 2 - c[1]);
    const a1 = [...p1.anaqueles].sort((a, b) => d(a) - d(b));
    for (const [id, l] of repartir(labs.filter(x => x.zona === 'p1'), a1, v, fijos)) asig.set(id, l);
    const a2 = PISOS[2].anaqueles;
    for (const z of ['p2', 'z2']) for (const [id, l] of repartir(labs.filter(x => x.zona === z), a2.filter(a => a.zona === z), v, fijos)) asig.set(id, l);
    for (const x of todos) if (!x.fijo) for (const [id, l] of asig) if (l.includes(x)) x.en = id;
    return { labs: todos, asig };
  }
  const calor = t => `hsl(${Math.round(120 * (1 - t))} 80% 48%)`;

  function pintar() {
    if (!S.P || S.ejemplo && !S.P.p.length) return;
    cargarCfg();
    const { labs, asig } = distribucion(), P = PISOS[M.piso];
    const val = id => (asig.get(id) || []).reduce((a, x) => a + (M.medida === 'mov' ? x.mov : x.st), 0);
    const vals = P.anaqueles.map(a => val(a.id)), max = Math.max(1e-9, ...vals);
    document.querySelectorAll('#mPiso [data-p]').forEach(b => b.setAttribute('aria-pressed', +b.dataset.p === M.piso));
    document.querySelectorAll('#mMed [data-m]').forEach(b => b.setAttribute('aria-pressed', b.dataset.m === M.medida));
    let halos = '', cajas = '', textos = '';
    P.anaqueles.forEach((a, i) => {
      const n = (asig.get(a.id) || []).length, t = vals[i] / max, col = n ? calor(t) : '#cfc9c2', cx = a.x + a.w / 2, cy = a.y + a.h / 2;
      if (n) halos += `<ellipse cx="${cx}" cy="${cy}" rx="${a.w / 2 + 10 + 22 * t}" ry="${a.h / 2 + 10 + 22 * t}" fill="${col}" opacity="${.35 + .5 * t}"/>`;
      cajas += `<rect class="anaq ${M.sel === a.id ? 'sel' : ''}" data-a="${a.id}" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${col}"><title>${esc(a.t)}: ${(asig.get(a.id) || []).map(x => x.lab).join(', ') || 'vacío'}</title></rect>`;
      const vert = a.h > a.w * 1.5, top = (asig.get(a.id) || [])[0]?.lab || '', largo = Math.max(a.w, a.h);
      textos += `<text class="nt" x="${cx}" y="${cy}" ${vert ? `transform="rotate(-90 ${cx} ${cy})"` : ''}>${esc(a.t)}${top && largo > 120 ? ' · ' + esc(top.slice(0, 24)) : ''}</text>`;
    });
    const [vx, vy, vw, vh] = P.vb.split(' ').map(Number);
    $('mPlano').innerHTML = `<svg viewBox="${P.vb}" role="img" aria-label="Mapa de calor del ${P.nombre}">
      <defs><filter id="mBlur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter></defs>
      <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#fff"/>
      <g filter="url(#mBlur)">${halos}</g>
      <image href="${P.fondo}" x="0" y="0" width="841.92" height="595.32" style="mix-blend-mode:multiply"/>
      ${cajas}${textos}</svg>`;
    $('mTitulo').textContent = `${P.nombre} · ${M.medida === 'mov' ? 'movimiento (cajas al mes)' : 'stock en droguería (cajas)'}`;
    $('mSinLab').textContent = M.sinLab ? `${nf0.format(M.sinLab.n)} productos sin laboratorio en el catálogo no se ubican en el mapa.` : '';
    // lista de anaqueles
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const filas = P.anaqueles.map((a, i) => ({ a, v: vals[i], l: asig.get(a.id) || [] })).filter(r => r.l.length || M.piso === 2).sort((x, y) => y.v - x.v);
    $('mLista').innerHTML = filas.map(({ a, v, l }) => `<li class="${M.sel === a.id ? 'sel' : ''}" data-a="${a.id}">
      <div class="mh"><i style="background:${l.length ? calor(v / max) : '#d9d4ce'}"></i><b>${esc(a.t)}</b><span>${nf0.format(v)} · ${Math.round(v / total * 100)}%</span></div>
      ${M.piso === 2 ? `<label class="resp">Responsable <input data-resp="${a.id}" value="${esc(M.cfg?.resp?.[a.id] || '')}" placeholder="Nombre"></label>` : ''}
      <div class="ml">${l.map(x => `<span draggable="true" data-lab="${esc(x.lab)}" class="${x.fijo ? 'fijo' : ''}" title="${esc(x.lab)}: ${nf0.format(x.mov)} cajas/mes · stock ${nf0.format(x.st)} · ${x.n} productos${x.fijo ? ' · puesto por ti' : ''}. Arrástralo a otro anaquel.">${x.fijo ? '📌 ' : ''}${esc(x.lab)}${x.fijo ? `<button type="button" data-soltar="${esc(x.lab)}" title="Volver a automático">×</button>` : ''}</span>`).join('') || '<em>vacío · arrastra aquí un laboratorio</em>'}</div></li>`).join('');
    // zonas por laboratorio
    const q = ($('mq').value || '').trim().toUpperCase();
    $('mZonas').innerHTML = `<thead><tr><th class="c1 solo">Laboratorio</th><th>Movimiento</th><th>Stock droguería</th><th>% pesado</th><th>Zona</th><th>Anaquel</th></tr></thead><tbody>` +
      labs.filter(x => !q || x.lab.includes(q)).sort((a, b) => b.mov - a.mov).map(x => `<tr><td class="c1 solo">${esc(x.lab)}</td><td class="n">${nf0.format(x.mov)}</td><td class="n">${nf0.format(x.st)}</td><td class="n">${Math.round(x.pes / x.tot * 100)}%</td>
        <td><select data-lab="${esc(x.lab)}">${Object.entries(ZONAS).map(([k, t]) => `<option value="${k}" ${x.zona === k ? 'selected' : ''}>${t}${k === x.zAuto ? ' (sugerida)' : ''}</option>`).join('')}</select></td>
        <td><select data-fijar="${esc(x.lab)}"><option value="">${x.fijo ? 'Automático' : `Automático (${esc(anaqDe.get(x.en)?.t || '—')})`}</option>${[1, 2].map(n => `<optgroup label="${PISOS[n].nombre}">${PISOS[n].anaqueles.map(a => `<option value="${a.id}" ${x.fijo === a.id ? 'selected' : ''}>${esc(a.t)}</option>`).join('')}</optgroup>`).join('')}</select></td></tr>`).join('') + '</tbody>';
  }
  window.pintarMapa = pintar;

  $('mPiso').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) { M.piso = +b.dataset.p; M.sel = null; pintar(); } });
  $('mMed').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (b) { M.medida = b.dataset.m; pintar(); } });
  $('mPlano').addEventListener('click', e => { const r = e.target.closest('[data-a]'); M.sel = r && M.sel !== r.dataset.a ? r.dataset.a : null; pintar(); if (M.sel) $('mLista').querySelector('.sel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
  $('mLista').addEventListener('click', e => { if (e.target.closest('input')) return; const li = e.target.closest('[data-a]'); if (li) { M.sel = M.sel === li.dataset.a ? null : li.dataset.a; pintar(); } });
  $('mLista').addEventListener('input', e => { const i = e.target.closest('[data-resp]'); if (!i || !M.cfg) return; M.cfg.resp[i.dataset.resp] = i.value; guardar(); });
  $('mZonas').addEventListener('change', e => { const s = e.target.closest('[data-lab]'); if (!s || !M.cfg) return; M.cfg.zona[s.dataset.lab] = s.value; guardar(); pintar(); });
  $('mq').addEventListener('input', () => pintar());
  function fijar(lab, id) {
    if (!M.cfg) return; M.cfg.fijo ??= {};
    if (id) { M.cfg.fijo[lab] = id; M.cfg.zona[lab] = zonaAnaq(id); } else delete M.cfg.fijo[lab];
    guardar(); pintar(); toast(id ? `${lab} → ${anaqDe.get(id).t}` : `${lab} vuelve a automático`);
  }
  $('mZonas').addEventListener('change', e => { const s = e.target.closest('[data-fijar]'); if (s) fijar(s.dataset.fijar, s.value); });
  $('mLista').addEventListener('click', e => { const b = e.target.closest('[data-soltar]'); if (b) { e.stopPropagation(); fijar(b.dataset.soltar, ''); } }, true);
  let arrastrado = null;
  document.addEventListener('dragstart', e => { const c = e.target.closest?.('#mLista [data-lab]'); if (!c) return; arrastrado = c.dataset.lab; e.dataTransfer.setData('text/plain', arrastrado); e.dataTransfer.effectAllowed = 'move'; });
  const destino = e => e.target.closest?.('#mLista li[data-a], #mPlano [data-a]');
  document.addEventListener('dragover', e => { const d = destino(e); if (d && arrastrado) { e.preventDefault(); document.querySelectorAll('.drop').forEach(x => x.classList.remove('drop')); d.classList.add('drop'); } });
  document.addEventListener('drop', e => { const d = destino(e); document.querySelectorAll('.drop').forEach(x => x.classList.remove('drop')); if (d && arrastrado) { e.preventDefault(); fijar(arrastrado, d.dataset.a); } arrastrado = null; });
  document.addEventListener('dragend', () => { arrastrado = null; document.querySelectorAll('.drop').forEach(x => x.classList.remove('drop')); });
})();
