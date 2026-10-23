/* Atención a sucursales: qué enviar a cada sucursal para cubrir N días + N días de seguridad, según el movimiento de esa
   sucursal. Misma forma que Estadística Proyx: lista con estado de cobertura y, para el producto elegido, su detalle
   en la sucursal y en toda la red. Lo que falta en droguería se reparte primero a las sucursales con menos cobertura;
   el resto se marca para pasar de otra sucursal con exceso o para comprar. Usa las variables y ayudas de proyeccion.html. */
(function () {
  S.suFarm = ''; S.suVer = 'enviar'; S.suMostrar = PAGINA; S.suCur = null;
  const soles2 = v => 'S/ ' + nf0.format(Math.round(v || 0));
  const val = id => $(id).value;
  function opciones() {
    return { C: Math.max(1, +val('suCob') || 7), Sg: Math.max(0, +val('suSeg') || 0), fte: val('suFte'), tipos: val('suTip') };
  }

  /* ---------- venta diaria de la sucursal ---------- */
  const motor = new Map(); let motorDe = null;
  function diaria(p, f, o) {
    if (o.fte === 'motor') {
      if (motorDe !== S.P) { motor.clear(); motorDe = S.P; }
      const k = p.c + '|' + f; let r = motor.get(k);
      if (r === undefined) {
        const hv = S.P.hfm && p.hf?.[f] ? p.hf[f] : (p.h || []).map(v => v == null ? null : v * (p.s?.[f] || 0));
        const fp = window.FREPPLE.pronosticar(hv, 3); r = { d: Math.max(0, fp.f.reduce((a, v) => a + v, 0) / 3 / 30), metodo: fp.metodo, hv, f: fp.f };
        motor.set(k, r);
      }
      return r;
    }
    const n = +o.fte, v = ventaDias(p, f, n);
    return { d: v == null ? diariaHist(p, f) : v / n, metodo: v == null ? 'historial (sin kardex por día)' : `ventas de ${n} días` };
  }

  /* ---------- cálculo de toda la red (todas las sucursales, para repartir lo de droguería) ---------- */
  let cache = null, cacheClave = '';
  function calcular(o) {
    const clave = JSON.stringify(o);
    if (cache && cacheDe === S.P && cacheClave === clave) return cache;
    cacheDe = S.P; cacheClave = clave;
    const filas = [], porProd = new Map();
    for (const p of S.P.p) {
      const red = [];
      for (const f of S.P.farmacias) {
        const st = +(window.STOCK_TODOS?.[p.c]?.[f]?.[0] ?? p.st?.[f] ?? 0) || 0, c = p.catF?.[f] || 'E';
        const dv = diaria(p, f, o), d = dv.d;
        if (!d && !st) continue;
        const bloq = bloqueado(p.c, f), nec = d * (o.C + o.Sg), seg = d * o.Sg, cob = d > 0 ? st / d : Infinity;
        let pide = 0, nota = '';
        if (bloq) nota = 'bloqueado';
        else if (o.tipos === 'todos' ? d > 0 : c === 'A') pide = Math.max(0, Math.ceil(nec - st - 1e-9));
        else if (o.tipos !== 'todos' && c === 'B') pide = st < 1 && d > 0 ? 1 : 0;
        else if (d > 0) nota = c === 'C' ? 'a pedido' : c === 'D' ? 'solo con pedido' : '';
        const exceso = !bloq && st > 0 && (d === 0 ? st >= 1 : st - nec * 2 >= 1) ? Math.floor(d === 0 ? st : st - nec) : 0;
        red.push({ p, f, st, cat: c, d, metodo: dv.metodo, nec, seg, cob, pide, nota, bloq, exceso, urgente: d > 0 && st < seg && !bloq });
      }
      if (!red.length) continue;
      // reparto de lo que hay en droguería: primero las sucursales con menos días de cobertura
      let disp = Math.max(0, +(window.STOCK_TODOS?.[p.c]?.['DROGUERIA FS']?.[0] ?? p.sd ?? 0) || 0);
      const dispIni = disp;
      for (const r of [...red].filter(r => r.pide > 0).sort((a, b) => a.cob - b.cob)) {
        r.drog = Math.min(r.pide, Math.floor(disp)); disp -= r.drog; r.falta = r.pide - r.drog;
      }
      // lo que falta: de otra sucursal con exceso de ese producto, o comprar
      const conExc = red.filter(r => r.exceso > 0).sort((a, b) => b.exceso - a.exceso);
      for (const r of red.filter(r => r.falta > 0)) {
        let falta = r.falta; r.desde = [];
        for (const x of conExc) { if (!falta) break; const q = Math.min(falta, x.exceso - (x.dado || 0)); if (q > 0) { r.desde.push([x.f, q]); x.dado = (x.dado || 0) + q; falta -= q; } }
        r.comprar = falta;
      }
      porProd.set(p.c, { red, drog: dispIni });
      filas.push(...red);
    }
    cache = { filas, porProd }; return cache;
  }
  let cacheDe = null;

  /* ---------- lista ---------- */
  const VER = { enviar: r => r.pide > 0, urgente: r => r.urgente, comprar: r => r.comprar > 0, exceso: r => r.exceso > 0, '': r => r.d > 0 || r.st > 0 };
  const colorCob = (r, o) => r.d <= 0 ? '#9e9e9e' : r.cob < o.Sg ? '#d9302c' : r.cob < o.C + o.Sg ? '#f0ad4e' : r.cob <= (o.C + o.Sg) * 2 ? '#43a047' : '#1e6bb8';
  const cobTxt = r => r.d <= 0 ? 'sin venta' : r.cob > 999 ? '> 999 d' : nf0.format(Math.floor(r.cob)) + ' d';
  const corto2 = f => String(f).replace(/^ALMACEN /, '');
  window.pintarSuc = function () {
    llenarLabs(); llenarClas();
    const o = opciones(), { filas } = calcular(o);
    // sucursales
    const farms = S.P.farmacias;
    if ($('suFarm').options.length !== farms.length + 1) $('suFarm').innerHTML = `<option value="">Todas las sucursales</option>` + farms.map(f => `<option value="${esc(f)}">${esc(corto2(f))}</option>`).join('');
    $('suFarm').value = S.suFarm;
    const base = filas.filter(r => (!S.suFarm || r.f === S.suFarm) && (!S.lab || labDe(r.p.c) === S.lab) && pasaClas(r.p));
    const env = base.filter(VER.enviar), urg = base.filter(VER.urgente), com = base.filter(VER.comprar), exc = base.filter(VER.exceso);
    $('suk1').textContent = nf0.format(env.length); $('suk1s').textContent = `${nf0.format(env.reduce((s, r) => s + r.pide, 0))} cajas · ${soles2(env.reduce((s, r) => s + r.pide * (r.p.k || 0), 0))}`;
    $('suk2').textContent = nf0.format(urg.length); $('suk3').textContent = nf0.format(com.length);
    $('suk3s').textContent = `${nf0.format(com.reduce((s, r) => s + r.comprar, 0))} cajas que no hay en droguería`;
    $('suk4').textContent = nf0.format(exc.length); $('suk4s').textContent = `${soles2(exc.reduce((s, r) => s + r.exceso * (r.p.k || 0), 0))} para pasar o devolver`;
    document.querySelectorAll('#suCards [data-ver]').forEach(b => b.setAttribute('aria-pressed', b.dataset.ver === S.suVer));
    $('suVer').value = S.suVer;
    // resumen por sucursal (lo que hay que enviar a cada una)
    const porF = new Map(); for (const r of filas) if (r.pide > 0 && (!S.lab || labDe(r.p.c) === S.lab) && pasaClas(r.p)) { const x = porF.get(r.f) || { n: 0, u: 0, cj: 0, v: 0 }; x.n++; x.cj += r.pide; x.v += r.pide * (r.p.k || 0); if (r.urgente) x.u++; porF.set(r.f, x); }
    $('suChips').innerHTML = [...porF.entries()].sort((a, b) => b[1].u - a[1].u || b[1].v - a[1].v).map(([f, x]) =>
      `<button type="button" class="su-chip" data-farm="${esc(f)}" aria-pressed="${S.suFarm === f}"><b>${esc(corto2(f))}</b><span>${nf0.format(x.n)} prod. · ${nf0.format(x.cj)} cj · ${soles2(x.v)}</span>${x.u ? `<i>${x.u} urgentes</i>` : ''}</button>`).join('')
      || '<span class="z">Ninguna sucursal necesita envíos con estos parámetros.</span>';
    const lista = filtroTexto(base.filter(VER[S.suVer]).map(r => Object.assign(r, { c: r.p.c, n: r.p.n })), val('suq'))
      .sort((a, b) => S.suVer === 'exceso' ? b.exceso * (b.p.k || 0) - a.exceso * (a.p.k || 0) : (b.urgente - a.urgente) || a.cob - b.cob || b.pide - a.pide);
    const vis = lista.slice(0, S.suMostrar), todas = !S.suFarm;
    $('suTitulo').textContent = todas ? 'Todas las sucursales' : corto2(S.suFarm);
    $('suEyebrow').textContent = `Atender para ${o.C} días + ${o.Sg} de seguridad · venta diaria: ${o.fte === 'motor' ? 'motor estadístico de cada sucursal' : `ventas de los últimos ${o.fte} días`} · ${o.tipos === 'todos' ? 'todos los productos con venta' : 'tipo A completo, tipo B 1 unidad'}`;
    $('suH2').textContent = { enviar: 'Enviar', urgente: 'Urgentes: menos stock que los días de seguridad', comprar: 'No alcanza lo de droguería', exceso: 'Exceso en la sucursal', '': 'Todos' }[S.suVer];
    let h = `<thead><tr><th class="c0">Código</th><th class="c1">Producto</th>${todas ? '<th style="text-align:left">Sucursal</th>' : ''}<th>Tipo</th><th title="Días que alcanza el stock de la sucursal">Cobertura</th>
      <th>Venta diaria</th><th>Stock sucursal</th><th title="Venta diaria × (días + seguridad)">Necesita</th><th class="sep">Enviar</th><th title="Lo que se puede mandar desde droguería">De droguería</th><th style="text-align:left">Lo que falta</th><th>Valor</th></tr></thead><tbody>`;
    for (const r of vis) {
      const p = r.p, sel = S.suCur === p.c + '|' + r.f ? ' sel' : '';
      const falta = r.falta > 0 ? [...(r.desde || []).map(([f, q]) => `${nf0.format(q)} de ${esc(corto2(f))}`), r.comprar ? `<span class="neg">${nf0.format(r.comprar)} comprar</span>` : ''].filter(Boolean).join(' · ') : '';
      h += `<tr class="click${sel}" data-cod="${esc(p.c)}" data-f="${esc(r.f)}"><td class="c0">${esc(p.c)}</td><td class="c1" title="${esc(p.n)}">${esc(p.n)}${etiquetas(p)}<small class="sub">${esc(labDe(p.c))}${r.nota ? ' · ' + esc(r.nota) : ''}</small></td>
        ${todas ? `<td>${esc(corto2(r.f))}</td>` : ''}<td style="text-align:center">${catBadge(r.cat)}</td>
        <td class="su-cob" style="background:${colorCob(r, o)}">${cobTxt(r)}</td><td class="n">${fmtE(p, r.d)}</td><td class="n">${fmtS(p, r.st)}</td><td class="n">${fmtE(p, r.nec)}</td>
        <td class="n sep tot ent">${r.pide ? nf0.format(r.pide) : r.exceso ? `<span class="tag">sobra ${nf0.format(r.exceso)}</span>` : '·'}</td><td class="n">${r.pide ? nf0.format(r.drog || 0) : ''}</td><td>${falta}</td>
        <td class="n">${r.pide ? soles2(r.pide * (p.k || 0)) : r.exceso ? soles2(r.exceso * (p.k || 0)) : ''}</td></tr>`;
    }
    if (!vis.length) h += `<tr><td class="c0"></td><td class="c1" colspan="${todas ? 11 : 10}">Nada que mostrar con estos filtros.</td></tr>`;
    $('suTabla').innerHTML = h + '</tbody>'; ajustarC0($('suTabla'));
    $('suMore').innerHTML = `<span>Mostrando ${nf0.format(vis.length)} de ${nf0.format(lista.length)} · clic en uno para ver su detalle</span>` +
      (lista.length > vis.length ? `<button class="btn" id="suMas">Ver ${Math.min(PAGINA, lista.length - vis.length)} más</button>` : '');
    if ($('suMas')) $('suMas').onclick = () => { S.suMostrar += PAGINA; window.pintarSuc(); };
    S.suLista = lista;
    pintarDetalle(o);
  };

  /* ---------- detalle: el producto en la sucursal y en toda la red ---------- */
  function pintarDetalle(o) {
    const [c, f] = (S.suCur || '').split('|'), p = c && S.idx.get(c), box = $('suDet');
    const red = p && cache?.porProd.get(c);
    box.hidden = !red; if (!red) return;
    const r = red.red.find(x => x.f === f) || red.red[0];
    $('suDTit').textContent = p.n;
    $('suDSub').innerHTML = `Código <code>${esc(p.c)}</code> · ${esc(labDe(p.c) || 'sin laboratorio')} · <b>${esc(corto2(r.f))}</b> · venta diaria según ${esc(r.metodo)}`;
    const hv = S.P.hfm && p.hf?.[r.f] ? p.hf[r.f] : [], hm = (S.P.hfm || []).slice(-hv.length), n = Math.min(24, hv.length);
    const fut = motor.get(p.c + '|' + r.f)?.f || [];
    dibujar('suChart', { type: 'line', data: { labels: [...hm.slice(-n), ...S.P.fm.slice(0, fut.length)].map(et), datasets: [
      { label: `Venta en ${corto2(r.f)}`, data: [...hv.slice(-n), ...fut.map(() => null)], borderColor: '#7cb342', backgroundColor: '#7cb342', tension: .15, pointRadius: 2 },
      ...(fut.length ? [{ label: 'Pronóstico', data: [...hv.slice(-n).map(() => null), ...fut], borderColor: '#e53935', backgroundColor: '#e53935', tension: .15, pointRadius: 2 }] : [])
    ] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'right' } }, scales: { y: { beginAtZero: true } } } });
    const filas = [...red.red].sort((a, b) => (a.f === r.f ? -1 : b.f === r.f ? 1 : a.cob - b.cob));
    $('suRed').innerHTML = `<thead><tr><th class="c1 solo">Sucursal</th><th>Tipo</th><th>Venta diaria</th><th>Stock</th><th>Cobertura</th><th>Necesita</th><th>Enviar</th><th>De droguería</th><th>Sobra</th></tr></thead><tbody>
      <tr class="tot"><td class="c1 solo"><b>Droguería FS</b></td><td></td><td></td><td class="n"><b>${fmtS(p, red.drog)}</b></td><td></td><td></td><td></td><td></td><td></td></tr>` +
      filas.map(x => `<tr${x.f === r.f ? ' class="sel"' : ''}><td class="c1 solo">${esc(corto2(x.f))}</td><td style="text-align:center">${catBadge(x.cat)}</td><td class="n">${fmtE(p, x.d)}</td><td class="n">${fmtS(p, x.st)}</td>
        <td class="su-cob" style="background:${colorCob(x, o)}">${cobTxt(x)}</td><td class="n">${fmtE(p, x.nec)}</td><td class="n big">${x.pide ? nf0.format(x.pide) : '·'}</td><td class="n">${x.pide ? nf0.format(x.drog || 0) : ''}</td><td class="n">${x.exceso ? nf0.format(x.exceso) : ''}</td></tr>`).join('') + '</tbody>';
  }

  /* ---------- exportar a Excel (CSV): lista de despacho ---------- */
  $('suXls').addEventListener('click', () => {
    const l = (S.suLista || []).filter(r => r.pide > 0);
    const t = [['Sucursal', 'Código', 'Producto', 'Laboratorio', 'Tipo', 'Enviar (cajas)', 'De droguería', 'De otra sucursal', 'Comprar', 'Stock sucursal', 'Venta diaria', 'Cobertura (días)', 'Valor S/'],
      ...l.map(r => [r.f, r.p.c, r.p.n, labDe(r.p.c), r.cat, r.pide, r.drog || 0, (r.desde || []).map(([f, q]) => `${q} de ${corto2(f)}`).join(' / '), r.comprar || 0,
        nf1.format(r.st), nf1.format(r.d), r.d > 0 ? Math.floor(r.cob) : '', (r.pide * (r.p.k || 0)).toFixed(2).replace('.', ',')])];
    const txt = t.map(f => f.map(v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + txt], { type: 'text/csv;charset=utf-8' }));
    a.download = `atencion_${S.suFarm ? corto2(S.suFarm).replace(/\s+/g, '_') : 'sucursales'}_${S.P.corte}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  /* ---------- eventos ---------- */
  const otra = () => { S.suMostrar = PAGINA; window.pintarSuc(); };
  $('suPres').addEventListener('click', e => { const b = e.target.closest('[data-d]'); if (!b) return; $('suCob').value = b.dataset.d; $('suSeg').value = b.dataset.s; marcarPres(); otra(); });
  const marcarPres = () => document.querySelectorAll('#suPres [data-d]').forEach(b => b.setAttribute('aria-pressed', b.dataset.d === val('suCob') && b.dataset.s === val('suSeg')));
  ['suCob', 'suSeg', 'suFte', 'suTip'].forEach(id => $(id).addEventListener('change', () => { marcarPres(); otra(); }));
  $('suFarm').addEventListener('change', e => { S.suFarm = e.target.value; otra(); });
  $('suVer').addEventListener('change', e => { S.suVer = e.target.value; otra(); });
  $('suq').addEventListener('input', otra);
  $('suCards').addEventListener('click', e => { const b = e.target.closest('[data-ver]'); if (b) { S.suVer = b.dataset.ver; otra(); } });
  $('suChips').addEventListener('click', e => { const b = e.target.closest('[data-farm]'); if (b) { S.suFarm = S.suFarm === b.dataset.farm ? '' : b.dataset.farm; otra(); } });
  $('suTabla').addEventListener('click', e => {
    const tr = e.target.closest('tr.click'); if (!tr) return;
    S.suCur = tr.dataset.cod + '|' + tr.dataset.f; window.pintarSuc(); $('suDet').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('suFicha').addEventListener('click', () => { const c = (S.suCur || '').split('|')[0]; if (c) abrirFichaP(c, 'suc'); });
  $('suCerrar').addEventListener('click', () => { S.suCur = null; window.pintarSuc(); });
  marcarPres();
})();
