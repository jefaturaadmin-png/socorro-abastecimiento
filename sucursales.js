/* Atención a sucursales: qué enviar a cada sucursal para cubrir N días + N días de seguridad, según el movimiento de esa
   sucursal. Misma forma que Estadística Proyx: lista con estado de cobertura y, para el producto elegido, su detalle
   en la sucursal y en toda la red. Lo que falta en droguería se reparte primero a las sucursales con menos cobertura;
   el resto se marca para pasar de otra sucursal con exceso o para comprar. Usa las variables y ayudas de proyeccion.html. */
(function () {
  S.suFarm = ''; S.suVer = 'enviar'; S.suMostrar = PAGINA; S.suCur = null;
  const soles2 = v => 'S/ ' + nf0.format(Math.round(v || 0));
  const val = id => $(id).value;
  /* ---------- criterios: general, por sucursal y por producto (proy_config/atencion_cfg) ----------
     def: el criterio general · suc[SUCURSAL]: el propio de una sucursal · prod[SUCURSAL | '*'][código]: el de un producto
     (en esa sucursal o en todas). Cada nivel pisa al anterior; lo que no se indica se toma del nivel de arriba. */
  const DEF = { C: 7, Sg: 7, fte: '30', tipos: 'ab' };
  let CFG = { def: { ...DEF }, suc: {}, prod: {} }, cfgListo = false, cfgCargando = false, cfgVer = 0;
  async function cargarCfg() {
    // Se lee solo cuando ya están tus datos (al abrir, la página muestra un momento datos de ejemplo):
    // así no se trabaja con el criterio por defecto ni se pisa lo guardado.
    if (cfgListo || cfgCargando || !S.db || S.ejemplo) return; cfgCargando = true;
    try {
      const d = await S.db.doc('config/atencion_cfg').get();
      if (d.exists) { const x = d.data(); CFG = { def: { ...DEF, ...(x.def || {}) }, suc: x.suc || {}, prod: x.prod || {} }; }
      cfgListo = true;
    } catch (e) { console.warn(e); }
    cfgCargando = false; cfgVer++; if (cfgListo && S.vista === 'suc') window.pintarSuc();
  }
  let tGuardar = null;
  function guardarCfg() {
    cfgVer++; clearTimeout(tGuardar);
    tGuardar = setTimeout(async () => {
      if (!S.db || S.ejemplo || !cfgListo) return;
      try {
        await S.db.doc('config/atencion_cfg').set(CFG); S.suGuardado = new Date();
        $('suPub').textContent = 'Criterio guardado. Actualizando lo que ven las sucursales…'; pintarControles(); await publicar();
      }
      catch (e) { $('suPub').textContent = 'No se pudo guardar el criterio: ' + (e.message || e); }
    }, 1200);
  }
  const ajProd = (f, c) => CFG.prod[f]?.[c] || CFG.prod['*']?.[c] || null;
  const cfgSuc = f => ({ ...CFG.def, ...(f ? CFG.suc[f] || {} : {}) });
  const cfgDe = (f, c) => { const o = { ...cfgSuc(f), ...(CFG.prod['*']?.[c] || {}), ...(CFG.prod[f]?.[c] || {}) }; o.C = Math.max(1, +o.C || 7); o.Sg = Math.max(0, +o.Sg || 0); return o; };
  const fteTxt = fte => fte === 'motor' ? 'motor estadístico' : `ventas de ${fte} días`;
  const ajTxt = a => !a ? '' : [a.fte ? fteTxt(a.fte) : '', a.C != null || a.Sg != null ? `${a.C ?? '–'} + ${a.Sg ?? '–'} días` : '', a.modo === 'forzar' ? 'atender siempre que le falte' : a.modo === 'excluir' ? 'no atender' : ''].filter(Boolean).join(' · ');
  // los controles de arriba muestran y cambian el criterio de la sucursal elegida (o el general con "Todas")
  function pintarControles() {
    const o = cfgSuc(S.suFarm);
    $('suCob').value = o.C; $('suSeg').value = o.Sg; $('suFte').value = o.fte; $('suTip').value = o.tipos; marcarPres();
    // productos con ajuste que aplican aquí: los de esta sucursal y los de "todas las sucursales"
    // con "Todas": los ajustes de todas las sucursales, cada uno con su sucursal
    const ajs = S.suFarm
      ? [...Object.entries(CFG.prod[S.suFarm] || {}).map(([c, a]) => [c, a, S.suFarm]), ...Object.entries(CFG.prod['*'] || {}).filter(([c]) => !CFG.prod[S.suFarm]?.[c]).map(([c, a]) => [c, a, '*'])]
      : Object.entries(CFG.prod).flatMap(([k, m]) => Object.entries(m).map(([c, a]) => [c, a, k]));
    const nP = ajs.length, propias = Object.keys(CFG.suc).length;
    const lista = nP ? ` <button type="button" class="btn sm" id="suVerAj">✎ Ver ${nP} producto${nP > 1 ? 's' : ''} con ajuste</button>
      <span class="su-ajs">${ajs.slice(0, 12).map(([c, a, d]) => `<button type="button" class="su-ajp" data-aj="${esc(c)}" data-f="${esc(d)}" title="${esc(ajTxt(a))}">${esc(c)} ${esc(S.idx.get(c)?.n || '')} · <b>${d === '*' ? 'todas' : esc(nomSuc(d))}</b></button>`).join('')}${nP > 12 ? ` <span class="z">y ${nP - 12} más</span>` : ''}</span>` : '';
    $('suCrit').innerHTML = !S.suFarm
      ? `<b>Criterio general</b>: lo usan las sucursales que no tienen uno propio${propias ? `. ${propias === 1 ? 'Esta sucursal tiene' : `Estas ${propias} sucursales tienen`} criterio propio (clic para verla): <span class="su-ajs">${Object.entries(CFG.suc).map(([f, x]) =>
        `<button type="button" class="su-ajp" data-suc="${esc(f)}" title="Ver ${esc(nomSuc(f))}"><b>${esc(nomSuc(f))}</b> · ${x.C} + ${x.Sg} días · ${esc(fteTxt(x.fte))} · ${x.tipos === 'todos' ? 'todo lo que se vende' : 'tipo A y B'}</button>`).join('')}</span>` : ''}.${lista}`
      : CFG.suc[S.suFarm] ? `<b>Criterio propio de ${esc(nomSuc(S.suFarm))}</b>. <button type="button" class="btn sm" id="suGeneral">Usar el criterio general</button>${lista}`
      : `${esc(nomSuc(S.suFarm))} usa el <b>criterio general</b>. Si cambias algo arriba, se guarda solo para ${esc(nomSuc(S.suFarm))}.${lista}`;
    $('suCrit').innerHTML = `<span class="su-est-g">${!cfgListo && !S.ejemplo ? '⏳ Leyendo criterios guardados…' : S.suGuardado ? `✓ Guardado a las ${S.suGuardado.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}` : '✓ Criterios guardados'}</span>`
      + $('suCrit').innerHTML + ` <button type="button" class="btn sm" id="suMasivoBtn">✎ Ajustar varios productos a la vez</button>`;
  }
  // no se cambia nada hasta tener leído lo guardado
  const puedeEditar = () => { if (cfgListo || S.ejemplo) return true; alert('Todavía se están leyendo los criterios guardados. Espera unos segundos y vuelve a intentarlo.'); pintarControles(); return false; };
  function leerControles() {
    if (!puedeEditar()) return;
    const o = { C: Math.max(1, +val('suCob') || 7), Sg: Math.max(0, +val('suSeg') || 0), fte: val('suFte'), tipos: val('suTip') };
    if (S.suFarm) CFG.suc[S.suFarm] = o; else CFG.def = o;
    guardarCfg();
  }

  /* ---------- venta diaria de la sucursal ---------- */
  const motor = new Map(); let motorDe = null;
  // pronóstico estadístico de la venta mensual del producto en una sucursal (se guarda para no repetirlo)
  function motorEn(p, f) {
    if (motorDe !== S.P) { motor.clear(); motorDe = S.P; }
    const k = p.c + '|' + f; let r = motor.get(k);
    if (r === undefined) {
      const hv = S.P.hfm && p.hf?.[f] ? p.hf[f] : (p.h || []).map(v => v == null ? null : v * (p.s?.[f] || 0));
      const fp = window.FREPPLE.pronosticar(hv, 12), f3 = fp.f.slice(0, 3);
      r = { d: Math.max(0, f3.reduce((a, v) => a + v, 0) / 3 / 30), metodo: fp.metodo, hv, f: f3, f12: fp.f, fp };
      motor.set(k, r);
    }
    return r;
  }
  function diaria(p, f, o) {
    if (o.fte === 'motor') return motorEn(p, f);
    const n = +o.fte, v = ventaDias(p, f, n);
    return { d: v == null ? diariaHist(p, f) : v / n, metodo: v == null ? 'historial (sin kardex por día)' : `ventas de ${n} días` };
  }

  /* ---------- cálculo de toda la red (todas las sucursales, para repartir lo de droguería) ---------- */
  let cache = null, cacheClave = '';
  function calcular() {
    const clave = cfgVer + '|' + respVer + '|' + JSON.stringify(CFG);
    if (cache && cacheDe === S.P && cacheClave === clave) return cache;
    cacheDe = S.P; cacheClave = clave;
    const filas = [], porProd = new Map();
    for (const p of S.P.p) {
      const red = [];
      for (const f of S.P.farmacias) {
        const r = filaBase(p, f);
        if (r.d || r.st || r.aj) red.push(r);   // los productos con ajuste se listan siempre
      }
      if (!red.length) continue;
      repartir(p, red);
      porProd.set(p.c, { red, drog: red.drogIni });
      filas.push(...red);
    }
    cache = { filas, porProd }; return cache;
  }
  // fila de un producto en una sucursal con su criterio (también para los que no tienen venta ni stock)
  function filaBase(p, f) {
        const st = +(window.STOCK_TODOS?.[p.c]?.[f]?.[0] ?? p.st?.[f] ?? 0) || 0, c = p.catF?.[f] || 'E';
        const o = cfgDe(f, p.c), aj = ajProd(f, p.c), dv = diaria(p, f, o);
        // "Se tiene otro medicamento en su cambio": el que usa en su lugar se atiende con la venta del original
        const usa = enCambio(p, f), cambio = usa ? null : cambioDe(p, f), dOrig = cambio ? diaria(cambio.orig, f, cfgDe(f, cambio.orig.c)).d : 0;
        // lo que droguería dice que reemplaza a otro (Faltantes: "existe otro medicamento" o "descontinuado" con reemplazo):
        // a la sucursal a la que le falta el original se le atiende este, con la venta del original
        let extra = 0; const enLugar = [];
        if (!usa) for (const oc of reempDrog.get(p.c) || []) {
          const op = prodDe(oc); if (!op || enCambio(op, f)) continue;
          const oo = cfgDe(f, op.c), dO = diaria(op, f, oo).d, stO = +(window.STOCK_TODOS?.[op.c]?.[f]?.[0] ?? op.st?.[f] ?? 0) || 0;
          if (dO > 0 && stO < dO * (oo.C + oo.Sg)) { extra += dO; enLugar.push(op.c + ' - ' + op.n); }
        }
        const d = Math.max(dv.d, dOrig) + extra;
        const bloq = bloqueado(p.c, f), nec = d * (o.C + o.Sg), seg = d * o.Sg, cob = d > 0 ? st / d : Infinity;
        let pide = 0, nota = '';
        if (usa) return { p, f, st, cat: c, d, metodo: dv.metodo, nec, seg, cob, pide: 0, nota: 'usa en su cambio ' + usa, bloq, exceso: 0, o, aj, urgente: false, usa };
        if (bloq) nota = 'bloqueado';
        else if (cambio) { pide = d > 0 ? Math.max(0, Math.ceil(nec - st - 1e-9)) : 0; nota = 'en cambio de ' + cambio.orig.c; }
        else if (o.modo === 'excluir') nota = 'no atender (ajuste)';
        else if (o.modo === 'forzar') pide = d > 0 ? Math.max(0, Math.ceil(nec - st - 1e-9)) : 0;
        else if (o.tipos === 'todos' ? d > 0 : c === 'A') pide = Math.max(0, Math.ceil(nec - st - 1e-9));
        else if (o.tipos !== 'todos' && c === 'B') pide = d > 0 && st < nec ? 1 : 0;   // B: 1 caja solo si su stock no cubre los días elegidos
        else if (d > 0) nota = c === 'C' ? 'a pedido' : c === 'D' ? 'solo con pedido' : '';
        if (!bloq && extra > 0) { pide = Math.max(pide, Math.ceil(nec - st - 1e-9)); nota = 'en lugar de ' + enLugar.join(', ') + ' (droguería)'; }
        // el original sin stock en droguería y con reemplazo: no se pide (se atiende el reemplazo)
        const rd = reempDe.get(p.c); let reemp = '', pideOrig = 0;
        if (rd && pide > 0 && !cambio && !(+(window.STOCK_TODOS?.[p.c]?.['DROGUERIA FS']?.[0] ?? p.sd ?? 0) > 0)) { pideOrig = pide; pide = 0; reemp = rd.c + ' - ' + rd.n; nota = 'droguería lo reemplaza por ' + rd.c; }
        // descontinuado (sin reemplazo) y sin stock en droguería: tampoco se pide
        const de = S.suEstados.get(p.c);
        if (!reemp && pide > 0 && !cambio && de?.estado === 'descontinuado' && !vencida(de) && !(+(window.STOCK_TODOS?.[p.c]?.['DROGUERIA FS']?.[0] ?? p.sd ?? 0) > 0)) { pideOrig = pide; pide = 0; nota = 'descontinuado (droguería)'; }
        const exceso = !bloq && st > 0 && (d === 0 ? st >= 1 : st - nec * 2 >= 1) ? Math.floor(d === 0 ? st : st - nec) : 0;
        return { p, f, st, cat: c, d, metodo: dv.metodo, nec, seg, cob, pide, nota, bloq, exceso, o, aj, urgente: d > 0 && st < seg && !bloq && o.modo !== 'excluir',
          ...(cambio ? { cambio: cambio.orig.c + ' - ' + cambio.orig.n } : {}), ...(reemp ? { reemp } : {}), ...(pideOrig ? { pideOrig } : {}), ...(enLugar.length && extra ? { enLugar: enLugar.join(', ') } : {}) };
  }
  // respuestas de las sucursales (atencion_resp): el producto que dejan de usar y el que usan en su cambio
  let respVer = 0, cambios = new Map(), prodIdx = null;
  function leerRespuestas(docs) {
    S.suResp = new Map(docs.map(d => [d.id, d.data()])); cambios = new Map(); respVer++;
    for (const r of S.suResp.values()) if (r.estado === 'otro_medicamento' && r.altCod) cambios.set(r.suc + '__' + r.altCod, r);
  }
  const prodDe = c => { if (prodIdx?.de !== S.P) prodIdx = { de: S.P, m: new Map(S.P.p.map(p => [p.c, p])) }; return prodIdx.m.get(c); };
  const enCambio = (p, f) => { const r = S.suResp?.get(f + '__' + p.c); return r?.estado === 'otro_medicamento' && r.altCod ? r.alternativa || r.altCod : ''; };
  const cambioDe = (p, f) => { const r = cambios.get(f + '__' + p.c), orig = r && prodDe(r.codpro); return orig ? { orig, r } : null; };
  // respuestas de droguería en Faltantes: el primer medicamento que indicó reemplaza al original
  let reempDrog = new Map(), reempDe = new Map();
  function leerEstados(docs) {
    S.suEstados = new Map(docs.map(d => [d.id, d.data()])); S.suEstadosOk = true; respVer++;
    reempDrog = new Map(); reempDe = new Map();
    for (const [c, e] of S.suEstados) {
      const a = (e.alternativas || [])[0]; if (!a || !['alternativa', 'descontinuado'].includes(e.estado) || vencida(e)) continue;
      reempDe.set(c, a); if (!reempDrog.has(a.c)) reempDrog.set(a.c, []); reempDrog.get(a.c).push(c);
    }
  }
  const stockEn = (c, f) => +(window.STOCK_TODOS?.[c]?.[f]?.[0] ?? prodDe(c)?.st?.[f] ?? 0) || 0;
  // antes de publicar se leen las respuestas aunque no se haya abierto esta vista
  async function cargarRespuestas() {
    if (!FB || S.ejemplo) return;
    if (!S.suResp) try { leerRespuestas((await FB.getDocs(FB.collection(FB.db, 'atencion_resp'))).docs); } catch {}
    if (!S.suEstadosOk) try { leerEstados((await FB.getDocs(FB.collection(FB.db, 'faltantes_estado'))).docs); } catch {}
  }
  function repartir(p, red) {
      // reparto de lo que hay en droguería: primero las sucursales con menos días de cobertura
      let disp = Math.max(0, +(window.STOCK_TODOS?.[p.c]?.['DROGUERIA FS']?.[0] ?? p.sd ?? 0) || 0);
      red.drogIni = disp;
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
  }
  // el producto en toda la red aunque no esté en la lista (sin venta ni stock en ninguna sucursal)
  function redDe(p) {
    const x = cache?.porProd.get(p.c); if (x) return x;
    const red = S.P.farmacias.map(f => filaBase(p, f)); repartir(p, red); return { red, drog: red.drogIni };
  }
  let cacheDe = null;

  /* ---------- lista ---------- */
  const VER = { enviar: r => r.pide > 0, urgente: r => r.urgente, comprar: r => r.comprar > 0, exceso: r => r.exceso > 0, '': r => r.d > 0 || r.st > 0 };
  const colorCob = (r, o = r.o) => r.d <= 0 ? '#9e9e9e' : r.cob < o.Sg ? '#d9302c' : r.cob < o.C + o.Sg ? '#f0ad4e' : r.cob <= (o.C + o.Sg) * 2 ? '#43a047' : '#1e6bb8';
  const cobTxt = r => r.d <= 0 ? 'sin venta' : r.cob > 999 ? '> 999 d' : nf0.format(Math.floor(r.cob)) + ' d';
  const corto2 = f => nomSuc(f);
  /* ---------- lista para el equipo: faltantes de droguería (0 en droguería y alguna sucursal lo pide) ---------- */
  // Se publica en faltantes/actual (la leen los usuarios con la vista "faltantes") y sus respuestas llegan de faltantes_estado.
  const FB = window.parent?.FB; S.suEstados = new Map();
  const fDia = v => v ? new Date(v + 'T12:00:00').toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
  const estadoTxt = e => !e ? '' : {
    descontinuado: `Descontinuado${(e.alternativas || []).length ? ' · lo reemplaza: ' + e.alternativas.map(a => a.n).join(' / ') : ''}`, pendiente: 'Pendiente de solicitud',
    agotado: `Agotado en laboratorio${e.hasta ? ' hasta el ' + fDia(e.hasta) : ''}`,
    transito: `En tránsito${e.llega ? ' · llega el ' + fDia(e.llega) : ''}`,
    alternativa: `Hay otro: ${(e.alternativas || []).map(a => a.n).join(' / ')}`
  }[e.estado] || e.estado;
  // una respuesta con fecha vencida (agotado hasta / llega el) ya no vale: el producto sigue faltando
  const vencida = e => { const h = new Date().toISOString().slice(0, 10); return (e.estado === 'agotado' && e.hasta && e.hasta < h) || (e.estado === 'transito' && e.llega && e.llega < h); };
  const tagEstado = c => { const e = S.suEstados.get(c); return e ? `<span class="tag su-est ${vencida(e) ? 'vencida' : esc(e.estado)}" title="${esc((e.porNombre || '') + (e.comentario ? ': ' + e.comentario : ''))}">${vencida(e) ? 'Venció: ' : ''}${esc(estadoTxt(e))}</span>` : ''; };
  function escucharEstados() {
    if (!FB || S.ejemplo || escucharEstados.ok) return; escucharEstados.ok = true;
    FB.onSnapshot(FB.collection(FB.db, 'faltantes_estado'), sn => { leerEstados(sn.docs); if (S.vista === 'suc') window.pintarSuc(); }, () => {});
    // lo que responde cada sucursal en "Lo que me van a atender" (atencion_resp/{SUCURSAL}__{codpro})
    FB.onSnapshot(FB.collection(FB.db, 'atencion_resp'), sn => { leerRespuestas(sn.docs); if (S.vista === 'suc') window.pintarSuc(); }, () => {});
  }
  const RESP_TXT = { no_requiere: 'No se requiere en esta sucursal', no_se_mueve: 'No se mueve', otro_medicamento: 'Tiene otro en su cambio', otros: 'Otros' };
  const tagResp = (f, c) => { const r = S.suResp?.get(f + '__' + c); if (!r) return '';
    const t = (RESP_TXT[r.estado] || r.estado) + (r.alternativa ? ': ' + r.alternativa : '') + (r.comentario ? (r.alternativa ? ' · ' : ': ') + r.comentario : '');
    return ` · <span class="tag su-resp ${esc(r.estado)}" title="${esc('Respondió ' + (r.porNombre || '') + ': ' + t)}">💬 ${esc(t)}</span>`; };
  function listaFaltantes() {
    const items = [];
    for (const [c, x] of cache.porProd) {
      if (x.drog > 0) continue;
      // también los que droguería ya reemplazó por otro (siguen faltando; se ve su respuesta)
      const q = r => r.pide || r.pideOrig || 0, s = x.red.filter(r => q(r) > 0); if (!s.length) continue;
      // con la información del producto en toda la empresa para el ojito (venta de 24 meses, pronóstico, patrón)
      const p = s[0].p, r3 = v => Math.round(v * 1000) / 1000, cl = clas(p), fp = window.FREPPLE.pronosticar(p.h || [], 12);
      items.push({ c, n: p.n, l: labDe(c) || '', t: s.reduce((a, r) => a + q(r), 0), s: s.sort((a, b) => q(b) - q(a)).map(r => ({ f: r.f, q: q(r) })),   // Firestore no acepta listas dentro de listas
        hv: (p.h || []).slice(-24).map(v => r3(v || 0)), pr: fp.f.map(r3), met: fp.metodo, pat: fp.patron || '', adi: fp.adi != null ? r3(fp.adi) : null, cv2: fp.cv2 != null ? r3(fp.cv2) : null,
        cat: p.cat, fr: p.fr || 1, k: r3(p.k || 0), li: cl.t || '', ge: cl.g || '', fa: cl.f || '', sts: r3(x.red.reduce((a, r) => a + r.st, 0)) });
    }
    items.sort((a, b) => b.s.length - a.s.length || b.t - a.t);
    // un documento de Firestore admite hasta 1 MB: se publican los más importantes hasta ~900 KB
    let bytes = 0, n = 0; while (n < items.length && (bytes += JSON.stringify(items[n]).length + 1) < 900000) n++;
    return items.slice(0, n);
  }
  async function publicar(aviso) {
    const o = CFG.def;
    if (!FB || S.ejemplo) { if (aviso) alert('Con datos de ejemplo la lista del equipo no se publica.'); return { ok: false, error: 'datos de ejemplo' }; }
    await cargarRespuestas(); calcular();
    const items = listaFaltantes();
    $('suPub').textContent = 'Publicando la lista del equipo…';
    try {
      // Firebase solo acepta objetos creados en la ventana principal: se copian allá antes de guardar
      const datos = { items, corte: S.P.corte, publicado: new Date().toISOString(), C: o.C, Sg: o.Sg, fte: o.fte, tipos: o.tipos,
        meses: S.P.meses.slice(-24), fm: Array.from({ length: 12 }, (_, i) => sumaMes(S.P.fm[0], i)) };
      await FB.setDoc(FB.doc(FB.db, 'faltantes', 'actual'), window.parent.JSON.parse(JSON.stringify(datos)));
      $('suPub').textContent = `Lista del equipo (0 en droguería): ${nf0.format(items.length)} productos · para ${o.C} + ${o.Sg} días · publicada a las ${new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}`;
      S.suAuto = true;
      const at = await publicarAtencion();
      const rd = await publicarRed(items);
      if (!rd.ok) $('suPub').textContent += ' · no se pudo publicar la información de la red: ' + rd.error;
      if (!at.ok) $('suPub').textContent += ' · no se pudo publicar lo de cada sucursal: ' + at.error;
      return { ok: true, n: items.length };
    } catch (e) {
      const t = e.code === 'permission-denied' ? 'falta publicar las reglas nuevas (firestore.rules) en Firebase.' : e.message;
      $('suPub').textContent = 'No se pudo publicar la lista del equipo: ' + t; S.suAuto = false;
      return { ok: false, error: t };
    }
  }
  // el stock que tiene la sucursal de los medicamentos que droguería indicó en lugar de este (y cuántos días le cubren)
  function altEn(c, f) {
    const e = S.suEstados.get(c), al = e && !vencida(e) && ['alternativa', 'descontinuado'].includes(e.estado) ? e.alternativas || [] : [];
    if (!al.length) return {};
    return { alt: al.map(a => { const st = stockEn(a.c, f), q = prodDe(a.c), d = q ? diaria(q, f, cfgDe(f, a.c)).d : 0;
      return { c: a.c, n: a.n, st: Math.round(st * 1000) / 1000, cob: d > 0 ? Math.floor(st / d) : null }; }) };
  }
  // Lo que se le va a atender a cada sucursal (atencion/{SUCURSAL}): lo lee el químico de esa sucursal si tiene la vista.
  async function publicarAtencion() {
    const r3 = v => Math.round(v * 1000) / 1000, hoy = new Date().toISOString();
    try {
      for (const f of S.P.farmacias) {
        const items = cache.filas.filter(r => r.f === f && (r.pide > 0 || r.urgente)).sort((a, b) => (b.urgente - a.urgente) || a.cob - b.cob || b.pide - a.pide).slice(0, 2500)
          .map(r => {
            // información del producto en esta sucursal para el botón ⓘ: su venta de 12 meses, pronóstico y patrón
            const m = motorEn(r.p, f), hv = (m.hv || []).slice(-24).map(v => r3(v || 0)), x = clas(r.p), av = avance(r.p, f);
            return { c: r.p.c, n: r.p.n, l: labDe(r.p.c) || '', cat: r.cat, fr: r.p.fr || 1, d: r3(r.d), st: r3(r.st), nec: r3(r.nec), cob: isFinite(r.cob) ? Math.floor(r.cob) : null,
              pide: r.pide, drog: r.drog || 0, falta: r.falta || 0, urg: !!r.urgente, ...(r.aj ? { aj: ajTxt(r.aj) } : {}), ...(r.cambio ? { cmb: r.cambio } : {}), ...(r.reemp ? { rmp: r.reemp } : {}), ...(r.enLugar ? { enl: r.enLugar } : {}),
              ...altEn(r.p.c, f),
              ...(r.desde?.length ? { de: r.desde.map(([g, q]) => ({ f: nomSuc(g), q })) } : {}), ...(r.comprar ? { cmp: r.comprar } : {}),
              hv, pr: m.f12.map(r3), ...(av ? { av: r3(av.v) } : {}), met: m.metodo, pat: m.fp?.patron || '', adi: m.fp?.adi != null ? r3(m.fp.adi) : null, cv2: m.fp?.cv2 != null ? r3(m.fp.cv2) : null,
              li: x.t || '', ge: x.g || '', fa: x.f || '', k: r3(r.p.k || 0), vd: r.metodo };
          });
        // un documento de Firestore admite hasta 1 MB
        while (items.length && JSON.stringify(items).length > 880000) items.pop();
        const o = cfgSuc(f), datos = { suc: f, nombre: nomSuc(f), items, corte: S.P.corte, publicado: hoy, C: o.C, Sg: o.Sg, fte: o.fte, tipos: o.tipos, propio: !!CFG.suc[f],
          meses: (S.P.hfm || []).slice(-24), fm: Array.from({ length: 12 }, (_, i) => sumaMes(S.P.fm[0], i)), avDia: S.P.dias ? +S.P.dias.hasta.slice(8, 10) : null };
        await FB.setDoc(FB.doc(FB.db, 'atencion', f), window.parent.JSON.parse(JSON.stringify(datos)));
        // stock y venta diaria de todo lo de esta sucursal (red/stk_SUCURSAL): para ver al responder cuánto tiene del medicamento de cambio
        const stk = {}; for (const r of cache.filas) if (r.f === f && (r.st > 0 || r.d > 0)) stk[r.p.c] = [r3(r.st), r3(r.d)];
        await FB.setDoc(FB.doc(FB.db, 'red', 'stk_' + f), window.parent.JSON.parse(JSON.stringify({ p: stk, publicado: hoy })));
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.code === 'permission-denied' ? 'falta publicar las reglas nuevas (firestore.rules) en Firebase.' : e.message }; }
  }
  // El producto en toda la red (red/p0, p1…): stock, venta y envío de cada sucursal y el stock de droguería, para el
  // ojito de "Lo que me van a atender" y de Faltantes. Solo los productos que están en alguna de esas listas.
  async function publicarRed(faltantes) {
    const r3 = v => Math.round(v * 1000) / 1000, cods = new Set(faltantes.map(i => i.c));
    for (const r of cache.filas) if (r.pide > 0 || r.urgente) cods.add(r.p.c);
    const trozos = [{}]; let tam = 0;
    for (const c of cods) {
      const x = cache.porProd.get(c); if (!x) continue;
      const v = { dg: r3(x.drog || 0), r: x.red.map(r => ({ f: nomSuc(r.f), t: r.cat, d: r3(r.d), s: r3(r.st), n: r3(r.nec), e: r.pide || 0, g: r.drog || 0, x: r.exceso || 0 })) };
      const t = JSON.stringify(v).length + c.length + 4;
      if (tam + t > 850000) { trozos.push({}); tam = 0; }
      trozos[trozos.length - 1][c] = v; tam += t;
    }
    try {
      for (let i = 0; i < trozos.length; i++) await FB.setDoc(FB.doc(FB.db, 'red', 'p' + i), window.parent.JSON.parse(JSON.stringify({ p: trozos[i] })));
      await FB.setDoc(FB.doc(FB.db, 'red', 'meta'), window.parent.JSON.parse(JSON.stringify({ n: trozos.length, publicado: new Date().toISOString(), corte: S.P.corte })));
      return { ok: true };
    } catch (e) { return { ok: false, error: e.code === 'permission-denied' ? 'falta publicar las reglas nuevas (firestore.rules) en Firebase.' : e.message }; }
  }
  $('suPubBtn').addEventListener('click', () => publicar(true));
  // La página principal (Faltantes de droguería) la llama para generar la lista sin abrir este módulo:
  // espera a que estén cargados los datos, calcula con los parámetros por defecto y publica.
  window.publicarFaltantes = async () => {
    for (let i = 0; i < 240 && !(S.P && S.db && !S.ejemplo); i++) await new Promise(r => setTimeout(r, 500));
    if (!S.P || S.ejemplo) return { ok: false, error: 'los datos de la proyección no terminaron de cargar' };
    await cargarCfg(); for (let i = 0; i < 40 && !cfgListo; i++) await new Promise(r => setTimeout(r, 250));
    calcular(); return publicar(false);
  };

  window.pintarSuc = function () {
    llenarLabs(); llenarClas();
    cargarCfg(); pintarControles();
    const o = cfgSuc(S.suFarm), { filas } = calcular();
    escucharEstados();
    // la primera vez que se abre en la sesión (ya con los criterios cargados) se publica lo de las sucursales
    if (cfgListo && !S.suAuto && !S.suPublicando && FB && S.db && !S.ejemplo) { S.suPublicando = true; publicar().finally(() => S.suPublicando = false); }
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
      `<button type="button" class="su-chip" data-farm="${esc(f)}" aria-pressed="${S.suFarm === f}"><b>${esc(corto2(f))}${CFG.suc[f] ? ' <em class="su-propio">criterio propio</em>' : ''}</b><span>${nf0.format(x.n)} prod. · ${nf0.format(x.cj)} cj · ${soles2(x.v)}</span>${x.u ? `<i>${x.u} urgentes</i>` : ''}</button>`).join('')
      || '<span class="z">Ninguna sucursal necesita envíos con estos parámetros.</span>';
    // al buscar se muestran todas las coincidencias de la sucursal, aunque no tengan venta ni stock ni pasen "Mostrar"
    const q = val('suq').trim();
    const deBusqueda = () => {
      const prods = filtroTexto(S.P.p.filter(p => (!S.lab || labDe(p.c) === S.lab) && pasaClas(p)), q).slice(0, 300), out = [];
      for (const p of prods) { const red = redDe(p).red; for (const f of S.suFarm ? [S.suFarm] : S.P.farmacias) { let r = red.find(x => x.f === f); if (!r && S.suFarm) r = filaBase(p, f); if (r) out.push(r); } }
      return out;
    };
    const lista = (q ? deBusqueda() : base.filter(r => S.suVer !== 'ajuste' ? VER[S.suVer](r) : !!r.aj)).map(r => Object.assign(r, { c: r.p.c, n: r.p.n }))
      .sort((a, b) => S.suVer === 'exceso' ? b.exceso * (b.p.k || 0) - a.exceso * (a.p.k || 0) : (b.urgente - a.urgente) || a.cob - b.cob || b.pide - a.pide);
    const vis = lista.slice(0, S.suMostrar), todas = !S.suFarm;
    $('suTitulo').textContent = todas ? 'Todas las sucursales' : corto2(S.suFarm);
    $('suEyebrow').textContent = (todas ? 'Cada sucursal con su criterio · general: ' : '') + `atender para ${o.C} días + ${o.Sg} de seguridad · venta diaria: ${o.fte === 'motor' ? 'motor estadístico' : `ventas de los últimos ${o.fte} días`} · ${o.tipos === 'todos' ? 'todos los productos con venta' : 'tipo A completo, tipo B 1 unidad si no le alcanza'}`;
    $('suH2').textContent = q ? `Búsqueda "${q}" en ${todas ? 'todas las sucursales' : corto2(S.suFarm)} (sin filtro Mostrar)` : { enviar: 'Enviar', urgente: 'Urgentes: menos stock que los días de seguridad', comprar: 'No alcanza lo de droguería', exceso: 'Exceso en la sucursal', ajuste: 'Productos con ajuste propio', '': 'Todos' }[S.suVer];
    let h = `<thead><tr><th class="c0">Código</th><th class="c1">Producto</th>${todas ? '<th style="text-align:left">Sucursal</th>' : ''}<th>Tipo</th><th title="Días que alcanza el stock de la sucursal">Cobertura</th>
      <th>Venta diaria</th><th>Stock sucursal</th><th title="Venta diaria × (días + seguridad)">Necesita</th><th class="sep">Enviar</th><th title="Lo que se puede mandar desde droguería">De droguería</th><th style="text-align:left">Lo que falta</th><th>Valor</th></tr></thead><tbody>`;
    for (const r of vis) {
      const p = r.p, sel = S.suCur === p.c + '|' + r.f ? ' sel' : '';
      const falta = r.falta > 0 ? [...(r.desde || []).map(([f, q]) => `${nf0.format(q)} de ${esc(corto2(f))}`), r.comprar ? `<span class="neg">${nf0.format(r.comprar)} comprar</span>` : ''].filter(Boolean).join(' · ') + tagEstado(p.c) : '';
      h += `<tr class="click${sel}" data-cod="${esc(p.c)}" data-f="${esc(r.f)}"><td class="c0">${esc(p.c)}</td><td class="c1" title="${esc(p.n)}">${esc(p.n)}${etiquetas(p)}<small class="sub">${esc(labDe(p.c))}${r.nota ? ' · ' + esc(r.nota) : ''}${r.aj ? ` · <span class="su-aj" title="${esc(ajTxt(r.aj))}">✎ ${esc(ajTxt(r.aj))}</span>` : ''}${tagResp(r.f, p.c)}</small></td>
        ${todas ? `<td>${esc(corto2(r.f))}</td>` : ''}<td style="text-align:center">${catBadge(r.cat)}</td>
        <td class="su-cob" style="background:${colorCob(r)}">${cobTxt(r)}</td><td class="n">${fmtE(p, r.d)}</td><td class="n">${fmtS(p, r.st)}</td><td class="n">${fmtE(p, r.nec)}</td>
        <td class="n sep tot ent">${r.pide ? nf0.format(r.pide) : r.exceso ? `<span class="tag">sobra ${nf0.format(r.exceso)}</span>` : '·'}</td><td class="n">${r.pide ? nf0.format(r.drog || 0) : ''}</td><td>${falta}</td>
        <td class="n">${r.pide ? soles2(r.pide * (p.k || 0)) : r.exceso ? soles2(r.exceso * (p.k || 0)) : ''}</td></tr>`;
    }
    if (!vis.length) h += `<tr><td class="c0"></td><td class="c1" colspan="${todas ? 11 : 10}">Nada que mostrar con estos filtros.</td></tr>`;
    $('suTabla').innerHTML = h + '</tbody>'; ajustarC0($('suTabla'));
    $('suMore').innerHTML = `<span>Mostrando ${nf0.format(vis.length)} de ${nf0.format(lista.length)} · clic en uno para ver su detalle</span>` +
      (lista.length > vis.length ? `<button class="btn" id="suMas">Ver ${Math.min(PAGINA, lista.length - vis.length)} más</button>` : '');
    if ($('suMas')) $('suMas').onclick = () => { S.suMostrar += PAGINA; window.pintarSuc(); };
    S.suLista = lista;
    pintarMasivo();
    pintarDetalle(o);
  };

  /* ---------- detalle: el producto en la sucursal y en toda la red ---------- */
  function pintarDetalle(o) {
    const [c, f] = (S.suCur || '').split('|'), p = c && S.idx.get(c), box = $('suDet');
    const red = p && redDe(p);
    box.hidden = !red; if (!red) return;
    const r = red.red.find(x => x.f === f) || filaBase(p, f);
    $('suDTit').textContent = p.n;
    pintarAjuste(p, r);
    $('suDSub').innerHTML = `Código <code>${esc(p.c)}</code> · ${esc(labDe(p.c) || 'sin laboratorio')} · <b>${esc(corto2(r.f))}</b> · venta diaria según ${esc(r.metodo)}${S.suEstados.get(p.c) ? ' · ' + tagEstado(p.c) : ''}`;
    const hv = S.P.hfm && p.hf?.[r.f] ? p.hf[r.f] : [], hm = (S.P.hfm || []).slice(-hv.length), n = Math.min(24, hv.length);
    const fut = motor.get(p.c + '|' + r.f)?.f || [];
    dibujar('suChart', { type: 'line', data: { labels: [...hm.slice(-n), ...S.P.fm.slice(0, fut.length)].map(et), datasets: [
      { label: `Venta en ${corto2(r.f)}`, data: [...hv.slice(-n), ...fut.map(() => null)], borderColor: '#7cb342', backgroundColor: '#7cb342', tension: .15, pointRadius: 2 },
      ...(fut.length ? [{ label: 'Pronóstico', data: [...hv.slice(-n).map(() => null), ...fut], borderColor: '#e53935', backgroundColor: '#e53935', tension: .15, pointRadius: 2 }] : [])
    ] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'right' } }, scales: { y: { beginAtZero: true } } } });
    const filas = [...(red.red.includes(r) ? red.red : [r, ...red.red])].sort((a, b) => (a.f === r.f ? -1 : b.f === r.f ? 1 : a.cob - b.cob));
    $('suRed').innerHTML = `<thead><tr><th class="c1 solo">Sucursal</th><th>Tipo</th><th>Venta diaria</th><th>Stock</th><th>Cobertura</th><th>Necesita</th><th>Enviar</th><th>De droguería</th><th>Sobra</th></tr></thead><tbody>
      <tr class="tot"><td class="c1 solo"><b>Droguería FS</b></td><td></td><td></td><td class="n"><b>${fmtS(p, red.drog)}</b></td><td></td><td></td><td></td><td></td><td></td></tr>` +
      filas.map(x => `<tr${x.f === r.f ? ' class="sel"' : ''}><td class="c1 solo">${esc(corto2(x.f))}</td><td style="text-align:center">${catBadge(x.cat)}</td><td class="n">${fmtE(p, x.d)}</td><td class="n">${fmtS(p, x.st)}</td>
        <td class="su-cob" style="background:${colorCob(x)}">${cobTxt(x)}</td><td class="n">${fmtE(p, x.nec)}</td><td class="n big">${x.pide ? nf0.format(x.pide) : '·'}</td><td class="n">${x.pide ? nf0.format(x.drog || 0) : ''}</td><td class="n">${x.exceso ? nf0.format(x.exceso) : ''}</td></tr>`).join('') + '</tbody>';
  }

  // ajuste de un producto: fuente de la venta diaria, días y si se atiende, en esa sucursal o en todas
  function pintarAjuste(p, r) {
    const a = CFG.prod[r.f]?.[p.c] || CFG.prod['*']?.[p.c] || {}, donde = CFG.prod[r.f]?.[p.c] ? r.f : CFG.prod['*']?.[p.c] ? '*' : r.f, base = cfgSuc(r.f);
    const op = (v, t, sel) => `<option value="${v}" ${sel === v ? 'selected' : ''}>${t}</option>`;
    $('suAj').innerHTML = `<div class="est-grid">
      <label>Aplica a</label><div><select id="ajDonde">${op(r.f, 'Solo en ' + esc(nomSuc(r.f)), donde)}${op('*', 'Todas las sucursales', donde)}</select></div>
      <label>Venta diaria según</label><div><select id="ajFte">${op('', `Igual que la sucursal (${esc(fteTxt(base.fte))})`, a.fte || '')}${['15', '30', '60', '90'].map(n => op(n, `Ventas de los últimos ${n} días`, a.fte)).join('')}${op('motor', 'Motor estadístico (pronóstico de la sucursal)', a.fte)}</select></div>
      <label>Días a atender</label><div><input class="est-in" id="ajC" type="number" min="1" max="180" placeholder="${base.C}" value="${a.C ?? ''}"> + <input class="est-in" id="ajSg" type="number" min="0" max="180" placeholder="${base.Sg}" value="${a.Sg ?? ''}"> días de seguridad</div>
      <label>Atender</label><div><select id="ajModo">${op('', 'Según su tipo (A, B…)', a.modo || '')}${op('forzar', 'Siempre que le falte', a.modo)}${op('excluir', 'No atender', a.modo)}</select></div>
    </div>
    <div class="est-bot" style="padding:0 12px 12px"><button type="button" class="btn sm primary" id="ajGuardar">Guardar ajuste</button>${CFG.prod[r.f]?.[p.c] || CFG.prod['*']?.[p.c] ? '<button type="button" class="btn sm" id="ajQuitar">Quitar ajuste</button>' : ''}
      <small class="z">Ahora: venta diaria ${fmtE(p, r.d)} (${esc(r.metodo)}) · necesita ${fmtE(p, r.nec)} · enviar ${nf0.format(r.pide)}</small></div>`;
  }
  $('suAj').addEventListener('click', e => {
    const [c, f] = (S.suCur || '').split('|'); if (!c) return;
    if (e.target.closest('#ajQuitar')) { for (const k of [f, '*']) if (CFG.prod[k]) { delete CFG.prod[k][c]; if (!Object.keys(CFG.prod[k]).length) delete CFG.prod[k]; } guardarCfg(); return window.pintarSuc(); }
    if (!e.target.closest('#ajGuardar')) return;
    if (!puedeEditar()) return;
    const n = id => val(id) === '' ? undefined : Math.max(0, +val(id));
    const a = { fte: val('ajFte') || undefined, C: n('ajC'), Sg: n('ajSg'), modo: val('ajModo') || undefined };
    Object.keys(a).forEach(k => a[k] === undefined && delete a[k]);
    for (const k of [f, '*']) if (CFG.prod[k]) delete CFG.prod[k][c];
    const donde = val('ajDonde');
    if (Object.keys(a).length) (CFG.prod[donde] ??= {})[c] = a;
    for (const k of Object.keys(CFG.prod)) if (!Object.keys(CFG.prod[k]).length) delete CFG.prod[k];
    guardarCfg(); window.pintarSuc();
  });
  // ajuste de varios productos: el mismo ajuste a todos los productos de la lista que se ve (con sus filtros)
  function pintarMasivo() {
    const box = $('suMasivo'); box.hidden = !S.suMasivo; if (!S.suMasivo) return;
    const cods = [...new Set((S.suLista || []).map(r => r.p.c))], donde = S.suFarm || '*', base = cfgSuc(S.suFarm);
    const op = (v, t) => `<option value="${v}">${t}</option>`;
    box.innerHTML = `<h3>Ajustar varios productos a la vez</h3>
      <p>Se aplica a los <b>${nf0.format(cods.length)} productos de la lista de abajo</b> (usa los filtros de arriba: Mostrar, laboratorio, línea, familia o la búsqueda) en <b>${S.suFarm ? esc(nomSuc(S.suFarm)) : 'todas las sucursales'}</b>.
        Los demás productos siguen con el criterio de la sucursal.</p>
      <div class="est-grid">
        <label>Venta diaria según</label><div><select id="maFte">${op('', `Igual que la sucursal (${esc(fteTxt(base.fte))})`)}${['15', '30', '60', '90'].map(n => op(n, `Ventas de los últimos ${n} días`)).join('')}${op('motor', 'Motor estadístico')}</select></div>
        <label>Días a atender</label><div><input class="est-in" id="maC" type="number" min="1" max="180" placeholder="${base.C}"> + <input class="est-in" id="maSg" type="number" min="0" max="180" placeholder="${base.Sg}"> días de seguridad</div>
        <label>Atender</label><div><select id="maModo">${op('', 'Según su tipo (A, B…)')}${op('forzar', 'Siempre que le falte')}${op('excluir', 'No atender')}</select></div>
      </div>
      <div class="est-bot" style="padding:0 12px 12px"><button type="button" class="btn sm primary" id="maAplicar" ${cods.length ? '' : 'disabled'}>Aplicar a ${nf0.format(cods.length)} productos</button>
        <button type="button" class="btn sm" id="maQuitar" ${cods.length ? '' : 'disabled'}>Quitar el ajuste a estos ${nf0.format(cods.length)}</button><button type="button" class="btn sm" id="maCerrar">Cerrar</button></div>`;
    box.dataset.donde = donde;
  }
  $('suMasivo').addEventListener('click', e => {
    if (e.target.closest('#maCerrar')) { S.suMasivo = false; return pintarMasivo(); }
    const aplicar = e.target.closest('#maAplicar'), quitar = e.target.closest('#maQuitar'); if (!aplicar && !quitar) return;
    if (!puedeEditar()) return;
    const cods = [...new Set((S.suLista || []).map(r => r.p.c))], donde = $('suMasivo').dataset.donde;
    const n = id => val(id) === '' ? undefined : Math.max(0, +val(id));
    const a = { fte: val('maFte') || undefined, C: n('maC'), Sg: n('maSg'), modo: val('maModo') || undefined };
    Object.keys(a).forEach(k => a[k] === undefined && delete a[k]);
    if (aplicar && !Object.keys(a).length) return alert('Elige al menos un cambio (venta diaria, días o atender).');
    if (!confirm(aplicar ? `¿Aplicar este ajuste a ${cods.length} productos en ${donde === '*' ? 'todas las sucursales' : nomSuc(donde)}?` : `¿Quitar el ajuste a ${cods.length} productos en ${donde === '*' ? 'todas las sucursales' : nomSuc(donde)}?`)) return;
    for (const c of cods) { if (aplicar) (CFG.prod[donde] ??= {})[c] = { ...a }; else if (CFG.prod[donde]) delete CFG.prod[donde][c]; }
    for (const k of Object.keys(CFG.prod)) if (!Object.keys(CFG.prod[k]).length) delete CFG.prod[k];
    S.suMasivo = false; guardarCfg(); otra();
  });
  $('suCrit').addEventListener('click', e => {
    if (e.target.closest('#suMasivoBtn')) { S.suMasivo = !S.suMasivo; pintarMasivo(); return $('suMasivo').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    if (e.target.closest('#suGeneral') && S.suFarm) { delete CFG.suc[S.suFarm]; guardarCfg(); return otra(); }
    const bs = e.target.closest('[data-suc]'); if (bs) { S.suFarm = bs.dataset.suc; return otra(); }
    // ver la lista de productos con ajuste, o abrir uno
    if (e.target.closest('#suVerAj')) { S.suVer = 'ajuste'; $('suq').value = ''; otra(); return $('suTabla').closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    const b = e.target.closest('[data-aj]'); if (!b) return;
    const c = b.dataset.aj, f = S.suFarm || (b.dataset.f !== '*' ? b.dataset.f : S.P.farmacias[0]);
    S.suCur = c + '|' + f; window.pintarSuc(); $('suDet').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

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
  $('suPres').addEventListener('click', e => { const b = e.target.closest('[data-d]'); if (!b) return; $('suCob').value = b.dataset.d; $('suSeg').value = b.dataset.s; marcarPres(); leerControles(); otra(); });
  const marcarPres = () => document.querySelectorAll('#suPres [data-d]').forEach(b => b.setAttribute('aria-pressed', b.dataset.d === val('suCob') && b.dataset.s === val('suSeg')));
  ['suCob', 'suSeg', 'suFte', 'suTip'].forEach(id => $(id).addEventListener('change', () => { marcarPres(); leerControles(); otra(); }));
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
