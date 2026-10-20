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

  // Planos (coordenadas de la foto del croquis; se giran para verlos horizontales)
  const R = (id, x, y, w, h, extra = {}) => ({ id, x, y, w, h, ...extra });
  const racks = [];
  for (let k = 1; k <= 8; k++) {
    const y = 765 - k * 63.75;
    racks.push(R('R' + k, 460, y, 53, 63.75, { t: String(k) }), R('R' + (k + 8), 513, y, 57, 63.75, { t: String(k + 8) }));
  }
  const PISOS = {
    1: {
      nombre: 'Primer piso', W: 1206, H: 1600, gira: 'cw', vb: '120 60 1440 1000',
      muro: [[110, 130], [995, 70], [1000, 1070], [770, 1080], [775, 1410], [215, 1462], [180, 620]],
      areas: [
        R('dev', 190, 865, 195, 155, { t: 'Devoluciones' }), R('ctrl', 205, 1100, 85, 340, { t: 'Controlados' }),
        R('baja', 300, 1085, 165, 355, { t: 'Baja / rechazados' }), R('cuar', 470, 1010, 105, 405, { t: 'Cuarentena' }),
        R('rec', 577, 1010, 103, 405, { t: 'Recepción' }), R('desp', 730, 620, 255, 100, { t: 'Despacho' }),
        R('emb', 630, 343, 30, 472, { t: 'Embalaje' }), R('lav', 735, 722, 250, 125, { t: 'Lavadero / SSHH' }),
        R('vest', 800, 970, 170, 105, { t: 'Vestidores' }), R('esc1', 430, 90, 345, 105, { t: 'Escalera' }),
        R('esc2', 680, 1090, 95, 320, { t: 'Escalera' })
      ],
      anaqueles: [
        R('A1', 222, 245, 73, 525, { t: 'A1' }), R('A2', 330, 240, 50, 520, { t: 'A2' }), R('A3', 140, 135, 305, 35, { t: 'A3' }),
        R('A4', 120, 180, 50, 150, { t: 'A4' }), R('A5', 185, 830, 305, 30, { t: 'A5' }),
        ...racks,
        R('R17', 625, 190, 60, 75, { t: '17' }), R('R18', 688, 190, 57, 75, { t: '18' }),
        R('R19', 815, 230, 58, 65, { t: '19' }), R('R20', 875, 230, 57, 65, { t: '20' }), R('R21', 935, 230, 60, 65, { t: '21' }),
        R('R22', 935, 160, 60, 70, { t: '22' }), R('R23', 875, 160, 57, 70, { t: '23' }),
        R('E1', 782, 95, 210, 28, { t: 'E1' }), R('E2', 770, 343, 205, 25, { t: 'E2' }),
        R('M1', 728, 370, 62, 65, { t: 'M1' }), R('M2', 935, 375, 32, 65, { t: 'M2' }), R('M3', 733, 525, 57, 60, { t: 'M3' })
      ],
      cerca: [860, 670] // despacho: lo que más se mueve va más cerca
    },
    2: {
      nombre: 'Segundo piso', W: 1199, H: 1600, gira: 'ccw', vb: '110 150 1460 960',
      muro: [[120, 190], [1020, 150], [975, 925], [440, 940], [430, 1525], [140, 1535], [190, 1275]],
      areas: [R('mesa', 480, 170, 275, 100, { t: 'Mesa' })],
      anaqueles: [
        ...[345, 458, 572, 684, 790].map((y, i) => R('P' + (i + 1), 295, y, 660, 62, { t: 'Anaquel ' + (i + 1), zona: 'p2' })),
        R('P6', 440, 880, 490, 35, { t: 'Anaquel 6', zona: 'p2' }),
        R('Z1', 395, 925, 35, 590, { t: 'Zona 2 · A', zona: 'z2' }), R('Z2', 260, 975, 75, 445, { t: 'Zona 2 · B', zona: 'z2' }),
        R('Z3', 150, 1480, 230, 40, { t: 'Zona 2 · C', zona: 'z2' })
      ]
    }
  };
  // giro de la foto: cw (horario) o ccw (antihorario)
  const gp = (P, x, y) => P.gira === 'cw' ? [P.H - y, x] : [y, P.W - x];
  const gr = (P, r) => P.gira === 'cw' ? { x: P.H - r.y - r.h, y: r.x, w: r.h, h: r.w } : { x: r.y, y: P.W - r.x - r.w, w: r.h, h: r.w };

  const PESADO = /LECHE|FORMULA|\bNAN\b|ENFA|SIMILAC|NUTRILON|PEDIASURE|ENSURE|GLUCERNA|JARABE|\bJBE\b|SUSP|CLORURO|SUERO|DEXTROSA|SOLUCION|\bSOL\b|\bFCO\b|FRASCO|GALON|\b1\s?L\b|1000\s?ML|500\s?ML|AGUA|ALCOHOL|ELECTROLIT/;
  const ZONA2 = /COLGATE|ORAL B|DENTAID|DENTWORLD|DENTAL|EUCERIN|BIODERMA|ISDIN|LAROCHE|LA ROCHE|ISISPHARMA|AVENE|GALDERMA|CERAVE|VICHY|SESDERMA|URIAGE|DERMATOLOG/;
  const ZONAS = { p1: 'Piso 1 · pesados', p2: 'Piso 2 · anaqueles 1', z2: 'Piso 2 · zona 2 (Colgate, dermo, dental)' };

  const M = { piso: 2, medida: 'mov', sel: null, cfg: null, cargando: false };

  async function cargarCfg() {
    if (M.cfg || M.cargando) return; M.cargando = true;
    try { const d = await S.db?.doc('config/mapa').get(); M.cfg = d?.exists ? d.data() : {}; } catch { M.cfg = {}; }
    M.cfg.zona ??= {}; M.cfg.resp ??= {}; M.cargando = false; pintar();
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
  function repartir(labs, anaqs, val) {
    const carga = new Map(anaqs.map(a => [a.id, 0])), de = new Map(anaqs.map(a => [a.id, []]));
    for (const x of [...labs].sort((a, b) => val(b) - val(a))) {
      let mejor = anaqs[0]; for (const a of anaqs) if (carga.get(a.id) < carga.get(mejor.id)) mejor = a;
      carga.set(mejor.id, carga.get(mejor.id) + val(x)); de.get(mejor.id).push(x);
    }
    return de;
  }
  function distribucion() {
    const labs = laboratorios(), asig = new Map(), v = x => x.mov || x.st * .1;
    const p1 = PISOS[1], c = p1.cerca, d = a => Math.hypot(a.x + a.w / 2 - c[0], a.y + a.h / 2 - c[1]);
    const a1 = [...p1.anaqueles].sort((a, b) => d(a) - d(b));
    for (const [id, l] of repartir(labs.filter(x => x.zona === 'p1'), a1, v)) asig.set(id, l);
    const a2 = PISOS[2].anaqueles;
    for (const z of ['p2', 'z2']) for (const [id, l] of repartir(labs.filter(x => x.zona === z), a2.filter(a => a.zona === z), v)) asig.set(id, l);
    return { labs, asig };
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
    const poly = P.muro.map(([x, y]) => gp(P, x, y).join(',')).join(' ');
    let halos = '', cajas = '', textos = '';
    for (const r of P.areas) { const g = gr(P, r); cajas += `<rect class="area" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="4"/>`; const vert = g.h > g.w * 1.3, lado = vert ? g.h : g.w, fs = Math.min(22, Math.max(12, lado / (r.t.length * .62)));
      textos += `<text class="at" x="${g.x + g.w / 2}" y="${g.y + g.h / 2}" style="font-size:${fs}px" ${vert ? `transform="rotate(-90 ${g.x + g.w / 2} ${g.y + g.h / 2})"` : ''}>${esc(r.t)}</text>`; }
    P.anaqueles.forEach((a, i) => {
      const g = gr(P, a), t = vals[i] / max, col = (asig.get(a.id) || []).length ? calor(t) : '#d9d4ce';
      const rad = Math.max(g.w, g.h) * .55 + 40 * t;
      if ((asig.get(a.id) || []).length) halos += `<ellipse cx="${g.x + g.w / 2}" cy="${g.y + g.h / 2}" rx="${g.w / 2 + rad * .5}" ry="${g.h / 2 + rad * .5}" fill="${col}" opacity="${.25 + .5 * t}"/>`;
      cajas += `<rect class="anaq ${M.sel === a.id ? 'sel' : ''}" data-a="${a.id}" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="3" fill="${col}"><title>${esc(a.t)}: ${(asig.get(a.id) || []).map(x => x.lab).join(', ') || 'vacío'}</title></rect>`;
      const top = (asig.get(a.id) || [])[0]?.lab || '';
      textos += `<text class="nt" x="${g.x + g.w / 2}" y="${g.y + g.h / 2}" ${g.h > g.w * 1.5 ? `transform="rotate(-90 ${g.x + g.w / 2} ${g.y + g.h / 2})"` : ''}>${esc(a.t)}${top && Math.max(g.w, g.h) > 150 ? ' · ' + esc(top.slice(0, 22)) : ''}</text>`;
    });
    $('mPlano').innerHTML = `<svg viewBox="${P.vb}" role="img" aria-label="Mapa de calor del ${P.nombre}">
      <defs><filter id="mBlur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="28"/></filter></defs>
      <polygon class="muro" points="${poly}"/><g filter="url(#mBlur)">${halos}</g><polygon class="muro2" points="${poly}"/>${cajas}${textos}</svg>`;
    $('mTitulo').textContent = `${P.nombre} · ${M.medida === 'mov' ? 'movimiento (cajas al mes)' : 'stock en droguería (cajas)'}`;
    $('mSinLab').textContent = M.sinLab ? `${nf0.format(M.sinLab.n)} productos sin laboratorio en el catálogo no se ubican en el mapa.` : '';
    // lista de anaqueles
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const filas = P.anaqueles.map((a, i) => ({ a, v: vals[i], l: asig.get(a.id) || [] })).filter(r => r.l.length || M.piso === 2).sort((x, y) => y.v - x.v);
    $('mLista').innerHTML = filas.map(({ a, v, l }) => `<li class="${M.sel === a.id ? 'sel' : ''}" data-a="${a.id}">
      <div class="mh"><i style="background:${l.length ? calor(v / max) : '#d9d4ce'}"></i><b>${esc(a.t)}</b><span>${nf0.format(v)} · ${Math.round(v / total * 100)}%</span></div>
      ${M.piso === 2 ? `<label class="resp">Responsable <input data-resp="${a.id}" value="${esc(M.cfg?.resp?.[a.id] || '')}" placeholder="Nombre"></label>` : ''}
      <div class="ml">${l.map(x => `<span title="${esc(x.lab)}: ${nf0.format(x.mov)} cajas/mes · stock ${nf0.format(x.st)} · ${x.n} productos">${esc(x.lab)}</span>`).join('') || '<em>vacío</em>'}</div></li>`).join('');
    // zonas por laboratorio
    const q = ($('mq').value || '').trim().toUpperCase();
    $('mZonas').innerHTML = `<thead><tr><th class="c1 solo">Laboratorio</th><th>Movimiento</th><th>Stock droguería</th><th>% pesado</th><th>Zona</th></tr></thead><tbody>` +
      labs.filter(x => !q || x.lab.includes(q)).sort((a, b) => b.mov - a.mov).map(x => `<tr><td class="c1 solo">${esc(x.lab)}</td><td class="n">${nf0.format(x.mov)}</td><td class="n">${nf0.format(x.st)}</td><td class="n">${Math.round(x.pes / x.tot * 100)}%</td>
        <td><select data-lab="${esc(x.lab)}">${Object.entries(ZONAS).map(([k, t]) => `<option value="${k}" ${x.zona === k ? 'selected' : ''}>${t}${k === x.zAuto ? ' (sugerida)' : ''}</option>`).join('')}</select></td></tr>`).join('') + '</tbody>';
  }
  window.pintarMapa = pintar;

  $('mPiso').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) { M.piso = +b.dataset.p; M.sel = null; pintar(); } });
  $('mMed').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (b) { M.medida = b.dataset.m; pintar(); } });
  $('mPlano').addEventListener('click', e => { const r = e.target.closest('[data-a]'); M.sel = r && M.sel !== r.dataset.a ? r.dataset.a : null; pintar(); if (M.sel) $('mLista').querySelector('.sel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
  $('mLista').addEventListener('click', e => { if (e.target.closest('input')) return; const li = e.target.closest('[data-a]'); if (li) { M.sel = M.sel === li.dataset.a ? null : li.dataset.a; pintar(); } });
  $('mLista').addEventListener('input', e => { const i = e.target.closest('[data-resp]'); if (!i || !M.cfg) return; M.cfg.resp[i.dataset.resp] = i.value; guardar(); });
  $('mZonas').addEventListener('change', e => { const s = e.target.closest('[data-lab]'); if (!s || !M.cfg) return; M.cfg.zona[s.dataset.lab] = s.value; guardar(); pintar(); });
  $('mq').addEventListener('input', () => pintar());
})();
