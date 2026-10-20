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
    for (const [id, l] of fijos) if (de.has(id)) for (const x of l) { de.get(id).push(x); carga.set(id, carga.get(id) + val(x) / x.k); }
    if (!anaqs.length) return de;
    for (const x of [...labs].sort((a, b) => val(b) - val(a))) {
      let mejor = anaqs[0]; for (const a of anaqs) if (carga.get(a.id) < carga.get(mejor.id)) mejor = a;
      carga.set(mejor.id, carga.get(mejor.id) + val(x)); de.get(mejor.id).push(x);
    }
    return de;
  }
  // anaqueles de cada piso: los del croquis o los editados por el usuario (proy_config/mapa → anaq)
  const anaqs = n => (M.cfg?.anaq?.[n] || PISOS[n].anaqueles).map(a => ({ ...a, zona: a.zona || (n === 1 ? 'p1' : 'p2'), piso: n }));
  let anaqDe = new Map();
  const refrescar = () => { anaqDe = new Map([1, 2].flatMap(n => anaqs(n)).map(a => [a.id, a])); };
  refrescar();
  const lista = v => (Array.isArray(v) ? v : v ? [v] : []).filter(id => anaqDe.has(id));
  const fijosDe = lab => lista(M.cfg?.fijo?.[lab]);
  const zonaAnaq = id => anaqDe.get(id)?.zona || 'p1';
  function distribucion() {
    refrescar();
    const todos = laboratorios(), asig = new Map(), v = x => x.mov || x.st * .1, fijos = new Map();
    for (const x of todos) { x.k = 1; const ids = fijosDe(x.lab); if (ids.length) { x.fijo = ids; x.k = ids.length; for (const id of ids) (fijos.get(id) || fijos.set(id, []).get(id)).push(x); } }
    const labs = M.cfg?.manual ? [] : todos.filter(x => !x.fijo);
    const p1 = PISOS[1], c = p1.cerca, d = a => Math.hypot(a.x + a.w / 2 - c[0], a.y + a.h / 2 - c[1]);
    const a1 = anaqs(1).sort((a, b) => d(a) - d(b));
    for (const [id, l] of repartir(labs.filter(x => x.zona === 'p1'), a1, v, fijos)) asig.set(id, l);
    const a2 = anaqs(2);
    for (const z of ['p2', 'z2']) for (const [id, l] of repartir(labs.filter(x => x.zona === z), a2.filter(a => a.zona === z), v, fijos)) asig.set(id, l);
    for (const x of todos) if (!x.fijo) for (const [id, l] of asig) if (l.includes(x)) x.en = id;
    M.sinUbicar = todos.filter(x => !x.fijo && !x.en);
    return { labs: todos, asig };
  }
  // iniciales del laboratorio: su código de 4 letras del catálogo (o las 4 primeras letras del nombre)
  const COD = new Map();
  fetch('catalogo.json').then(r => r.json()).then(c => { for (const x of c) if (x.ln && x.l) COD.set(String(x.ln).trim(), String(x.l).trim()); if (S.vista === 'mapa') pintar(); }).catch(() => {});
  const inicial = lab => (COD.get(lab) || lab.replace(/^LAB(ORATORIO)?S?\.?\s+/, '').replace(/[^A-Z0-9]/g, '')).slice(0, 4);
  const calor = t => `hsl(${Math.round(120 * (1 - t))} 80% 48%)`;

  function pintar() {
    if (!S.P || S.ejemplo && !S.P.p.length) return;
    cargarCfg();
    const { labs, asig } = distribucion(), P = { ...PISOS[M.piso], anaqueles: anaqs(M.piso) }; M.asig = asig;
    const val = id => (asig.get(id) || []).reduce((a, x) => a + (M.medida === 'mov' ? x.mov : x.st) / x.k, 0);
    const vals = P.anaqueles.map(a => val(a.id)), max = Math.max(1e-9, ...vals);
    document.querySelectorAll('#mPiso [data-p]').forEach(b => b.setAttribute('aria-pressed', +b.dataset.p === M.piso));
    document.querySelectorAll('#mMed [data-m]').forEach(b => b.setAttribute('aria-pressed', b.dataset.m === M.medida));
    let halos = '', cajas = '', textos = '';
    P.anaqueles.forEach((a, i) => {
      const n = (asig.get(a.id) || []).length, t = vals[i] / max, col = n ? calor(t) : '#cfc9c2', cx = a.x + a.w / 2, cy = a.y + a.h / 2;
      if (n) halos += `<ellipse cx="${cx}" cy="${cy}" rx="${a.w / 2 + 10 + 22 * t}" ry="${a.h / 2 + 10 + 22 * t}" fill="${col}" opacity="${.35 + .5 * t}"/>`;
      cajas += `<rect class="anaq ${M.sel === a.id ? 'sel' : ''} ${M.editar ? 'ed' : ''}" data-a="${a.id}" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${col}"><title>${esc(a.t)}: ${(asig.get(a.id) || []).map(x => x.lab).join(', ') || 'vacío'}</title></rect>`;
      // nombre del anaquel y debajo las iniciales (4 letras) de sus laboratorios, en pequeño
      const vert = a.h > a.w * 1.5, largo = vert ? a.h : a.w, corto = vert ? a.w : a.h, rot = vert ? `transform="rotate(-90 ${cx} ${cy})"` : '';
      const ini = (asig.get(a.id) || []).map(x => inicial(x.lab)), porLinea = Math.max(1, Math.floor((largo - 2) / 15)), lineas = [];
      for (let k = 0; k < ini.length; k += porLinea) lineas.push(ini.slice(k, k + porLinea).join(' '));
      const caben = Math.max(1, Math.floor((corto - 8) / 4.6)), ver = lineas.slice(0, caben);
      if (lineas.length > caben) ver[caben - 1] = ver[caben - 1].replace(/\S+$/, '…');
      const y0 = cy - (ver.length ? (ver.length * 4.6) / 2 + 1 : 0);
      textos += `<text class="nt" x="${cx}" y="${y0}" ${rot}>${esc(a.t)}</text>` + ver.map((l, k) => `<text class="ni" x="${cx}" y="${y0 + 5.5 + k * 4.6}" ${rot}>${esc(l)}</text>`).join('');
    });
    const [vx, vy, vw, vh] = P.vb.split(' ').map(Number);
    $('mPlano').innerHTML = `<svg viewBox="${P.vb}" role="img" aria-label="Mapa de calor del ${P.nombre}">
      <defs><filter id="mBlur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter></defs>
      <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#fff"/>
      <g filter="url(#mBlur)">${halos}</g>
      <image href="${P.fondo}" x="0" y="0" width="841.92" height="595.32" style="mix-blend-mode:multiply"/>
      ${cajas}${textos}<rect id="mNuevo" class="nuevo" x="0" y="0" width="0" height="0"/></svg>`;
    pintarEdicion();
    $('mAuto').setAttribute('aria-pressed', !M.cfg?.manual); $('mAuto').textContent = M.cfg?.manual ? 'Reparto automático: no' : 'Reparto automático: sí';
    const su = M.sinUbicar || [], qs = ($('mqSin').value || '').trim().toUpperCase();
    $('mSinCard').hidden = !su.length; $('mSinN').textContent = nf0.format(su.length);
    $('mSin').innerHTML = su.filter(x => !qs || x.lab.includes(qs)).sort((a, b) => b.mov - a.mov).slice(0, 300).map(x => `<span draggable="true" data-lab="${esc(x.lab)}" title="${esc(x.lab)}: ${nf0.format(x.mov)} cajas/mes · stock ${nf0.format(x.st)} · ${x.n} productos. Arrástralo a un anaquel.">${esc(x.lab)} <small>${nf0.format(x.mov)}</small></span>`).join('');
    $('mTitulo').textContent = `${P.nombre} · ${M.medida === 'mov' ? 'movimiento (cajas al mes)' : 'stock en droguería (cajas)'}`;
    $('mSinLab').textContent = M.sinLab ? `${nf0.format(M.sinLab.n)} productos sin laboratorio en el catálogo no se ubican en el mapa.` : '';
    // lista de anaqueles
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const filas = P.anaqueles.map((a, i) => ({ a, v: vals[i], l: asig.get(a.id) || [] })).filter(r => r.l.length || M.piso === 2 || M.cfg?.manual).sort((x, y) => y.v - x.v);
    $('mLista').innerHTML = filas.map(({ a, v, l }) => `<li class="${M.sel === a.id ? 'sel' : ''}" data-a="${a.id}">
      <div class="mh"><i style="background:${l.length ? calor(v / max) : '#d9d4ce'}"></i><b>${esc(a.t)}</b><span>${nf0.format(v)} · ${Math.round(v / total * 100)}%</span></div>
      ${M.piso === 2 ? `<label class="resp">Responsable <input data-resp="${a.id}" value="${esc(M.cfg?.resp?.[a.id] || '')}" placeholder="Nombre"></label>` : ''}
      <div class="ml">${l.map(x => `<span draggable="true" data-lab="${esc(x.lab)}" class="${x.fijo ? 'fijo' : ''}" title="${esc(x.lab)}: ${nf0.format(x.mov)} cajas/mes · stock ${nf0.format(x.st)} · ${x.n} productos${x.fijo ? ' · puesto por ti' : ''}. Arrástralo a otro anaquel (con Ctrl presionado lo agregas sin quitarlo de aquí).">${x.fijo ? '📌 ' : ''}${esc(x.lab)}${x.k > 1 ? ` <small>1/${x.k}</small>` : ''}${x.fijo ? `<button type="button" data-soltar="${esc(x.lab)}" data-de="${a.id}" title="Quitar de este anaquel">×</button>` : ''}</span>`).join('') || '<em>vacío · arrastra aquí un laboratorio</em>'}</div></li>`).join('');
    // zonas por laboratorio
    const q = ($('mq').value || '').trim().toUpperCase();
    $('mZonas').innerHTML = `<thead><tr><th class="c1 solo">Laboratorio</th><th>Movimiento</th><th>Stock droguería</th><th>% pesado</th><th>Zona</th><th>Anaquel</th></tr></thead><tbody>` +
      labs.filter(x => !q || x.lab.includes(q)).sort((a, b) => b.mov - a.mov).map(x => `<tr><td class="c1 solo">${esc(x.lab)}</td><td class="n">${nf0.format(x.mov)}</td><td class="n">${nf0.format(x.st)}</td><td class="n">${Math.round(x.pes / x.tot * 100)}%</td>
        <td><select data-lab="${esc(x.lab)}">${Object.entries(ZONAS).map(([k, t]) => `<option value="${k}" ${x.zona === k ? 'selected' : ''}>${t}${k === x.zAuto ? ' (sugerida)' : ''}</option>`).join('')}</select></td>
        <td class="fijos">${x.fijo ? x.fijo.map(id => `<span class="chip">${esc(anaqDe.get(id).t)}<button type="button" data-quitar="${esc(x.lab)}" data-de="${id}" title="Quitar">×</button></span>`).join('') : `<span class="z">Automático (${esc(anaqDe.get(x.en)?.t || '—')})</span>`}
          <select data-fijar="${esc(x.lab)}" aria-label="Añadir anaquel"><option value="">＋ Añadir anaquel…</option>${[1, 2].map(n => `<optgroup label="${PISOS[n].nombre}">${anaqs(n).filter(a => !x.fijo?.includes(a.id)).map(a => `<option value="${a.id}">${esc(a.t)}</option>`).join('')}</optgroup>`).join('')}</select></td></tr>`).join('') + '</tbody>';
  }
  window.pintarMapa = pintar;

  /* ---------- edición de anaqueles: dibujar, mover, dividir, renombrar, cambiar de zona, quitar ---------- */
  const propios = n => { M.cfg.anaq ??= {}; return (M.cfg.anaq[n] ??= anaqs(n).map(({ piso, ...a }) => a)); };
  const nuevoId = () => 'N' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  function pintarEdicion() {
    const b = $('mEditar'); b.setAttribute('aria-pressed', !!M.editar); b.textContent = M.editar ? '✓ Terminar edición' : '✎ Editar anaqueles';
    const box = $('mEdit'); box.hidden = !M.editar; if (!M.editar) return;
    const a = M.sel && anaqDe.get(M.sel)?.piso === M.piso ? anaqDe.get(M.sel) : null;
    box.innerHTML = `<button type="button" class="btn sm ${M.dibujar ? 'on' : ''}" data-ed="dibujar">＋ ${M.dibujar ? 'Dibuja el anaquel en el plano…' : 'Añadir anaquel'}</button>
      ${a ? `<span class="sep"></span><label>Nombre <input data-ed="nombre" value="${esc(a.t)}" maxlength="30"></label>
        ${M.piso === 2 ? `<label>Zona <select data-ed="zona"><option value="p2" ${a.zona === 'p2' ? 'selected' : ''}>Anaqueles 1</option><option value="z2" ${a.zona === 'z2' ? 'selected' : ''}>Zona 2 (Colgate, dermo, dental)</option></select></label>` : ''}
        <button type="button" class="btn sm" data-ed="dividir">Dividir en 2</button><button type="button" class="btn sm rojo" data-ed="quitar">Quitar</button>`
        : '<span class="z">Clic en un anaquel para cambiarlo; arrástralo para moverlo.</span>'}
      <button type="button" class="btn sm" data-ed="restablecer" style="margin-left:auto">Volver al croquis original</button>`;
  }
  function editar(fn, msg) { if (!M.cfg) return; const l = propios(M.piso); fn(l); guardar(); pintar(); if (msg) toast(msg); }
  $('mEditar').addEventListener('click', () => { M.editar = !M.editar; M.dibujar = false; pintar(); });
  $('mEdit').addEventListener('click', e => {
    const b = e.target.closest('[data-ed]'); if (!b || b.tagName !== 'BUTTON') return;
    const ed = b.dataset.ed, id = M.sel;
    if (ed === 'dibujar') { M.dibujar = !M.dibujar; return pintarEdicion(); }
    if (ed === 'restablecer') { if (!confirm(`¿Volver los anaqueles del ${PISOS[M.piso].nombre.toLowerCase()} al croquis original?`)) return; delete M.cfg.anaq?.[M.piso]; M.sel = null; guardar(); pintar(); return toast('Anaqueles como en el croquis'); }
    if (ed === 'dividir') editar(l => {
      const i = l.findIndex(a => a.id === id); if (i < 0) return; const a = l[i], h = a.w >= a.h, n1 = nuevoId(), n2 = nuevoId() + 'b';
      const p1 = h ? { x: a.x, y: a.y, w: a.w / 2, h: a.h } : { x: a.x, y: a.y, w: a.w, h: a.h / 2 };
      const p2 = h ? { x: a.x + a.w / 2, y: a.y, w: a.w / 2, h: a.h } : { x: a.x, y: a.y + a.h / 2, w: a.w, h: a.h / 2 };
      l.splice(i, 1, { ...a, ...p1, id: n1, t: a.t + ' A' }, { ...a, ...p2, id: n2, t: a.t + ' B' });
      for (const [lab, v] of Object.entries(M.cfg.fijo)) { const ids = lista(v).map(x => x === id ? n1 : x); if (ids.length) M.cfg.fijo[lab] = ids.length === 1 ? ids[0] : ids; }
      if (M.cfg.resp[id]) M.cfg.resp[n1] = M.cfg.resp[id];
      M.sel = n1;
    }, 'Anaquel dividido en 2');
    if (ed === 'quitar') { const a = anaqDe.get(id); if (!a || !confirm(`¿Quitar "${a.t}"? Sus laboratorios se repartirán en los demás.`)) return; editar(l => { l.splice(l.findIndex(x => x.id === id), 1); M.sel = null; }, `"${a.t}" quitado`); }
  });
  $('mEdit').addEventListener('change', e => {
    const c = e.target.closest('[data-ed]'); if (!c || !M.sel) return;
    editar(l => { const a = l.find(x => x.id === M.sel); if (!a) return; if (c.dataset.ed === 'nombre') a.t = c.value.trim() || a.t; if (c.dataset.ed === 'zona') a.zona = c.value; });
  });
  // coordenadas del plano (puntos del PDF) a partir del puntero
  const enPlano = e => { const svg = $('mPlano').querySelector('svg'), p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
  let ed = null;
  $('mPlano').addEventListener('pointerdown', e => {
    if (!M.editar || e.button) return;
    e.stopImmediatePropagation(); const p = enPlano(e), r = e.target.closest('[data-a]');
    if (M.dibujar) ed = { tipo: 'dibujar', x0: p.x, y0: p.y };
    else if (r) { const a = anaqDe.get(r.dataset.a); ed = { tipo: 'mover', id: a.id, dx: p.x - a.x, dy: p.y - a.y, el: r, mov: false }; M.sel = a.id; }
    else return;
    $('mPlano').setPointerCapture(e.pointerId);
  }, true);
  $('mPlano').addEventListener('pointermove', e => {
    if (!ed) return; e.stopImmediatePropagation(); const p = enPlano(e);
    if (ed.tipo === 'dibujar') { const n = $('mNuevo'); n.setAttribute('x', Math.min(p.x, ed.x0)); n.setAttribute('y', Math.min(p.y, ed.y0)); n.setAttribute('width', Math.abs(p.x - ed.x0)); n.setAttribute('height', Math.abs(p.y - ed.y0)); }
    else { ed.mov = true; ed.x = p.x - ed.dx; ed.y = p.y - ed.dy; ed.el.setAttribute('x', ed.x); ed.el.setAttribute('y', ed.y); }
  }, true);
  $('mPlano').addEventListener('pointerup', e => {
    if (!ed) return; e.stopImmediatePropagation(); const d = ed; ed = null; const p = enPlano(e);
    if (d.tipo === 'dibujar') {
      const x = Math.min(p.x, d.x0), y = Math.min(p.y, d.y0), w = Math.abs(p.x - d.x0), h = Math.abs(p.y - d.y0);
      if (w < 4 || h < 4) return pintar();
      const n = anaqs(M.piso).length + 1, id = nuevoId();
      editar(l => l.push({ id, x, y, w, h, t: M.piso === 2 ? 'Anaquel ' + n : 'Nuevo ' + n, zona: M.piso === 2 ? 'p2' : 'p1' }), 'Anaquel añadido: ponle nombre arriba');
      M.dibujar = false; M.sel = id; pintar();
    } else if (d.mov) editar(l => { const a = l.find(x => x.id === d.id); if (a) { a.x = d.x; a.y = d.y; } });
    else pintar();
  }, true);
  $('mPlano').addEventListener('click', e => { if (M.editar) e.stopImmediatePropagation(); }, true);

  $('mPiso').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) { M.piso = +b.dataset.p; M.sel = null; pintar(); } });
  $('mMed').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (b) { M.medida = b.dataset.m; pintar(); } });
  // arrastrar un cuadrado del plano sobre otro: sus laboratorios pasan a ese anaquel (si tenía, se intercambian)
  let arr = null, sinClic = false;
  const fantasma = document.createElement('div'); fantasma.className = 'mfantasma'; fantasma.hidden = true; document.body.append(fantasma);
  const bajo = e => document.elementFromPoint(e.clientX, e.clientY)?.closest?.('#mPlano [data-a]');
  $('mPlano').addEventListener('pointerdown', e => {
    const r = e.target.closest('[data-a]'); if (!r || e.button) return;
    arr = { id: r.dataset.a, x: e.clientX, y: e.clientY, mov: false }; $('mPlano').setPointerCapture(e.pointerId);
  });
  $('mPlano').addEventListener('pointermove', e => {
    if (!arr) return;
    if (!arr.mov && Math.hypot(e.clientX - arr.x, e.clientY - arr.y) < 6) return;
    arr.mov = true; e.preventDefault();
    const n = (M.asig?.get(arr.id) || []).length, d = bajo(e);
    document.querySelectorAll('#mPlano .mdrop').forEach(x => x.classList.remove('mdrop')); if (d && d.dataset.a !== arr.id) d.classList.add('mdrop');
    fantasma.hidden = false; fantasma.style.left = e.clientX + 14 + 'px'; fantasma.style.top = e.clientY + 14 + 'px';
    fantasma.textContent = `${anaqDe.get(arr.id).t} (${n} lab.)${d && d.dataset.a !== arr.id ? ' → ' + anaqDe.get(d.dataset.a).t : ''}`;
  });
  const terminar = e => {
    if (!arr) return;
    const a = arr; arr = null; fantasma.hidden = true; document.querySelectorAll('#mPlano .mdrop').forEach(x => x.classList.remove('mdrop'));
    if (!a.mov) return;
    sinClic = true; const d = e && bajo(e); if (!d || d.dataset.a === a.id || !M.cfg) return;
    const de = M.asig?.get(a.id) || [], al = M.asig?.get(d.dataset.a) || [];
    if (!de.length) return toast('Ese anaquel está vacío');
    const cambiar = (x, de1, a1) => { const ids = fijosDe(x.lab); const n = ids.length ? ids.map(i => i === de1 ? a1 : i).filter((i, k, arr) => arr.indexOf(i) === k) : [a1]; M.cfg.fijo[x.lab] = n.length === 1 ? n[0] : n; M.cfg.zona[x.lab] = zonaAnaq(n[0]); };
    for (const x of de) cambiar(x, a.id, d.dataset.a);
    for (const x of al) if (!de.includes(x)) cambiar(x, d.dataset.a, a.id);
    guardar(); M.sel = d.dataset.a; pintar();
    toast(`${anaqDe.get(a.id).t} → ${anaqDe.get(d.dataset.a).t}: ${de.length} laboratorio(s)${al.length ? `; los ${al.length} de ${anaqDe.get(d.dataset.a).t} pasaron a ${anaqDe.get(a.id).t}` : ''}`);
  };
  $('mPlano').addEventListener('pointerup', terminar);
  $('mPlano').addEventListener('pointercancel', () => terminar(null));
  $('mPlano').addEventListener('click', e => { if (sinClic) { sinClic = false; return; } const r = e.target.closest('[data-a]'); M.sel = r && M.sel !== r.dataset.a ? r.dataset.a : null; pintar(); if (M.sel) $('mLista').querySelector('.sel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
  $('mLista').addEventListener('click', e => { if (e.target.closest('input')) return; const li = e.target.closest('[data-a]'); if (li) { M.sel = M.sel === li.dataset.a ? null : li.dataset.a; pintar(); } });
  $('mLista').addEventListener('input', e => { const i = e.target.closest('[data-resp]'); if (!i || !M.cfg) return; M.cfg.resp[i.dataset.resp] = i.value; guardar(); });
  $('mZonas').addEventListener('change', e => { const s = e.target.closest('[data-lab]'); if (!s || !M.cfg) return; M.cfg.zona[s.dataset.lab] = s.value; guardar(); pintar(); });
  $('mq').addEventListener('input', () => pintar());
  $('mqSin').addEventListener('input', () => pintar());
  $('mLimpiar').addEventListener('click', () => {
    if (!M.cfg || !confirm('¿Vaciar todos los anaqueles de los dos pisos? Quedarán todos los laboratorios "sin ubicar" para que los coloques tú, y el reparto automático se apaga.')) return;
    M.cfg.fijo = {}; M.cfg.manual = true; M.sel = null; guardar(); pintar(); toast('Anaqueles vacíos: arrastra los laboratorios desde "Sin ubicar"');
  });
  $('mAuto').addEventListener('click', () => { if (!M.cfg) return; M.cfg.manual = !M.cfg.manual; guardar(); pintar(); toast(M.cfg.manual ? 'Solo se muestran los laboratorios que colocaste' : 'Los laboratorios sin colocar se reparten solos'); });
  // modo: 'mover' (de un anaquel a otro), 'agregar' (un anaquel más) o 'quitar' (de un anaquel)
  function fijar(lab, id, modo = 'mover', de = null) {
    if (!M.cfg) return; M.cfg.fijo ??= {};
    let ids = fijosDe(lab);
    if (modo === 'quitar') ids = ids.filter(x => x !== de);
    else if (modo === 'agregar') { if (!ids.length && de) ids = [de]; if (!ids.includes(id)) ids.push(id); }
    else ids = ids.includes(de) ? ids.map(x => x === de ? id : x).filter((x, i, a) => a.indexOf(x) === i) : [id];
    if (ids.length) { M.cfg.fijo[lab] = ids.length === 1 ? ids[0] : ids; M.cfg.zona[lab] = zonaAnaq(ids[0]); } else delete M.cfg.fijo[lab];
    guardar(); pintar();
    toast(modo === 'quitar' ? (ids.length ? `${lab} sale de ${anaqDe.get(de).t}` : `${lab} ${M.cfg.manual ? "queda sin ubicar" : "vuelve a automático"}`) : `${lab} → ${ids.map(x => anaqDe.get(x).t).join(', ')}`);
  }
  $('mZonas').addEventListener('change', e => { const s = e.target.closest('[data-fijar]'); if (s && s.value) fijar(s.dataset.fijar, s.value, 'agregar'); });
  $('mZonas').addEventListener('click', e => { const b = e.target.closest('[data-quitar]'); if (b) fijar(b.dataset.quitar, null, 'quitar', b.dataset.de); });
  $('mLista').addEventListener('click', e => { const b = e.target.closest('[data-soltar]'); if (b) { e.stopPropagation(); fijar(b.dataset.soltar, null, 'quitar', b.dataset.de); } }, true);
  let arrastrado = null;
  document.addEventListener('dragstart', e => { const c = e.target.closest?.('#mLista [data-lab], #mSin [data-lab]'); if (!c) return; arrastrado = { lab: c.dataset.lab, de: c.closest('li[data-a]')?.dataset.a }; e.dataTransfer.setData('text/plain', arrastrado.lab); e.dataTransfer.effectAllowed = 'copyMove'; });
  const destino = e => e.target.closest?.('#mLista li[data-a], #mPlano [data-a], #mSinCard');
  document.addEventListener('dragover', e => { const d = destino(e); if (d && arrastrado) { e.preventDefault(); document.querySelectorAll('.mdrop').forEach(x => x.classList.remove('mdrop')); d.classList.add('mdrop'); } });
  document.addEventListener('drop', e => { const d = destino(e); document.querySelectorAll('.mdrop').forEach(x => x.classList.remove('mdrop')); if (d && arrastrado && d.id === 'mSinCard') { e.preventDefault(); if (arrastrado.de) fijar(arrastrado.lab, null, 'quitar', arrastrado.de); }
    else if (d && arrastrado && d.dataset.a !== arrastrado.de) { e.preventDefault(); fijar(arrastrado.lab, d.dataset.a, e.ctrlKey || e.metaKey || e.altKey ? 'agregar' : 'mover', arrastrado.de); } arrastrado = null; });
  document.addEventListener('dragend', () => { arrastrado = null; document.querySelectorAll('.mdrop').forEach(x => x.classList.remove('mdrop')); });
})();
