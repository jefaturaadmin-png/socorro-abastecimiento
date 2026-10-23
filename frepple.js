/* Basado en frePPLe, Copyright (C) 2012-2016 by frePPLe bv. Licencia MIT:
   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
   permit persons to whom the Software is furnished to do so, subject to the following conditions:
   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
   the Software.
   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   SOFTWARE. */
/* Motor de pronóstico de frePPLe, portado a JavaScript desde su código abierto:
   https://github.com/frePPLe/frepple  src/forecast/timeseries.cpp (licencia MIT) y la
   clasificación de la demanda de freppledb/forecast/commands.py.
   Mismos métodos, parámetros por defecto y reglas de elección:
   media móvil, constante (suavizado exponencial simple), tendencia (doble), estacional
   (Holt-Winters) y Croston (intermitente); se elige el de menor sMAPE ponderado. */
(function () {
  const ACCURACY = 0.01, ROUNDING_ERROR = 1e-6, MAXDEV = 4.0, ITER = 15, SMAPE_ALFA = 0.95, SKIP = 5;
  const MA_ORDER = 5, DEAD_BUCKETS = 12;   // DeadAfterInactivity = 365 días = 12 meses
  const W = [1]; for (let i = 0; i < 400; i++) W.push(W[i] * SMAPE_ALFA);
  const MAX = Number.MAX_VALUE;

  function movingAverage(ts, count) {
    const clean = new Array(count + 1).fill(0);
    let sd = 0, maxdev = 0, smape = 0, sw = 0, avg = 0;
    for (let outliers = 0; outliers <= 1; ++outliers) {
      if (outliers) clean[0] = ts[0];
      smape = 0; sw = 0;
      for (let i = 1; i <= count; ++i) {
        const actual = ts[i];
        if (outliers === 0) {
          let sum = 0; for (let j = 0; j < MA_ORDER && j < i; ++j) sum += ts[i - j - 1];
          avg = sum / MA_ORDER; if (i === count) break;
          sd += (avg - actual) * (avg - actual);
          if (Math.abs(avg - actual) > maxdev) maxdev = Math.abs(avg - actual);
        } else {
          let sum = 0; for (let j = 0; j < MA_ORDER && j < i; ++j) sum += clean[i - j - 1];
          avg = sum / MA_ORDER; if (i === count) break;
          if (actual > avg + MAXDEV * sd) clean[i] = avg + MAXDEV * sd;
          else if (actual < avg - MAXDEV * sd) clean[i] = avg - MAXDEV * sd;
          else clean[i] = actual;
        }
        if (i >= SKIP && i < count && Math.abs(avg + actual) > ROUNDING_ERROR) {
          smape += Math.abs(avg - actual) / Math.abs(avg + actual) * W[count - i]; sw += W[count - i];
        }
      }
      if (outliers === 0) {
        if (count > 1) { sd = Math.sqrt(sd / (count - 1)); maxdev /= sd; if (maxdev < MAXDEV) break; }
        else { sd = Math.sqrt(sd); break; }
      }
    }
    if (sw) smape /= sw;
    return { metodo: 'Media móvil', smape, sd, futuro: n => Array(n).fill(Math.max(0, avg)) };
  }

  function singleExponential(ts, count) {
    if (count < SKIP + 5) return null;
    const min_alfa = 0.03, max_alfa = 1.0; let alfa = 0.2;
    let up = false, low = false, error = 0, smape = 0, sw = 0, best_smape = 0, delta, df = 0, s11 = 0, s12 = 0, f_i = 0;
    let best_error = MAX, best_f = 0, best_sd = 0, iteration = 1;
    for (; iteration <= ITER; ++iteration) {
      let sd = 0, maxdev = 0;
      for (let outliers = 0; outliers <= 1; outliers++) {
        df = s11 = s12 = smape = sw = error = 0;
        const h0 = ts[0], h1 = ts[1], h2 = ts[2];
        f_i = (h0 + h1 + h2) / 3;
        if (outliers === 1) {
          let t = 0; const lim = MAXDEV * sd;
          for (const h of [h0, h1, h2]) t += h > f_i + lim ? f_i + lim : h < f_i - lim ? f_i - lim : h;
          f_i = t / 3;
        }
        let hi = h0, him1 = h0;
        for (let i = 1; i <= count; ++i) {
          him1 = hi; hi = ts[i];
          df = him1 - f_i + (1 - alfa) * df;
          f_i = him1 * alfa + (1 - alfa) * f_i;
          if (i === count) break;
          if (outliers === 0) { sd += (f_i - hi) * (f_i - hi); if (Math.abs(f_i - hi) > maxdev) maxdev = Math.abs(f_i - hi); }
          else if (hi > f_i + MAXDEV * sd) hi = f_i + MAXDEV * sd;
          else if (hi < f_i - MAXDEV * sd) hi = f_i - MAXDEV * sd;
          s12 += df * (hi - f_i) * W[count - i]; s11 += df * df * W[count - i];
          if (i >= SKIP) {
            error += (f_i - hi) * (f_i - hi) * W[count - i];
            if (Math.abs(f_i + hi) > ROUNDING_ERROR) { smape += Math.abs(f_i - hi) / (f_i + hi) * W[count - i]; sw += W[count - i]; }
          }
        }
        if (outliers === 0) { sd = Math.sqrt(sd / (count - 1)); maxdev /= sd; if (maxdev < MAXDEV) break; }
      }
      if (error < best_error) { best_error = error; best_smape = sw ? smape / sw : 0; best_f = f_i; best_sd = sd; }
      if (Math.abs(s11 + error / iteration) > ROUNDING_ERROR) s11 += error / iteration;
      if (Math.abs(s11) < ROUNDING_ERROR) break;
      delta = s12 / s11;
      if (Math.abs(delta) < ACCURACY && iteration > 3) break;
      alfa += delta;
      if (alfa > max_alfa) { alfa = max_alfa; if (up) break; up = true; }
      else if (alfa < min_alfa) { alfa = min_alfa; if (low) break; low = true; }
    }
    return { metodo: 'Constante', smape: best_smape, sd: best_sd, futuro: n => Array(n).fill(Math.max(0, best_f)) };
  }

  function doubleExponential(ts, count) {
    if (count < SKIP + 5) return null;
    const min_alfa = 0.02, max_alfa = 1.0, min_gamma = 0.05, max_gamma = 1.0, damp = 0.8;
    let alfa = 0.2, gamma = 0.2, error = 0, smape = 0, sw = 0;
    let best_error = MAX, best_smape = 0, best_c = 0, best_t = 0, best_sd = 0, c_i = 0, t_i = 0;
    let iteration = 1, bt = 0;
    for (; iteration <= ITER; ++iteration) {
      let sd = 0, maxdev = 0, s11 = 0, s12 = 0, s22 = 0, s13 = 0, s23 = 0;
      for (let outliers = 0; outliers <= 1; outliers++) {
        error = smape = sw = s11 = s12 = s22 = s13 = s23 = 0;
        let dCa = 0, dCg = 0, dTa = 0, dTg = 0, dFa = 0, dFg = 0;
        const h0 = ts[0], h1 = ts[1], h2 = ts[2], h3 = ts[3];
        c_i = (h0 + h1 + h2) / 3; t_i = (h3 - h0) / 3;
        if (outliers === 1) {
          const lim = MAXDEV * sd;
          let t1 = h0 > c_i + lim ? c_i + lim : h0 < c_i - lim ? c_i - lim : h0;
          let t2 = -t1;
          t1 += h1 > c_i + t_i + lim ? c_i + t_i + lim : h1 < c_i + t_i - lim ? c_i + t_i - lim : h1;
          const v2 = h2 > c_i + 2 * t_i + lim ? c_i + 2 * t_i + lim : h2 < c_i + 2 * t_i - lim ? c_i + 2 * t_i - lim : h2;
          t1 += v2; t2 += v2;
          c_i = t1 / 3; t_i = t2 / 3;
        }
        let hi = h0, him1 = h0;
        for (let i = 1; i <= count; ++i) {
          him1 = hi; hi = ts[i];
          const cp = c_i, tp = t_i;
          c_i = him1 * alfa + (1 - alfa) * (cp + tp);
          t_i = gamma * (c_i - cp) + (1 - gamma) * tp;
          if (i === count) break;
          if (outliers === 0) { const d = c_i + t_i - hi; sd += d * d; if (Math.abs(d) > maxdev) maxdev = Math.abs(d); }
          else if (hi > c_i + t_i + MAXDEV * sd) hi = c_i + t_i + MAXDEV * sd;
          else if (hi < c_i + t_i - MAXDEV * sd) hi = c_i + t_i - MAXDEV * sd;
          const dCgp = dCg, dCap = dCa;
          dCa = him1 - cp - tp + (1 - alfa) * dFa;
          dCg = (1 - alfa) * dFg;
          dTa = gamma * (dCa - dCap) + (1 - gamma) * dTa;
          dTg = c_i - cp - tp + gamma * (dCg - dCgp) + (1 - gamma) * dTg;
          dFa = dCa + dTa; dFg = dCg + dTg;
          const w = W[count - i];
          s11 += w * dFa * dFa; s12 += w * dFa * dFg; s22 += w * dFg * dFg;
          s13 += w * dFa * (hi - c_i - t_i); s23 += w * dFg * (hi - c_i - t_i);
          if (i >= SKIP) {
            error += (c_i + t_i - hi) * (c_i + t_i - hi) * w;
            if (Math.abs(c_i + t_i + hi) > ROUNDING_ERROR) { smape += Math.abs(c_i + t_i - hi) / Math.abs(c_i + t_i + hi) * w; sw += w; }
          }
        }
        if (outliers === 0) { sd = Math.sqrt(sd / (count - 1)); maxdev /= sd; if (maxdev < MAXDEV) break; }
      }
      if (error < best_error) { best_error = error; best_smape = sw ? smape / sw : 0; best_c = c_i; best_t = t_i; best_sd = sd; }
      s11 += error / iteration; s22 += error / iteration;
      let det = s11 * s22 - s12 * s12;
      if (Math.abs(det) < ROUNDING_ERROR) {
        s11 -= error / iteration; s22 -= error / iteration; det = s11 * s22 - s12 * s12;
        if (Math.abs(det) < ROUNDING_ERROR) break;
      }
      const da = (s13 * s22 - s23 * s12) / det, dg = (s23 * s11 - s13 * s12) / det;
      if (Math.abs(da) + Math.abs(dg) < 2 * ACCURACY && iteration > 3) break;
      alfa += da; gamma += dg;
      alfa = Math.min(max_alfa, Math.max(min_alfa, alfa)); gamma = Math.min(max_gamma, Math.max(min_gamma, gamma));
      if ((gamma === min_gamma || gamma === max_gamma) && (alfa === min_alfa || alfa === max_alfa)) { if (bt++ > 5) break; }
    }
    return { metodo: 'Tendencia', smape: best_smape, sd: best_sd, futuro: n => {
      let c = best_c, t = best_t; const r = [];
      for (let k = 0; k < n; k++) { c += t; t *= damp; r.push(Math.max(0, c)); }
      return r;
    } };
  }

  function detectCycle(ts, count) {
    const min_period = 2, max_period = 14, min_ac = 0.5;
    if (count < min_period * 2) return { period: 0, ac: 0 };
    let average = 0; for (let i = 0; i < count; ++i) average += ts[i]; average /= count;
    let variance = 0; for (let i = 0; i < count; ++i) variance += (ts[i] - average) ** 2; variance /= count;
    let best_period = 0, best_ac = min_ac; const c = [10, 10, 10, 10, 10, 10, 10];
    for (let p = min_period; p <= max_period && p < Math.floor(count / 2); ++p) {
      for (let i = 6; i > 0; --i) c[i] = c[i - 1];
      c[0] = 0; for (let i = p; i < count; ++i) c[0] += (ts[i - p] - average) * (ts[i] - average);
      c[0] /= count - p; c[0] /= variance;
      if (p > min_period + 1 && c[1] > c[2] * 1.1 && c[1] > c[0] * 1.1 && c[1] > best_ac) { best_ac = c[1]; best_period = p - 1; }
      if (p > min_period + 4 && c[2] > best_ac && c[2] > (c[0] + c[1]) / 2 && c[2] > (c[3] + c[4]) / 2) { best_ac = c[2]; best_period = p - 2; }
      if (p > min_period + 6 && c[3] > best_ac && c[3] > (c[0] + c[1] + c[2]) / 3 && c[3] > (c[4] + c[5] + c[6]) / 3) { best_ac = c[3]; best_period = p - 3; }
    }
    return { period: best_period, ac: best_ac };
  }

  function seasonal(ts, count) {
    const { period, ac } = detectCycle(ts, count);
    if (!period) return null;
    const min_alfa = 0.02, max_alfa = 1.0, min_beta = 0.2, max_beta = 1.0, gamma = 0.05, damp = 0.8, max_ac = 0.8;
    let alfa = 0.2, beta = 0.2;
    let best_error = MAX, best_smape = 0, best_sd = 0;
    const initS = Array(period).fill(0), S = Array(period).fill(0), dSa = Array(period).fill(0), dSb = Array(period).fill(0);
    let L0 = 0, T0 = 0;
    for (let i = 0; i < period; ++i) { L0 += ts[i]; T0 += ts[i + period] - ts[i]; }
    T0 /= period; L0 /= period;
    let bestL = L0, bestT = T0, bestS = initS.slice(), bestCI = 0;
    let cycles = 0;
    for (let i = 0; i + period <= count; i += period) {
      ++cycles; let cs = 0; for (let j = 0; j < period; ++j) cs += ts[i + j];
      if (cs) for (let j = 0; j < period; ++j) initS[j] += ts[i + j] / cs * period;
    }
    for (let i = 0; i < period; ++i) initS[i] /= cycles;
    let L = 0, T = 0, cycleindex = 0, iteration = 1, bt = 0;
    for (; iteration <= ITER; ++iteration) {
      let error = 0, smape = 0, sw = 0, s11 = 0, s12 = 0, s13 = 0, s22 = 0, s23 = 0, sd = 0;
      let dLa = 0, dLb = 0, dTa = 0, dTb = 0;
      L = L0; T = T0; let cyclesum = 0;
      for (let i = 0; i < period; ++i) { S[i] = initS[i]; dSa[i] = 0; dSb[i] = 0; if (i) cyclesum += ts[i - 1]; }
      let prev = period - 1; cycleindex = 0;
      for (let i = period; i <= count; ++i) {
        const Lp = L, actual = i === count ? 0 : ts[i];
        cyclesum += ts[i - 1]; if (i > period) cyclesum -= ts[i - period - 1];
        L = alfa * cyclesum / period + (1 - alfa) * (L + T); if (L < 0) L = 0;
        T = beta * (L - Lp) + (1 - beta) * T;
        let factor = -S[prev];
        if (L) S[prev] = gamma * ts[i - 1] / L + (1 - gamma) * S[prev];
        if (S[prev] < 0) S[prev] = 0;
        factor = period / (period + factor + S[prev]);
        for (let k = 0; k < period; ++k) S[k] *= factor;
        if (i === count) break;
        const dLap = dLa, dLbp = dLb, dTap = dTa, dTbp = dTb, dSap = dSa[prev], dSbp = dSb[prev];
        dLa = cyclesum / period - (L + T) + (1 - alfa) * (dLap + dTap);
        dLb = (1 - alfa) * (dLbp + dTbp);
        if (L > ROUNDING_ERROR) {
          dSa[prev] = -gamma * ts[i - 1] / L / L * dLap + (1 - gamma) * dSap;
          dSb[prev] = -gamma * ts[i - 1] / L / L * dLbp + (1 - gamma) * dSbp;
        } else { dSa[prev] = (1 - gamma) * dSap; dSb[prev] = (1 - gamma) * dSbp; }
        dTa = beta * (dLa - dLap) + (1 - beta) * dTap;
        dTb = (L - Lp) + beta * (dLb - dLbp) - T + (1 - beta) * dTbp;
        const dFa = (dLa + dTa) * S[cycleindex] + (L + T) * dSa[cycleindex];
        const dFb = (dLb + dTb) * S[cycleindex] + (L + T) * dSb[cycleindex];
        const f = (L + T) * S[cycleindex], w = W[count - i];
        s11 += w * dFa * dFa; s12 += w * dFa * dFb; s22 += w * dFb * dFb; s13 += w * dFa * (actual - f); s23 += w * dFb * (actual - f);
        if (i >= SKIP) {
          error += (f - actual) ** 2 * w;
          if (Math.abs(f + actual) > ROUNDING_ERROR) { smape += Math.abs(f - actual) / Math.abs(f + actual) * w; sw += w; sd += (f - actual) ** 2; }
        }
        if (++cycleindex >= period) cycleindex = 0;
        if (++prev >= period) prev = 0;
      }
      if (error < best_error) {
        best_error = error; best_smape = sw ? smape / sw : 0; bestL = L; bestT = T; bestCI = cycleindex;
        best_sd = Math.sqrt(sd / (count - period - 1)); bestS = S.slice();
      }
      s11 += error / iteration; s22 += error / iteration;
      let det = s11 * s22 - s12 * s12;
      if (Math.abs(det) < ROUNDING_ERROR) {
        s11 -= error / iteration; s22 -= error / iteration; det = s11 * s22 - s12 * s12;
        if (Math.abs(det) < ROUNDING_ERROR) break;
      }
      const da = (s13 * s22 - s23 * s12) / det, db = (s23 * s11 - s13 * s12) / det;
      if (Math.abs(da) + Math.abs(db) < 3 * ACCURACY && iteration > 3) break;
      alfa += da; beta += db;
      alfa = Math.min(max_alfa, Math.max(min_alfa, alfa)); beta = Math.min(max_beta, Math.max(min_beta, beta));
      if ((beta === min_beta || beta === max_beta) && (alfa === min_alfa || alfa === max_alfa)) { if (bt++ > 5) break; }
    }
    if (period > SKIP) { best_smape *= count - SKIP; best_smape /= count - period; }
    return { metodo: 'Estacional', smape: best_smape, sd: best_sd, forzar: ac > max_ac, periodo: period, futuro: n => {
      let l = bestL, t = bestT, ci = bestCI; const r = [];
      for (let k = 0; k < n; k++) { l += t; t *= damp; r.push(Math.max(0, l * bestS[ci])); if (++ci >= period) ci = 0; }
      return r;
    } };
  }

  function croston(ts, count) {
    const min_alfa = 0.03, max_alfa = 0.8, decay = 0.1;
    let nonzero = 0, total = 0, last = 0;
    for (let i = 0; i < count; ++i) if (ts[i]) { ++nonzero; total += ts[i]; last = i; }
    const pbd = count / nonzero;
    if (!nonzero) return { metodo: 'Intermitente', smape: 0, sd: 0, futuro: n => Array(n).fill(0) };
    let best_error = MAX, best_smape = 0, best_f = 0, best_sd = 0, f_i = 0;
    let alfa = min_alfa; const delta = ITER > 1 ? (max_alfa - min_alfa) / (ITER - 1) : 0;
    let between = 1;
    for (let iteration = 0; iteration < ITER; ++iteration) {
      let sd = 0, maxdev = 0, smape = 0, sw = 0;
      for (let outliers = 0; outliers <= 1; outliers++) {
        smape = sw = 0;
        let q = total / nonzero, p = count / nonzero;
        f_i = (1 - alfa / 2) * q / p;
        let hi = ts[0], him1 = hi;
        for (let i = 1; i <= count; ++i) {
          him1 = hi; hi = ts[i];
          if (him1) { q = alfa * him1 + (1 - alfa) * q; p = alfa * between + (1 - alfa) * p; f_i = (1 - alfa / 2) * q / p; between = 1; }
          else if (i > last && between > 2 * pbd) { f_i = f_i * (1 - decay); p = (1 - alfa / 2) * q / f_i; }
          else ++between;
          if (i === count) break;
          if (outliers === 0) { sd += (f_i - hi) ** 2; if (Math.abs(hi - f_i) > maxdev) maxdev = Math.abs(f_i - hi); }
          else if (hi > f_i + MAXDEV * sd) hi = f_i + MAXDEV * sd;
          if (i >= SKIP && p > 0 && Math.abs(f_i + hi) > ROUNDING_ERROR) { smape += Math.abs(f_i - hi) / Math.abs(f_i + hi) * W[count - i]; sw += W[count - i]; }
        }
        if (outliers === 0) {
          sd = count > 1 ? Math.sqrt(sd / (count - 1)) : 0;
          if (sd > ROUNDING_ERROR) maxdev /= sd;
          if (maxdev < MAXDEV) break;
        }
      }
      if (smape <= best_error) { best_error = smape; best_smape = sw ? smape / sw : 0; best_f = f_i; best_sd = sd; }
      if (delta) alfa += delta; else break;
    }
    return { metodo: 'Intermitente', smape: best_smape, sd: best_sd, futuro: n => Array(n).fill(Math.max(0, best_f)) };
  }

  // Patrón de la demanda (Syntetos-Boylan), como en freppledb/forecast/commands.py
  function patron(serie) {
    const meses = serie.map((v, i) => [v, i]).filter(([v]) => v > 0);
    if (!meses.length) return { patron: '', adi: null, cv2: null };
    const q = meses.map(([v]) => v), avg = q.reduce((a, b) => a + b, 0) / q.length;
    const sd = q.length > 1 ? Math.sqrt(q.reduce((a, b) => a + (b - avg) ** 2, 0) / (q.length - 1)) : 0;
    const cv2 = avg ? (sd / avg) ** 2 : 0, adi = (serie.length - meses[0][1]) / q.length;
    return { adi, cv2, patron: adi < 1.32 ? (cv2 < 0.49 ? 'smooth' : 'erratic') : (cv2 < 0.49 ? 'intermittent' : 'lumpy') };
  }

  const METODOS = { media: movingAverage, constante: singleExponential, tendencia: doubleExponential, estacional: seasonal, intermitente: croston };
  // h: venta mensual (null = mes sin dato). Devuelve el método elegido, su sMAPE, la desviación y n meses de pronóstico.
  // forzado: 'media' | 'constante' | 'tendencia' | 'estacional' | 'intermitente' para usar ese método (como el
  // "forecast method" que se elige a mano en frePPLe); si no se puede aplicar, se usa la elección automática.
  function pronosticar(h, n = 3, forzado = '') {
    let i0 = 0; while (i0 < h.length && !h[i0]) i0++;   // se salta hasta el primer mes con venta
    const serie = h.slice(i0);
    const pat = patron(serie.map(v => v || 0));
    if (!serie.length) return { metodo: 'Sin historia', smape: 0, sd: 0, f: Array(n).fill(0), ...pat };
    // meses sin dato: promedio del mes anterior y el siguiente con dato
    const ts = serie.slice(), count = ts.length;
    for (let i = 0; i < count; i++) if (ts[i] == null) {
      let a = i - 1; while (a >= 0 && serie[a] == null) a--;
      let b = i + 1; while (b < count && serie[b] == null) b++;
      ts[i] = a >= 0 && b < count ? (ts[a] + serie[b]) / 2 : a >= 0 ? ts[a] : b < count ? serie[b] : 0;
    }
    ts.push(0);
    let zero = 0, inactivos = 0; for (let i = 0; i < count; i++) if (ts[i] === 0) { zero++; inactivos++; } else inactivos = 0;
    let metodos;
    const fz = METODOS[forzado] && METODOS[forzado](ts, count);
    if (fz) return { metodo: fz.metodo, smape: fz.smape, sd: fz.sd, periodo: fz.periodo, f: fz.futuro(n), forzado: true, evaluados: [[fz.metodo, fz.smape]], ...pat };
    if (count <= SKIP + 5) metodos = [movingAverage];
    else if (inactivos >= DEAD_BUCKETS) return { metodo: 'Manual (sin venta en 1 año)', smape: 0, sd: 0, f: Array(n).fill(0), ...pat };
    else if (zero > 0.33 * count) metodos = [croston];
    else metodos = [movingAverage, singleExponential, doubleExponential, seasonal];
    let best = null, todos = [];
    for (const m of metodos) {
      const r = m(ts, count); if (!r) continue; todos.push(r);
      if (!best || r.smape < best.smape || r.forzar) { best = r; if (r.forzar) break; }
    }
    if (!best) best = movingAverage(ts, count);
    return { metodo: best.metodo, smape: best.smape, sd: best.sd, periodo: best.periodo, f: best.futuro(n),
      evaluados: todos.map(r => [r.metodo, r.smape]), ...pat };
  }
  const api = { pronosticar, patron };
  if (typeof module !== 'undefined') module.exports = api; else window.FREPPLE = api;
})();
