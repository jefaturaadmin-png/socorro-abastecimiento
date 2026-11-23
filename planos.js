/* Planos por laboratorio (dentro de Mapa de calor): el plano de cada piso con el laboratorio de cada anaquel, parihuela y rack.
   Se pueden editar: cambiar los nombres, mover y agrandar los cuadros, agregar cuadros nuevos o quitarlos.
   Se guardan en proy_config/planos_lab = { p1: JSON, p2: JSON, actualizado, porNombre } y se ven en vivo.
   Si todavía no hay nada guardado, se parte de planos/plano_lab_piso1.json y planos/plano_lab_piso2.json.
   Cada plano: { titulo, vb: [x, y, ancho, alto], deco: dibujo fijo (paredes, escalera, medidas), cajas: [{ x, y, w, h, c: código, l: [laboratorios], t: tipo }] } */
(() => {
  const $ = id => document.getElementById(id);
  const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const PL = { piso: 1, datos: { 1: null, 2: null }, sel: null, editar: false, cargado: false, guardando: null };
  const TIPOS = { an: ['Anaquel', '#ffffff'], pal: ['Parihuela / pallet', '#fbf3e6'], rack: ['Rack', '#fff6c7'], oft: ['Oftalmológicos', '#eef3fb'], esp: ['Especial', '#eef3fb'], gris: ['Otro', '#f2f2f2'], vac: ['Vacío', '#f1f1f1'], esc: ['Escalera', '#ffffff'], zona: ['Zona de auxiliar', 'none'] };
  const AUXC = ['#6b7280', '#16a34a', '#2563eb', '#ea580c', '#9333ea', '#0891b2'];   // color de cada auxiliar (1, 2, 3…)
  const auxCol = n => AUXC[n] || AUXC[0];
  const DEFS = '<defs><marker id="plfl" markerWidth="12" markerHeight="12" refX="8" refY="6" orient="auto"><path d="M0,0 L12,6 L0,12 z" fill="#111"/></marker></defs>';

  // texto de cada cuadro: los nombres largos van en dos líneas y la letra se achica si hay muchos
  function lineas(b) {
    const lim = b.w < 95 ? 11 : 15, ls = b.l || [];
    const partir = t => { if (t.length <= lim || !t.includes(' ')) return [t]; const p = t.split(' '); let best = null;
      for (let k = 1; k < p.length; k++) { const a = p.slice(0, k).join(' '), c = p.slice(k).join(' '), m = Math.max(a.length, c.length); if (!best || m < best[0]) best = [m, [a, c]]; }
      return best[1]; };
    return ls.length <= 2 ? ls.flatMap(partir) : ls;
  }
  // zona de un auxiliar: un recuadro punteado de color con su nombre arriba; los cuadros que caen dentro son de ese auxiliar
  function zonaSvg(b, i) {
    const c = auxCol(+b.a || 0), sel = PL.sel === i, t = b.c || ('AUXILIAR ' + (b.a || '')), w = t.length * 9.5 + 28, cx = b.x + b.w / 2;
    return `<g class="pl-c${PL.editar ? ' ed' : ''}" data-i="${i}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="18" fill="${c}" fill-opacity=".05" stroke="${c}" stroke-width="${sel ? 5 : 3.5}" stroke-dasharray="14 8"/>`
      + `<rect x="${cx - w / 2}" y="${b.y - 13}" width="${w}" height="26" rx="13" fill="${c}"/><text x="${cx}" y="${b.y + 5}" font-size="14" font-weight="800" text-anchor="middle" fill="#fff" letter-spacing="1">${esc(t)}</text>`
      + (sel && PL.editar ? `<rect class="pl-tam" data-tam="${i}" x="${b.x + b.w - 12}" y="${b.y + b.h - 12}" width="16" height="16" fill="${c}"/>` : '') + '</g>';
  }
  // auxiliar de cada cuadro: el que se le puso a mano, o el de la zona donde está su centro
  function auxDe(b, d) {
    if (b.t === 'zona') return +b.a || 0;
    if (+b.a) return +b.a;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const z = d.cajas.find(z => z.t === 'zona' && cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h);
    return z ? +z.a || 0 : 0;
  }
  function cajaSvg(b, i) {
    if (b.t === 'zona') return zonaSvg(b, i);
    return cajaSvg0(b, i) + (+b.a ? `<g pointer-events="none"><circle cx="${b.x + b.w}" cy="${b.y}" r="11" fill="${auxCol(+b.a)}"/><text x="${b.x + b.w}" y="${b.y + 4.5}" font-size="12" font-weight="800" text-anchor="middle" fill="#fff">${+b.a}</text></g>` : '');
  }
  function cajaSvg0(b, i) {
    if (b.t === 'esc') {   // escalera: peldaños a lo largo del lado largo y el nombre girado si es alta
      const alta = b.h >= b.w, n = Math.max(1, Math.floor((alta ? b.h : b.w) / 24)), cx = b.x + b.w / 2, cy = b.y + b.h / 2, sel = PL.sel === i;
      let r = `<g class="pl-c${PL.editar ? ' ed' : ''}" data-i="${i}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#fff" stroke="${sel ? '#1d4ed8' : '#111'}" stroke-width="${sel ? 3 : 2.2}"/>`;
      for (let k = 1; k < n; k++) { const d = k * (alta ? b.h : b.w) / n; r += alta ? `<line x1="${b.x}" y1="${b.y + d}" x2="${b.x + b.w}" y2="${b.y + d}" stroke="#111" stroke-width="1.4"/>` : `<line x1="${b.x + d}" y1="${b.y}" x2="${b.x + d}" y2="${b.y + b.h}" stroke="#111" stroke-width="1.4"/>`; }
      const t = (b.l || []).join(' ') || 'ESCALERA';
      r += `<rect x="${alta ? cx - 9 : cx - t.length * 4.5}" y="${alta ? cy - t.length * 4.5 : cy - 9}" width="${alta ? 18 : t.length * 9}" height="${alta ? t.length * 9 : 18}" fill="#fff"/><text x="${cx}" y="${cy + 4}" font-size="11" font-weight="800" text-anchor="middle" fill="#111" letter-spacing="2"${alta ? ` transform="rotate(-90 ${cx} ${cy})"` : ''}>${esc(t)}</text>`;
      return r + (sel && PL.editar ? `<rect class="pl-tam" data-tam="${i}" x="${b.x + b.w - 9}" y="${b.y + b.h - 9}" width="12" height="12" fill="#1d4ed8"/>` : '') + '</g>';
    }
    const fill = (TIPOS[b.t] || TIPOS.an)[1], L = lineas(b), n = L.length || 1, largo = Math.max(1, ...L.map(x => x.length));
    let fs = n <= 3 && largo <= 13 ? 11 : n <= 4 && largo <= 17 ? 9.6 : 8.2; if (b.w < 70 && fs > 9) fs = 9;
    const lh = fs + 1.6, top = b.c ? 14 : 3, y0 = b.y + top + ((b.h - top) - n * lh) / 2 + fs - 1;
    const sel = PL.sel === i;
    return `<g class="pl-c${PL.editar ? ' ed' : ''}" data-i="${i}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${fill}" stroke="${sel ? '#1d4ed8' : '#2b2b2b'}" stroke-width="${sel ? 3 : 1.3}"/>`
      + (b.c ? `<text x="${b.x + 5}" y="${b.y + 12}" font-size="9" font-weight="700" fill="${b.t === 'pal' ? '#8a6d3b' : b.t === 'rack' ? '#7a6a00' : '#666'}">${esc(b.c)}</text>` : '')
      + (L.length ? L.map((t, k) => `<text x="${b.x + b.w / 2}" y="${y0 + k * lh}" font-size="${fs}" font-weight="700" text-anchor="middle" fill="#111">${esc(t)}</text>`).join('')
        : `<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2 + 4}" font-size="10" text-anchor="middle" fill="#aaa">vacío</text>`)
      + (sel && PL.editar ? `<rect class="pl-tam" data-tam="${i}" x="${b.x + b.w - 9}" y="${b.y + b.h - 9}" width="12" height="12" fill="#1d4ed8"/>` : '') + '</g>';
  }
  function pintarPl() {
    const box = $('plSvg'); if (!box) return;
    document.querySelectorAll('#plPiso [data-p]').forEach(b => b.setAttribute('aria-pressed', +b.dataset.p === PL.piso));
    $('plEdit').textContent = PL.editar ? '✔ Terminar de editar' : '✎ Editar';
    $('plAdd').hidden = !PL.editar; $('plReset').hidden = !PL.editar;
    const d = PL.datos[PL.piso];
    if (!d) { box.innerHTML = '<p class="note" style="padding:16px">Cargando el plano…</p>'; $('plPanel').hidden = true; return; }
    const [vx, vy, vw, vh] = d.vb;
    box.innerHTML = `<svg id="plSvgEl" xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" style="min-width:${Math.round(vw * 0.55)}px" font-family="Inter, 'Segoe UI', Arial, sans-serif">${DEFS}<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#fff"/>${d.deco || ''}${d.cajas.map((b, i) => b.t === 'zona' ? cajaSvg(b, i) : '').join('')}${d.cajas.map((b, i) => b.t === 'zona' ? '' : cajaSvg(b, i)).join('')}</svg>`;
    pintarPanel(); pintarAux();
  }
  function pintarPanel() {
    const p = $('plPanel'), d = PL.datos[PL.piso], b = d?.cajas[PL.sel];
    p.hidden = !(PL.editar && b); if (p.hidden) return;
    $('plC').value = b.c || ''; $('plL').value = (b.l || []).join('\n'); $('plT').value = b.t || 'an';
    $('plW').value = Math.round(b.w); $('plH').value = Math.round(b.h); $('plA').value = +b.a || '';
    $('plAlab').textContent = b.t === 'zona' ? 'Número de auxiliar' : 'Auxiliar';
  }
  // lista de laboratorios que ve cada auxiliar (según las zonas y los cuadros marcados a mano)
  function pintarAux() {
    const el = $('plAux'), d = PL.datos[PL.piso]; if (!el || !d) return;
    const A = new Map();
    for (const b of d.cajas) { if (b.t === 'zona' || b.t === 'esc') continue; const a = auxDe(b, d); if (!a) continue;
      const m = A.get(a) || A.set(a, new Map()).get(a); for (const l of (b.l || []).filter(l => !/^\d+$/.test(l))) { const x = m.get(l) || m.set(l, []).get(l); if (b.c && !x.includes(b.c)) x.push(b.c); } }
    if (!A.size) { el.innerHTML = ''; return; }
    el.innerHTML = '<h3>Laboratorios de cada auxiliar · ' + esc(d.titulo || (PL.piso + '.º piso')) + '</h3><div class="pl-auxg">' + [...A.keys()].sort((a, b) => a - b).map(a => {
      const m = A.get(a), nom = d.cajas.find(z => z.t === 'zona' && +z.a === a)?.c || 'AUXILIAR ' + a;
      return `<div class="pl-aux" style="--c:${auxCol(a)}"><b>${esc(nom)}</b><span class="note">${m.size} laboratorios</span><ul>${[...m].sort((x, y) => x[0].localeCompare(y[0])).map(([l, cs]) => `<li>${esc(l)}${cs.length ? ` <small>${esc(cs.join(', '))}</small>` : ''}</li>`).join('')}</ul></div>`;
    }).join('') + '</div>';
  }
  // guardar (todo el plano de los dos pisos, en un solo documento)
  function guardar() {
    clearTimeout(PL.guardando);
    PL.guardando = setTimeout(async () => {
      PL.guardando = null;
      if (!S.db || S.ejemplo) return;
      try {
        await S.db.doc('config/planos_lab').set({ p1: JSON.stringify(PL.datos[1]), p2: JSON.stringify(PL.datos[2]), actualizado: new Date().toISOString(),
          porNombre: window.parent?.document?.getElementById('uNombre')?.textContent || '' });
        $('plEstado').textContent = 'Guardado ' + new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
      } catch (e) { $('plEstado').textContent = 'No se pudo guardar: ' + (e.code === 'permission-denied' ? 'no tiene permiso para editar' : e.message || e); }
    }, 600);
  }
  async function originales() {
    const [a, b] = await Promise.all([1, 2].map(n => fetch(`planos/plano_lab_piso${n}.json?v=202611231000`).then(r => r.json())));
    return { 1: a, 2: zonasAux(b) };
  }
  // la escalera del 2.º piso era parte del dibujo fijo: se vuelve un cuadro editable, puesto donde indicó el usuario (junto a la pared, debajo de los pallets)
  const RX_ESC = /<rect x="64" y="160" width="86" height="360"[^>]*\/>(<line x1="64"[^>]*\/>)*<text[^>]*>ESCALERA<\/text>/;
  function escaleraEditable(d) {
    if (!d || !RX_ESC.test(d.deco || '')) return d;
    d.deco = d.deco.replace(RX_ESC, '');
    if (!d.cajas.some(b => b.t === 'esc')) d.cajas.push({ x: 64, y: 285, w: 86, h: 400, c: '', l: ['ESCALERA'], t: 'esc' });
    return d;
  }
  // 2.º piso (pedido del usuario): la pared izquierda se corre hacia el pasadizo y en esa franja, junto a la pared,
  // van arriba el Pallet 2 (MARKOS / ABBOTT), debajo el Pallet 1 (PLENITUD) y después la escalera. Solo mueve los que siguen en su lugar original.
  function franjaIzquierda(d) {
    if (!d || !(d.deco || '').includes('160,70 1684,70')) return d;
    d.deco = d.deco.replace('160,70 1684,70 1704,584 2460,584 2460,916 160,916', '40,70 1684,70 1704,584 2460,584 2460,916 40,916')
      .replace('160,130 -90,130 -90,580 160,580', '40,130 -90,130 -90,580 40,580')
      .replace('x="-16" y="566" font-size="9.5"', 'x="-25" y="566" font-size="8.2"')
      .replace('x="-16" y="548"', 'x="-25" y="548"')
      .replace('x="-16" y="532" font-size="10.5"', 'x="-25" y="532" font-size="9.5"');
    const pon = (f, v) => { const b = d.cajas.find(f); if (b) Object.assign(b, v); };
    pon(b => b.t === 'pal' && b.x === -76 && b.y === 350, { x: 60, y: 84, w: 110, h: 100 });
    pon(b => b.t === 'pal' && b.x === -76 && b.y === 190, { x: 60, y: 194, w: 110, h: 100 });
    pon(b => b.t === 'esc' && b.x === 64 && b.y === 285, { x: 72, y: 306, w: 86, h: 380 });
    return d;
  }
  // 2.º piso (pedido del usuario): tres zonas, una por auxiliar. Auxiliar 1: escalera, pallets, ABC y DEF; Auxiliar 2: GHIK y MLNP;
  // Auxiliar 3: PQRS, UWZ y el cuarto de material médico / Química Suiza. Fuera de su zona: ZAIMELLA → 1, BABYSEC → 2, KIMBERLY → 3.
  function zonasAux(d) {
    if (!d || d.zonas) return d; d.zonas = 1;
    if (!d.cajas.some(b => b.t === 'zona')) d.cajas.unshift(
      { x: 40, y: 40, w: 670, h: 888, c: 'AUXILIAR 1', l: [], t: 'zona', a: 1 },
      { x: 718, y: 40, w: 534, h: 888, c: 'AUXILIAR 2', l: [], t: 'zona', a: 2 },
      { x: 1260, y: 40, w: 1196, h: 888, c: 'AUXILIAR 3', l: [], t: 'zona', a: 3 });
    for (const b of d.cajas) { if (b.t === 'zona' || b.a) continue; const t = (b.l || []).join(' ').toUpperCase();
      if (/ZAIMELLA/.test(t)) b.a = 1; else if (/BABYSEC/.test(t)) b.a = 2; else if (/KIMBER/.test(t)) b.a = 3; }
    return d;
  }
  async function cargar() {
    if (PL.cargado) return; PL.cargado = true;
    let orig = null;
    const usar = async d => {
      if (d?.p1 && d?.p2) { PL.datos = { 1: JSON.parse(d.p1), 2: zonasAux(franjaIzquierda(escaleraEditable(JSON.parse(d.p2)))) }; }
      else { orig ??= await originales(); PL.datos = { 1: orig[1], 2: orig[2] }; }
      if (!PL.guardando && !PL.arrastre) pintarPl();
    };
    try {
      if (S.db?.doc('config/planos_lab').onSnapshot) S.db.doc('config/planos_lab').onSnapshot(sn => usar(sn.exists ? sn.data() : null), () => usar(null));
      else usar(null);
    } catch { usar(null); }
  }
  window.pintarPlanosLab = () => { cargar(); pintarPl(); };

  // ---- edición: seleccionar, mover y agrandar con el mouse ----
  const pt = e => { const svg = $('plSvgEl'), p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
  $('plSvg').addEventListener('pointerdown', e => {
    if (!PL.editar) return;
    const t = e.target.closest('[data-tam]'), g = e.target.closest('[data-i]'), d = PL.datos[PL.piso];
    if (!g && !t) { PL.sel = null; pintarPl(); return; }
    const i = +(t ? t.dataset.tam : g.dataset.i), b = d.cajas[i], p0 = pt(e);
    PL.sel = i; PL.arrastre = { i, tam: !!t, p0, x: b.x, y: b.y, w: b.w, h: b.h, movio: false };
    pintarPl(); e.preventDefault();
  });
  window.addEventListener('pointermove', e => {
    const a = PL.arrastre; if (!a) return; const b = PL.datos[PL.piso].cajas[a.i], p = pt(e), dx = p.x - a.p0.x, dy = p.y - a.p0.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) a.movio = true;
    if (a.tam) { b.w = Math.max(24, Math.round(a.w + dx)); b.h = Math.max(18, Math.round(a.h + dy)); } else { b.x = Math.round(a.x + dx); b.y = Math.round(a.y + dy); }
    pintarPl();
  });
  window.addEventListener('pointerup', () => { const a = PL.arrastre; PL.arrastre = null; if (a?.movio) guardar(); });
  // ---- panel del cuadro elegido ----
  $('plPanel').addEventListener('input', e => {
    const b = PL.datos[PL.piso]?.cajas[PL.sel]; if (!b) return;
    if (e.target.id === 'plC') b.c = e.target.value.trim();
    if (e.target.id === 'plL') b.l = e.target.value.split('\n').map(x => x.trim()).filter(Boolean);
    if (e.target.id === 'plT') b.t = e.target.value;
    if (e.target.id === 'plW') b.w = Math.max(24, +e.target.value || b.w);
    if (e.target.id === 'plH') b.h = Math.max(18, +e.target.value || b.h);
    if (e.target.id === 'plA') { b.a = +e.target.value || 0; if (!b.a) delete b.a; }
    const ae = document.activeElement?.id; pintarPl(); if (ae) { const el = $(ae); el?.focus(); } guardar();
  });
  $('plPanel').addEventListener('click', e => {
    const d = PL.datos[PL.piso], b = d?.cajas[PL.sel]; if (!b) return;
    if (e.target.closest('#plDel')) { if (!confirm(`¿Quitar el cuadro ${b.c || (b.l || []).join(', ') || ''}?`)) return; d.cajas.splice(PL.sel, 1); PL.sel = null; pintarPl(); guardar(); }
    if (e.target.closest('#plDup')) { d.cajas.push({ ...b, l: [...(b.l || [])], x: b.x + 14, y: b.y + 14 }); PL.sel = d.cajas.length - 1; pintarPl(); guardar(); }
  });
  $('plT').innerHTML = Object.entries(TIPOS).map(([k, [t]]) => `<option value="${k}">${esc(t)}</option>`).join('');
  $('plPiso').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) { PL.piso = +b.dataset.p; PL.sel = null; pintarPl(); } });
  $('plEdit').addEventListener('click', () => { PL.editar = !PL.editar; PL.sel = null; pintarPl(); });
  $('plAdd').addEventListener('click', () => {
    const d = PL.datos[PL.piso]; if (!d) return; const [vx, vy, vw, vh] = d.vb;
    d.cajas.push({ x: Math.round(vx + vw / 2 - 50), y: Math.round(vy + vh / 2 - 30), w: 100, h: 60, c: '', l: ['NUEVO'], t: 'an' });
    PL.sel = d.cajas.length - 1; pintarPl(); guardar(); setTimeout(() => $('plL')?.select(), 50);
  });
  $('plReset').addEventListener('click', async () => {
    if (!confirm(`¿Volver el ${PL.datos[PL.piso]?.titulo || 'piso'} a como estaba al principio? Se pierden los cambios de este piso.`)) return;
    const o = await originales(); PL.datos[PL.piso] = o[PL.piso]; PL.sel = null; pintarPl(); guardar();
  });
  // descargar el plano como imagen (PNG)
  $('plPNG').addEventListener('click', () => {
    const sel = PL.sel, ed = PL.editar; PL.sel = null; PL.editar = false; pintarPl();
    const svg = $('plSvgEl'), vb = PL.datos[PL.piso].vb, k = 2, xml = new XMLSerializer().serializeToString(svg);
    PL.sel = sel; PL.editar = ed; pintarPl();
    const img = new Image(); img.onload = () => {
      const c = document.createElement('canvas'); c.width = vb[2] * k; c.height = vb[3] * k; const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
      const a = document.createElement('a'); a.download = `plano_${PL.piso === 1 ? 'primer' : 'segundo'}_piso.png`; a.href = c.toDataURL('image/png'); a.click(); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml.replace('<svg ', `<svg width="${vb[2]}" height="${vb[3]}" `));
  });
})();
