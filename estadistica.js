/* Estadística Proyx: planificación de inventario con la misma estructura que la pantalla "Inventory planning" de frePPLe.
   Lista de productos con su estado de inventario y, para el producto elegido, las pestañas Atributos, Pronóstico, Plan
   y Pedidos propuestos. Pronóstico: motor portado de frePPLe (frepple.js). Usa las variables y ayudas de proyeccion.html.
   Los ajustes por producto (método, correcciones del pronóstico, parámetros) se guardan en proy_config/estadistica. */
(function () {
  S.frVer = 'ahora'; S.frMostrar = PAGINA; S.estCur = null; S.estTab = 'atr';
  const EST = { cfg: null, cargando: false, edit: {} };   // cfg.p[cod] = ajustes guardados; edit[cod] = sin guardar
  const PATRON = { smooth: 'Suave', erratic: 'Errático', intermittent: 'Intermitente', lumpy: 'Irregular' };
  const METODO_OP = [['', 'Automático'], ['media', 'Media móvil'], ['constante', 'Constante'], ['tendencia', 'Tendencia'], ['estacional', 'Estacional'], ['intermitente', 'Intermitente (Croston)']];
  const N_FUT = 12, VENTANA = 6;   // 12 meses de pronóstico; demanda promedio de 6 meses (frePPLe: 180 días)
  const addM = (m, k) => { let [y, mo] = m.split('-').map(Number); mo += k; while (mo > 12) { mo -= 12; y++; } while (mo < 1) { mo += 12; y--; } return `${y}-${String(mo).padStart(2, '0')}`; };
  const soles2 = v => 'S/ ' + nf0.format(Math.round(v || 0));
  const num = v => v === '' || v == null || !isFinite(+v) ? null : +v;

  /* ---------- ajustes guardados ---------- */
  async function cargar() {
    if (EST.cfg || EST.cargando) return;
    if (!S.db || S.ejemplo) { EST.cfg = { p: {} }; return; }
    EST.cargando = true;
    try { const d = await S.db.doc('config/estadistica').get(); EST.cfg = d.exists ? d.data() : { p: {} }; EST.cfg.p ??= {}; }
    catch (e) { console.warn(e); EST.cfg = { p: {} }; }
    EST.cargando = false; cache = new Map(); window.pintarEst();
  }
  const ajustes = c => EST.edit[c] || EST.cfg?.p?.[c] || {};
  async function guardar(c) {
    const a = EST.edit[c]; if (!a) return;
    const limpio = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null && v !== '' && v !== undefined && !(typeof v === 'object' && !Object.keys(v).length)));
    if (Object.keys(limpio).length) EST.cfg.p[c] = limpio; else delete EST.cfg.p[c];
    delete EST.edit[c];
    if (S.db && !S.ejemplo) {
      try { await S.db.doc('config/estadistica').set(EST.cfg); toast('Ajustes guardados'); }
      catch (e) { toast('No se pudo guardar: ' + (e.message || e)); }
    } else toast('Datos de ejemplo: los ajustes no se guardan');
  }
  const toast = t => { const el = $('toast'); if (!el) return; el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 3000); };

  /* ---------- distribución de la demanda en el tiempo de entrega ---------- */
  const fiN = x => { const t = 1 / (1 + .2316419 * Math.abs(x)), d = .3989423 * Math.exp(-x * x / 2), p = d * t * (.3193815 + t * (-.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x >= 0 ? 1 - p : p; };
  function zDe(p) {
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239],
      b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572],
      c = [-.007784894002430293, -.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
      d = [.007784695709041462, .3224671290700398, 2.445134137142996, 3.754408661907416];
    if (p < .02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - .02425) return -zDe(1 - p);
    const q = p - .5, r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function distribucion(mu, v) {
    if (mu >= 20) { const sd = Math.sqrt(Math.max(v, mu)); return { tipo: 'Normal', q: sl => mu + zDe(sl) * sd, cola: x => 1 - fiN((x - mu) / sd) }; }
    let pmf0, sig;
    if (v <= mu * 1.1) { pmf0 = Math.exp(-mu); sig = (k, pk) => pk * mu / (k + 1); }
    else { const r = mu * mu / (v - mu), pr = r / (r + mu); pmf0 = Math.pow(pr, r); sig = (k, pk) => pk * (k + r) / (k + 1) * (1 - pr); }
    const cdf = x => { let c = 0, pk = pmf0; for (let k = 0; k <= x && k < 5000; k++) { c += pk; pk = sig(k, pk); } return Math.min(1, c); };
    return { tipo: v <= mu * 1.1 ? 'Poisson' : 'Binomial negativa',
      q: sl => { let c = 0, pk = pmf0, k = 0; for (; k < 5000; k++) { c += pk; if (c >= sl) break; pk = sig(k, pk); } return k; },
      cola: x => x < 0 ? 1 : 1 - cdf(Math.floor(x)) };
  }

  /* ---------- cálculo por producto ---------- */
  let cache = new Map(), cacheDe = null, cacheClave = '';
  function opciones() {
    return { LT: Math.max(1, +$('frLT').value || 7), SL: +$('frSL').value, fte: $('frFte').value, min: Math.max(0, +$('frROQmin').value || 0),
      max: Math.max(1, +$('frROQmax').value || 60), S: Math.max(0, +$('frS').value || 0), H: Math.max(0, +$('frH').value || 0) / 100 };
  }
  function calcular(p, o) {
    const a = ajustes(p.c), fm0 = S.P.fm[0], meses = Array.from({ length: N_FUT }, (_, i) => addM(fm0, i));
    const fp = window.FREPPLE.pronosticar(p.h, N_FUT, a.metodo || '');
    let base, sdMes, metodo, smape = fp.smape;
    if (o.fte === 'frepple' || a.metodo || a.over) { base = fp.f.slice(); sdMes = fp.sd; metodo = fp.metodo + (fp.forzado ? ' (elegido)' : ''); }
    else {
      const sel = elegido(p.c); if (!sel || !p.f[sel]) return null;
      base = meses.map((_, i) => p.f[sel][Math.min(i, p.f[sel].length - 1)] || 0); metodo = corto(sel); smape = null;
      const real = S.calc.get(p.c)?.real || [], b = p.b?.[sel] || [];
      const e = b.map((v, i) => v != null && real[i] != null ? v - real[i] : null).filter(v => v != null);
      sdMes = e.length ? Math.sqrt(e.reduce((s, x) => s + x * x, 0) / e.length) : Math.sqrt(base[0] || 0);
    }
    const pron = base.map((v, i) => a.over?.[meses[i]] ?? v);
    const prom = pron.slice(0, VENTANA).reduce((s, v) => s + v, 0) / VENTANA, diaria = prom / 30;
    const st = stockTotal(p), pos = st.t, costo = p.k || 0;
    const LT = a.lt ?? o.LT, SL = (a.sl ?? o.SL * 100) / 100, sdD = a.sdD ?? sdMes, sdLT = a.sdLT ?? 0;
    const r = { p, a, meses, base, pron, fp, metodo, smape, patron: PATRON[fp.patron] || '', diaria, prom, costo, pos, sd_: st.d, LT, SL, sdD, sdLT, sdMesCalc: sdMes };
    if (!(diaria > 0)) return Object.assign(r, { sinDemanda: true, ss: 0, rop: 0, roq: 0, pedir: 0, enDias: Infinity, riesgo: 0, estado: pos > 0 ? 1 : 0, exceso: pos > 0, plan: plan(r, 0, 0, 0) });
    // demanda en el tiempo de entrega: media y varianza (con la desviación del tiempo de entrega, si se indica)
    const mu = diaria * LT, v = sdD * sdD * LT / 30 + diaria * diaria * sdLT * sdLT;
    const u = p.fr > 1 ? p.fr : 1, dist = distribucion(mu * u, v * u * u);
    let ss = Math.max(0, dist.q(SL) / u - mu);
    // límites del stock de seguridad (cantidad y días de cobertura)
    if (a.ssQmin != null) ss = Math.max(ss, a.ssQmin); if (a.ssDmin != null) ss = Math.max(ss, diaria * a.ssDmin);
    if (a.ssQmax != null) ss = Math.min(ss, a.ssQmax); if (a.ssDmax != null) ss = Math.min(ss, diaria * a.ssDmax);
    // cantidad a pedir: EOQ limitada por cantidad y días de cobertura
    const eoq = costo > 0 && o.H > 0 ? Math.sqrt(2 * diaria * 365 * o.S / (o.H * costo)) : 0;
    let roq = Math.max(eoq, diaria * (a.roqDmin ?? o.min));
    roq = Math.min(roq, diaria * (a.roqDmax ?? o.max));
    if (a.roqQmin != null) roq = Math.max(roq, a.roqQmin); if (a.roqQmax != null) roq = Math.min(roq, a.roqQmax);
    roq = Math.max(1, roq);
    if (a.noStock) { ss = 0; roq = 1; }
    const rop = mu + ss, riesgo = dist.cola(pos * u);
    const pedir = pos <= rop ? Math.ceil(rop + roq - pos - 1e-9) : 0, enDias = pos > rop ? (pos - rop) / diaria : 0;
    // estado del inventario (como frePPLe): el menor entre el stock de hoy y el esperado al llegar un pedido, frente a seguridad + pedido
    const posLT = pos - mu, estado = Math.max(0, Math.min(1, Math.min(pos, posLT) / (ss + roq)));
    return Object.assign(r, { mu, sd: Math.sqrt(v), dist: dist.tipo, ss, eoq, roq, rop, riesgo, pedir, enDias, posLT, estado,
      exceso: pos > rop + 3 * roq, plan: plan(r, ss, roq, rop) });
  }
  // plan mes a mes: stock inicial, demanda, pedido propuesto y stock final (se pide hasta ROP + ROQ al llegar al ROP)
  function plan(r, ss, roq, rop) {
    const filas = []; let ini = r.pos; const corte = new Date(S.P.corte + 'T12:00:00');
    r.meses.forEach((m, i) => {
      const dem = r.pron[i] || 0, [y, mo] = m.split('-').map(Number), dim = new Date(y, mo, 0).getDate();
      const desde = i === 0 ? corte.getDate() : 1, diasMes = dim - desde + 1, demMes = i === 0 ? dem * diasMes / dim : dem;
      let sum = 0, fecha = null;
      if (rop > 0 && ini - demMes < rop) {
        sum = Math.ceil(rop + roq - (ini - demMes) - 1e-9);
        const diaria = demMes / diasMes || 1e-9, dPed = Math.max(0, Math.min(diasMes - 1, Math.floor((ini - rop) / diaria)));
        fecha = new Date(y, mo - 1, desde + dPed);
      }
      const fin = ini - demMes + sum;
      filas.push({ m, roq, ss, ini, dem: demMes, sum, fin, fecha, llega: fecha ? new Date(+fecha + r.LT * 864e5) : null });
      ini = Math.max(0, fin);
    });
    return filas;
  }
  function todos(o) {
    const clave = JSON.stringify(o) + '|' + Object.keys(EST.edit).length;
    if (cacheDe !== S.P || cacheClave !== clave) { cache = new Map(); cacheDe = S.P; cacheClave = clave; }
    const lista = [];
    for (const p of S.P.p) {
      let r = cache.get(p.c); if (r === undefined) { r = calcular(p, o); cache.set(p.c, r); }
      if (r && !r.sinDemanda) lista.push(r);
    }
    return lista;
  }

  /* ---------- lista ---------- */
  const frVal = { ahora: r => r.pedir > 0, semana: r => !r.pedir && r.enDias <= 7, riesgo: r => r.riesgo >= .5, exceso: r => r.exceso, '': () => true };
  const colorEstado = e => e >= 1 ? '#1a7f37' : e >= .8 ? '#5cb85c' : e >= .5 ? '#f0ad4e' : e >= .2 ? '#f0703a' : '#d9302c';
  const celdaEstado = e => `<td class="estado-inv" style="background:${colorEstado(e)}">${nf0.format(e * 100)} %</td>`;
  const fechaC = d => d ? d.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit' }) : '';
  window.pintarEst = function () {
    cargar(); llenarLabs(); llenarClas();
    const o = opciones();
    $('frEyebrow').textContent = `Toda la empresa · al ${S.P.corte.split('-').reverse().join('/')} · entrega en ${o.LT} días · nivel de servicio ${pct(o.SL)} · pronóstico: ${o.fte === 'frepple' ? 'motor estadístico' : 'el elegido en Pronóstico'}`;
    const base = todos(o).filter(r => (!S.lab || labDe(r.p.c) === S.lab) && pasaClas(r.p) && !bloqueado(r.p.c, 'TODAS'));
    const ahora = base.filter(frVal.ahora), exc = base.filter(frVal.exceso);
    $('frk1').textContent = nf0.format(ahora.length); $('frk1s').textContent = `${soles2(ahora.reduce((s, r) => s + r.pedir * r.costo, 0))} a pedir`;
    $('frk2').textContent = nf0.format(base.filter(frVal.semana).length); $('frk3').textContent = nf0.format(base.filter(frVal.riesgo).length);
    $('frk4').textContent = nf0.format(exc.length); $('frk4s').textContent = `${soles2(exc.reduce((s, r) => s + Math.max(0, r.pos - r.rop - r.roq) * r.costo, 0))} de más`;
    document.querySelectorAll('#frCards [data-ver]').forEach(b => b.setAttribute('aria-pressed', b.dataset.ver === S.frVer));
    $('frVer').value = S.frVer;
    const lista = filtroTexto(base.filter(frVal[S.frVer]).map(r => Object.assign(r, { c: r.p.c, n: r.p.n })), $('frq').value)
      .sort((a, b) => S.frVer === 'exceso' ? (b.pos - b.rop - b.roq) * b.costo - (a.pos - a.rop - a.roq) * a.costo
        : a.estado - b.estado || b.pedir * b.costo - a.pedir * a.costo);
    const vis = lista.slice(0, S.frMostrar);
    $('frH2').textContent = { ahora: 'Pedir ahora', semana: 'Pedir en los próximos 7 días', riesgo: 'Riesgo de quiebre en el tiempo de entrega', exceso: 'Exceso de stock', '': 'Todos los productos con pronóstico' }[S.frVer];
    let h = `<thead><tr><th class="c0">Código</th><th class="c1">Producto</th><th title="Stock de hoy o al llegar un pedido (el menor), frente a seguridad + pedido">Estado inventario</th><th title="Tiempo de entrega (días)">Entrega</th><th title="Costo por caja">Costo</th>
      <th title="Pronóstico de este mes">Pronóst. mes</th><th class="sep" title="Stock de seguridad">Seguridad</th><th title="Punto de pedido">ROP</th><th title="Cantidad a pedir">ROQ</th>
      <th class="sep" title="Droguería + sucursales">Stock</th><th title="Probabilidad de quedarse sin stock antes de que llegue el pedido">Riesgo quiebre</th><th class="sep">Propuesto</th><th title="Propuesto × costo">Valor</th><th>Cuándo</th></tr></thead><tbody>`;
    for (const r of vis) {
      const p = r.p, sel = S.estCur === p.c ? ' sel' : '';
      h += `<tr class="click${sel}" data-cod="${esc(p.c)}"><td class="c0">${esc(p.c)}</td><td class="c1" title="${esc(p.n)}">${esc(p.n)}${etiquetas(p)}<small class="sub">${esc(labDe(p.c))} · ${esc(r.metodo)}${r.patron ? ' · ' + esc(r.patron) : ''}${EST.cfg?.p?.[p.c] ? ' · ✎ ajustado' : ''}</small></td>
        ${celdaEstado(r.estado)}<td class="n">${nf0.format(r.LT)} d</td><td class="n">${r.costo ? 'S/ ' + nf1.format(r.costo) : '–'}</td>
        <td class="n">${fmtE(p, r.pron[0])}</td><td class="n sep">${fmtE(p, r.ss)}</td><td class="n big">${fmtE(p, r.rop)}</td><td class="n">${fmtE(p, r.roq)}</td>
        <td class="n sep ${r.pos <= r.rop ? 'neg' : ''}">${fmtS(p, r.pos)}</td><td class="n ${r.riesgo >= .5 ? 'neg' : r.riesgo < .05 ? 'pos' : ''}">${pct(r.riesgo)}</td>
        <td class="n sep tot ent">${r.pedir ? nf0.format(r.pedir) : '·'}</td><td class="n">${r.pedir ? soles2(r.pedir * r.costo) : ''}</td>
        <td>${r.pedir ? '<span class="tag bloq">hoy</span>' : r.exceso ? '<span class="tag">exceso</span>' : r.enDias > 365 ? '> 1 año' : fechaC(new Date(new Date(S.P.corte + 'T12:00:00').getTime() + Math.floor(r.enDias) * 864e5)) + ` <small class="z">(${nf0.format(Math.floor(r.enDias))} d)</small>`}</td></tr>`;
    }
    if (!vis.length) h += `<tr><td class="c0"></td><td class="c1" colspan="13">Nada que mostrar con estos filtros.</td></tr>`;
    $('frTabla').innerHTML = h + '</tbody>'; ajustarC0($('frTabla'));
    $('frMore').innerHTML = `<span>Mostrando ${nf0.format(vis.length)} de ${nf0.format(lista.length)} productos · clic en uno para ver su detalle</span>` +
      (lista.length > vis.length ? `<button class="btn" id="frMas">Ver ${Math.min(PAGINA, lista.length - vis.length)} más</button>` : '');
    if ($('frMas')) $('frMas').onclick = () => { S.frMostrar += PAGINA; window.pintarEst(); };
    S.estLista = lista;
    pintarDetalle();
  };

  /* ---------- detalle del producto ---------- */
  function pintarDetalle() {
    const box = $('estDet'), p = S.estCur && S.idx.get(S.estCur);
    box.hidden = !p; if (!p) return;
    const o = opciones(); let r = cache.get(p.c); if (r === undefined) { r = calcular(p, o); cache.set(p.c, r); }
    if (!r) { box.hidden = true; return; }
    $('estTit').textContent = `${p.n}`;
    $('estSub').innerHTML = `Código <code>${esc(p.c)}</code> · ${esc(labDe(p.c) || 'sin laboratorio')} · toda la empresa${EST.edit[p.c] ? ' · <b class="neg">cambios sin guardar</b>' : EST.cfg?.p?.[p.c] ? ' · ✎ con ajustes guardados' : ''}`;
    document.querySelectorAll('#estTabs [data-t]').forEach(b => b.setAttribute('aria-selected', b.dataset.t === S.estTab));
    for (const t of ['atr', 'pron', 'plan', 'ped']) $('estP_' + t).hidden = S.estTab !== t;
    if (S.estTab === 'atr') pintarAtr(r); else if (S.estTab === 'pron') pintarPron(r); else if (S.estTab === 'plan') pintarPlan(r); else pintarPed(r);
  }
  const fila = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  function pintarAtr(r) {
    const p = r.p, x = clas(p), h = p.h || [], ult = n => h.slice(-n).reduce((s, v) => s + (v || 0), 0), conV = h.slice(-12).filter(v => v > 0).length;
    $('estAtrProd').innerHTML = [
      fila('Nombre', esc(p.n)), fila('Código', esc(p.c)), fila('Laboratorio', esc(labDe(p.c)) || '–'), fila('Línea', esc(x.t) || '–'), fila('Genérico', esc(x.g) || '–'), fila('Familia', esc(x.f) || '–'),
      fila('Costo por caja', r.costo ? 'S/ ' + nf1.format(r.costo) : '–'), fila('Tipo por movimiento', catBadge(p.cat)), fila('Patrón de la demanda', esc(r.patron) || '–'),
      fila('ADI (cada cuántos meses vende)', r.fp.adi != null ? nf1.format(r.fp.adi) : '–'), fila('CV² (variación de la cantidad)', r.fp.cv2 != null ? (Math.round(r.fp.cv2 * 1000) / 1000).toString() : '–'),
      fila('Venta últimos 6 meses', `${fmtE(p, ult(6))} cajas · ${soles2(ult(6) * r.costo)}`), fila('Venta últimos 12 meses', `${fmtE(p, ult(12))} cajas · ${soles2(ult(12) * r.costo)}`),
      fila('Meses con venta (últimos 12)', conV)].join('');
    // estado del inventario: barra con seguridad (rojo) + pedido (verde) y las flechas de stock hoy y al llegar un pedido
    const tope = Math.max(r.ss + r.roq, r.pos, 1) * 1.1, y = v => 100 - Math.max(0, Math.min(v, tope)) / tope * 100;
    $('estBarra').innerHTML = r.sinDemanda ? '<p class="z">Sin demanda pronosticada.</p>' : `
      <div class="barra-inv">
        <div class="bi-col"><div class="bi-roq" style="top:${y(r.ss + r.roq)}%;bottom:${100 - y(r.ss)}%"><span>${fmtE(p, r.ss + r.roq)}</span></div><div class="bi-ss" style="top:${y(r.ss)}%"><span>${fmtE(p, r.ss)}</span></div></div>
        <div class="bi-flecha der" style="top:${y(r.pos)}%">← ${fmtS(p, r.pos)} <small>stock hoy</small></div>
        <div class="bi-flecha izq" style="top:${y(Math.max(0, r.posLT))}%"><small>al llegar un pedido</small> ${fmtE(p, Math.max(0, r.posLT))} →</div>
      </div>
      <p class="z" style="margin:6px 0 0">Estado: <b style="color:${colorEstado(r.estado)}">${nf0.format(r.estado * 100)} %</b> · rojo = stock de seguridad · verde = seguridad + cantidad a pedir</p>`;
    // stock y venta por almacén
    const st = window.STOCK_TODOS?.[p.c] || {}, farms = [...new Set([...Object.keys(st), ...Object.keys(p.hf || {})])].filter(a => !/CANJE/i.test(a));
    farms.sort((a, b) => (a === 'DROGUERIA FS' ? -1 : b === 'DROGUERIA FS' ? 1 : (+st[b]?.[0] || 0) - (+st[a]?.[0] || 0)));
    $('estRed').innerHTML = `<thead><tr><th class="c1 solo">Almacén</th><th>Stock</th><th>Valor</th><th>Venta último mes</th><th>Prom. 3 meses</th></tr></thead><tbody>` +
      farms.map(f => { const s = +st[f]?.[0] || 0, hv = p.hf?.[f] || [], u1 = hv[hv.length - 1] || 0, u3 = hv.slice(-3).reduce((a, v) => a + (v || 0), 0) / 3;
        return `<tr><td class="c1 solo">${esc(f)}</td><td class="n">${fmtS(p, s)}</td><td class="n">${soles2(s * r.costo)}</td><td class="n">${fmtE(p, u1)}</td><td class="n">${fmtE(p, u3)}</td></tr>`; }).join('') +
      `<tr class="tot"><td class="c1 solo"><b>Total</b></td><td class="n"><b>${fmtS(p, r.pos)}</b></td><td class="n"><b>${soles2(r.pos * r.costo)}</b></td><td></td><td></td></tr></tbody>`;
    $('estSum').innerHTML = [fila('Tipo', 'Compra'), fila('Proveedor', esc(labDe(p.c)) || '–'), fila('Tiempo de entrega', `${nf0.format(r.LT)} días`), fila('Costo', r.costo ? 'S/ ' + nf1.format(r.costo) : '–'),
      fila('Unidad', p.fr > 1 ? `caja de ${p.fr} fracciones` : 'caja')].join('');
  }
  function pintarPron(r) {
    const p = r.p, o = S.P, a = r.a, hist = o.meses, nh = Math.min(24, hist.length), hm = hist.slice(-nh), hv = p.h.slice(-nh);
    const lab = [...hm, ...r.meses];
    const av = typeof avance === 'function' ? avance(p) : null;
    dibujar('estChartP', { type: 'line', data: { labels: lab.map(et), datasets: [
      { label: 'Venta real', data: [...hv, ...r.meses.map(m => av && m === av.mes ? av.v : null)], borderColor: '#7cb342', backgroundColor: '#7cb342', tension: .15, pointRadius: 2, spanGaps: false },
      { label: 'Pronóstico base', data: [...hm.map(() => null), ...r.base], borderColor: '#e53935', backgroundColor: '#e53935', tension: .15, pointRadius: 2, borderDash: a.over ? [5, 4] : [] },
      ...(a.over ? [{ label: 'Pronóstico corregido', data: [...hm.map(() => null), ...r.pron], borderColor: '#fb8c00', backgroundColor: '#fb8c00', tension: .15, pointRadius: 3 }] : [])
    ] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'right' } }, scales: { y: { beginAtZero: true } } } });
    const hace = k => r.meses.map(m => { const i = hist.indexOf(addM(m, -12 * k)); return i >= 0 ? p.h[i] : null; });
    const v1 = hace(1), v2 = hace(2), celdas = (arr) => arr.map(v => `<td class="n">${v == null ? '<span class="z">·</span>' : fmtE(p, v)}</td>`).join('');
    $('estTablaP').innerHTML = `<thead><tr><th class="c1 solo"></th>${r.meses.map(m => `<th>${et(m)}</th>`).join('')}</tr></thead><tbody>
      <tr><td class="c1 solo">Venta hace 2 años</td>${celdas(v2)}</tr><tr><td class="c1 solo">Venta hace 1 año</td>${celdas(v1)}</tr>
      <tr><td class="c1 solo">Venta real${av ? ` <small class="z">(al ${av.dia})</small>` : ''}</td>${r.meses.map(m => `<td class="n">${av && m === av.mes ? fmtE(p, av.v) : '<span class="z">·</span>'}</td>`).join('')}</tr>
      <tr><td class="c1 solo"><b>Pronóstico base</b></td>${r.base.map(v => `<td class="n"><b>${fmtE(p, v)}</b></td>`).join('')}</tr>
      <tr><td class="c1 solo">Corrección <small class="z">(reemplaza)</small></td>${r.meses.map(m => `<td><input class="est-in" type="number" min="0" step="any" data-over="${m}" value="${a.over?.[m] ?? ''}" placeholder=""></td>`).join('')}</tr>
      <tr><td class="c1 solo"><b>Pronóstico final</b></td>${r.pron.map(v => `<td class="n big">${fmtE(p, v)}</td>`).join('')}</tr></tbody>`;
    $('estParP').innerHTML = `
      ${fila('Método de pronóstico', `<select id="estMet">${METODO_OP.map(([v, t]) => `<option value="${v}" ${(a.metodo || '') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}
      ${fila('Método usado', esc(r.metodo))}
      ${fila('Error estimado (sMAPE)', r.smape != null ? pct(r.smape) : '–')}
      ${fila('Desviación estándar (cajas/mes)', fmtE(p, r.sdMesCalc))}
      ${r.fp.periodo ? fila('Ciclo estacional', `${r.fp.periodo} meses`) : ''}
      ${fila('Métodos evaluados', (r.fp.evaluados || []).map(([m, s]) => `${esc(m)}: ${pct(s)}`).join(' · ') || '–')}`;
  }
  function pintarPlan(r) {
    const p = r.p, a = r.a, f = r.plan;
    dibujar('estChartPl', { data: { labels: f.map(x => et(x.m)), datasets: [
      { type: 'line', label: 'Stock inicial', data: f.map(x => x.ini), borderColor: '#7cb342', backgroundColor: '#7cb342', tension: .2, pointRadius: 0, order: 1 },
      { type: 'line', label: 'Cantidad a pedir', data: f.map(x => x.roq), borderColor: '#fb8c00', backgroundColor: '#fb8c00', tension: .2, pointRadius: 0, order: 1 },
      { type: 'line', label: 'Stock de seguridad', data: f.map(x => x.ss), borderColor: '#e53935', backgroundColor: '#e53935', tension: .2, pointRadius: 0, order: 1 },
      { type: 'bar', label: 'Pedido propuesto', data: f.map(x => x.sum), backgroundColor: '#1e88e5', order: 2 },
      { type: 'bar', label: 'Demanda', data: f.map(x => x.dem), backgroundColor: '#fbc02d', order: 3 }
    ] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'right' } }, scales: { y: { beginAtZero: true } } } });
    const rw = (t, k, b) => `<tr><td class="c1 solo">${b ? `<b>${t}</b>` : t}</td>${f.map(x => `<td class="n">${b ? '<b>' : ''}${fmtE(p, x[k])}${b ? '</b>' : ''}</td>`).join('')}</tr>`;
    $('estTablaPl').innerHTML = `<thead><tr><th class="c1 solo"></th>${f.map(x => `<th>${et(x.m)}</th>`).join('')}</tr></thead><tbody>
      ${rw('Cantidad a pedir', 'roq')}${rw('Stock de seguridad', 'ss')}${rw('Stock inicial', 'ini')}${rw('Demanda', 'dem', 1)}${rw('Pedido propuesto', 'sum', 1)}${rw('Stock final', 'fin')}</tbody>`;
    const inp = (k, ph, w = 80) => `<input class="est-in" type="number" step="any" data-par="${k}" value="${a[k] ?? ''}" placeholder="${ph}" style="width:${w}px">`;
    $('estParSS').innerHTML = `<p>Stock de seguridad calculado: <b>${fmtE(p, r.ss)}</b> cajas · punto de pedido <b>${fmtE(p, r.rop)}</b> · distribución ${esc(r.dist || '–')}</p>
      <div class="est-grid">
        <label>Nivel de servicio (%)</label><div>${inp('sl', nf1.format(opciones().SL * 100))}</div>
        <label>Desviación de la demanda (cajas/mes)</label><div>${inp('sdD', nf1.format(r.sdMesCalc))}</div>
        <label>Desviación del tiempo de entrega (días)</label><div>${inp('sdLT', '0')}</div>
        <label>Tiempo de entrega (días)</label><div>${inp('lt', String(opciones().LT))}</div>
        <label>Limitado por cantidad entre</label><div>${inp('ssQmin', '')} y ${inp('ssQmax', '')} cajas</div>
        <label>Cobertura entre</label><div>${inp('ssDmin', '')} y ${inp('ssDmax', '')} días</div>
      </div>`;
    $('estParROQ').innerHTML = `<p>Cantidad económica de pedido (EOQ): <b>${fmtE(p, r.eoq || 0)}</b> cajas · cantidad a pedir usada: <b>${fmtE(p, r.roq)}</b></p>
      <div class="est-grid">
        <label>Limitado por cantidad entre</label><div>${inp('roqQmin', '')} y ${inp('roqQmax', '')} cajas</div>
        <label>Cobertura entre</label><div>${inp('roqDmin', String(opciones().min))} y ${inp('roqDmax', String(opciones().max))} días</div>
      </div>
      <h3>No almacenar</h3><p class="z">Stock de seguridad 0 y cantidad a pedir 1: solo se compra cuando hay pedido.</p>
      <select data-par="noStock"><option value="" ${!a.noStock ? 'selected' : ''}>Por defecto (calcular)</option><option value="1" ${a.noStock ? 'selected' : ''}>Sí, no almacenar</option></select>`;
  }
  function pintarPed(r) {
    const p = r.p, peds = r.plan.filter(x => x.sum > 0);
    $('estTablaPed').innerHTML = `<thead><tr><th class="c1 solo">Tipo</th><th>Estado</th><th>Proveedor</th><th>Fecha de pedido</th><th>Llega</th><th>Cantidad</th><th>Costo</th><th>Valor</th></tr></thead><tbody>` +
      (peds.length ? peds.map(x => `<tr><td class="c1 solo">Compra</td><td><span class="tag">propuesto</span></td><td>${esc(labDe(p.c)) || '–'}</td><td>${x.fecha.toLocaleDateString('es-PE')}</td><td>${x.llega.toLocaleDateString('es-PE')}</td>
        <td class="n big">${nf0.format(x.sum)}</td><td class="n">${r.costo ? 'S/ ' + nf1.format(r.costo) : '–'}</td><td class="n">${soles2(x.sum * r.costo)}</td></tr>`).join('')
        + `<tr class="tot"><td class="c1 solo" colspan="5"><b>Total 12 meses</b></td><td class="n"><b>${nf0.format(peds.reduce((s, x) => s + x.sum, 0))}</b></td><td></td><td class="n"><b>${soles2(peds.reduce((s, x) => s + x.sum * r.costo, 0))}</b></td></tr>`
        : `<tr><td class="c1 solo" colspan="8">No hay pedidos propuestos en los próximos 12 meses.</td></tr>`) + '</tbody>';
  }

  /* ---------- exportar pedidos a Excel (CSV) ---------- */
  function csv(filas, nombre) {
    const t = filas.map(f => f.map(v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + t], { type: 'text/csv;charset=utf-8' })); a.download = nombre; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  $('estXls').addEventListener('click', () => {
    const l = (S.estLista || []).filter(r => r.pedir > 0);
    csv([['Código', 'Producto', 'Laboratorio', 'Cantidad (cajas)', 'Costo S/', 'Valor S/', 'Stock', 'Stock seguridad', 'Punto de pedido', 'Cantidad a pedir', 'Método'],
      ...l.map(r => [r.p.c, r.p.n, labDe(r.p.c), r.pedir, (r.costo || 0).toFixed(2).replace('.', ','), (r.pedir * r.costo).toFixed(2).replace('.', ','), nf1.format(r.pos), nf1.format(r.ss), nf1.format(r.rop), nf1.format(r.roq), r.metodo])],
      `pedidos_propuestos_${S.P.corte}.csv`);
  });

  /* ---------- eventos ---------- */
  ['frLT', 'frSL', 'frFte', 'frROQmin', 'frROQmax', 'frS', 'frH'].forEach(id => $(id).addEventListener('change', () => { S.frMostrar = PAGINA; window.pintarEst(); }));
  $('frVer').addEventListener('change', e => { S.frVer = e.target.value; S.frMostrar = PAGINA; window.pintarEst(); });
  $('frq').addEventListener('input', () => { S.frMostrar = PAGINA; window.pintarEst(); });
  $('frCards').addEventListener('click', e => { const b = e.target.closest('[data-ver]'); if (!b) return; S.frVer = b.dataset.ver; S.frMostrar = PAGINA; window.pintarEst(); });
  $('frTabla').addEventListener('click', e => {
    const tr = e.target.closest('tr.click'); if (!tr) return;
    S.estCur = tr.dataset.cod; window.pintarEst(); $('estDet').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('estTabs').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) { S.estTab = b.dataset.t; pintarDetalle(); } });
  // cambios en los parámetros del producto: quedan "sin guardar" hasta Guardar; Recalcular los aplica
  function editar(c) { return (EST.edit[c] ??= JSON.parse(JSON.stringify(EST.cfg?.p?.[c] || {}))); }
  $('estDet').addEventListener('change', e => {
    const c = S.estCur; if (!c) return; const t = e.target;
    if (t.id === 'estMet') { editar(c).metodo = t.value || undefined; recalcular(); return; }
    if (t.dataset.over) { const a = editar(c), v = num(t.value); a.over ??= {}; if (v == null) delete a.over[t.dataset.over]; else a.over[t.dataset.over] = Math.max(0, v); if (!Object.keys(a.over).length) delete a.over; recalcular(); return; }
    if (t.dataset.par) { const a = editar(c), k = t.dataset.par; a[k] = k === 'noStock' ? (t.value ? true : undefined) : num(t.value) ?? undefined;
      const sub = $('estSub'); if (!/sin guardar/.test(sub.innerHTML)) sub.innerHTML += ' · <b class="neg">cambios sin guardar: pulsa Recalcular para verlos</b>'; }
  });
  function recalcular() { cache.delete(S.estCur); cacheClave = ''; window.pintarEst(); }
  $('estRecalc').addEventListener('click', recalcular);
  $('estGuardar').addEventListener('click', async () => { const c = S.estCur; if (!c) return; await guardar(c); recalcular(); });
  $('estDeshacer').addEventListener('click', () => { const c = S.estCur; if (!c) return; delete EST.edit[c]; recalcular(); });
  $('estBorrar').addEventListener('click', async () => {
    const c = S.estCur; if (!c || !confirm('¿Quitar todos los ajustes de este producto y volver al cálculo automático?')) return;
    EST.edit[c] = {}; await guardar(c); recalcular();
  });
  $('estFicha').addEventListener('click', () => { if (S.estCur) abrirFichaP(S.estCur, 'fre'); });
  $('estCerrar').addEventListener('click', () => { S.estCur = null; window.pintarEst(); });
})();
