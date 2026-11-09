"""Cronograma de envíos a sucursales con la ruta más corta de cada día.

Uso:
    python3 scripts/cronograma_rutas.py horario_ruta.xlsx salida.xlsx

Lee la hoja de evaluación (nombre, puntaje, capacidad de atención en días y ubicación en grados/minutos/segundos)
y arma el cronograma hasta el 31 de diciembre:
  - Un solo carro, una salida por día (lunes a sábado; domingos y feriados no se reparte).
  - Pedido grande (amarillo): Fase 1 semanal a todas; Fase 2 (desde FASE2) cada 15 días a las de 30 y 45 días,
    semanal a las de 7 y 15 días.
  - Pedido corto (verde): Real todos los días que no tiene pedido grande, Puno lunes/miércoles/viernes,
    Ortega y Tupac una vez por semana (el día que menos km agrega).
  - Qué sucursales van cada día se elige para que la semana tenga menos km y la carga sea pareja;
    el orden de visita de cada día es el más corto (se prueban todos los órdenes).
Las distancias son en línea recta × FACTOR_CALLE (aproximación del recorrido por calles).
"""
import itertools, math, random, re, sys
from datetime import date, timedelta
import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

# ---------------- parámetros ----------------
DROGUERIA = ("DROGUERÍA", -12.0692611, -75.2095389)   # 12°04'09.34"S 75°12'34.34"W (Jr. Lima 284)
FACTOR_CALLE = 1.3            # las calles no van en línea recta
INICIO = date(2026, 11, 11)   # lo anterior ya está en el calendario
FIN = date(2026, 12, 31)
INICIO_PATRON = date(2026, 11, 16)   # del 11 al 14 de noviembre se sigue el ciclo actual (transición)
FASE2 = date(2026, 11, 30)    # desde esta semana: cada 15 días las de 30 y 45 días
FERIADOS = {date(2026, 12, 8): "Inmaculada Concepción", date(2026, 12, 9): "Batalla de Ayacucho", date(2026, 12, 25): "Navidad"}
MAX_GRANDES_DIA = 3
SIN_GRANDE = {"SOCORRO PUNO"}  # hoy solo recibe pedidos cortos
DIAS = ["LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB", "DOM"]
SEMILLA = 7

# lo último que recibió cada sucursal (calendario actual, 4–14 de noviembre)
TRANSICION = {  # fecha: (grandes, cortos)
    date(2026, 11, 11): (["MERCADO", "LOS HEROES"], ["SOCORRO PUNO", "SOCORRO REAL"]),
    date(2026, 11, 12): (["PARRA", "PIOPATA"], ["ORTEGA", "SOCORRO REAL"]),
    date(2026, 11, 13): (["SUMAR", "CONCEPCION", "ANDALUZ"], ["SOCORRO PUNO", "SOCORRO REAL"]),
    date(2026, 11, 14): (["HUANCAS", "TUPAC"], ["SOCORRO REAL"]),
}
ULTIMO_ANTES = {"ORTEGA": date(2026, 11, 9), "MERCADO TAMBO": date(2026, 11, 9), "SOCORRO REAL": date(2026, 11, 10), "LIBERTAD": date(2026, 11, 10)}


def dms(txt):
    v = []
    for g, m, s, h in re.findall(r"(\d+)°\s*(\d+)'\s*([\d.]+)\"?\s*([NSEW])", txt):
        x = int(g) + int(m) / 60 + float(s) / 3600
        v.append(-x if h in "SW" else x)
    return v[0], v[1]


def leer(path):
    ws = openpyxl.load_workbook(path, data_only=True).worksheets[0]
    suc = {}
    for r in range(5, ws.max_row + 1):
        n, ub = ws.cell(r, 3).value, ws.cell(r, 13).value
        if not n or not ub or "°" not in str(ub):
            continue
        lat, lon = dms(str(ub))
        suc[n.strip()] = dict(n=n.strip(), lat=lat, lon=lon, res=round(float(ws.cell(r, 9).value or 0), 2), cap=int(ws.cell(r, 11).value))
    return suc


def km(a, b):
    R = 6371
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h)) * FACTOR_CALLE


class Rutas:
    def __init__(self, suc):
        self.p = {DROGUERIA[0]: (DROGUERIA[1], DROGUERIA[2]), **{k: (v["lat"], v["lon"]) for k, v in suc.items()}}
        self.cache = {}

    def mejor(self, paradas):
        """Orden de visita más corto saliendo y volviendo a la droguería (se prueban todos los órdenes)."""
        k = frozenset(paradas)
        if k in self.cache:
            return self.cache[k]
        if not k:
            return self.cache.setdefault(k, (0.0, []))
        best = None
        for o in itertools.permutations(sorted(k)):
            camino = [DROGUERIA[0], *o, DROGUERIA[0]]
            d = sum(km(self.p[a], self.p[b]) for a, b in zip(camino, camino[1:]))
            if best is None or d < best[0]:
                best = (d, list(o))
        self.cache[k] = best
        return best


def optimizar(semanal, quincenal, fijos_cortos, R, rng, primera_semana=None):
    """Asigna a cada pedido grande un día (0-5) y, a los de cada 15 días, la semana (A o B),
    minimizando los km de la(s) semana(s) + el desbalance de carga entre días."""
    todos = sorted(semanal + quincenal)
    semanas = [0, 1] if quincenal else [0]

    def costo(asig):  # asig: s -> (semana, día)
        tot = 0
        for w in range(len(semanas)):
            for d in range(6):
                g = [s for s, (ww, dd) in asig.items() if dd == d and (ww == w or s in semanal)]
                if len(g) > MAX_GRANDES_DIA:
                    tot += 1000 * (len(g) - MAX_GRANDES_DIA)
                c = cortos_dia(d, g, fijos_cortos)
                tot += R.mejor(g + c)[0]
            cnt = [sum(1 for s, (ww, dd) in asig.items() if dd == d and (ww == w or s in semanal)) for d in range(6)]
            tot += 3 * (max(cnt) - min(cnt))
        if len(semanas) == 2:  # las dos semanas con una cantidad parecida de pedidos quincenales
            a = sum(1 for s in quincenal if asig[s][0] == 0)
            tot += 4 * abs(a - (len(quincenal) - a))
        if primera_semana:  # que el primer envío del patrón caiga ~7 días después del último
            for s, (w, d) in asig.items():
                if s in primera_semana:
                    gap = (INICIO_PATRON + timedelta(days=d) - primera_semana[s]).days
                    tot += 2.5 * abs(gap - 7)
        return tot

    mejor = None
    for _ in range(40):
        asig = {s: (rng.randrange(len(semanas)) if s in quincenal else 0, rng.randrange(6)) for s in todos}
        c = costo(asig)
        temp = 5.0
        for it in range(4000):
            s = rng.choice(todos)
            old = asig[s]
            asig[s] = (rng.randrange(len(semanas)) if s in quincenal else 0, rng.randrange(6))
            if rng.random() < 0.3:  # intercambio de días entre dos sucursales
                t = rng.choice(todos)
                asig[s], asig[t] = asig[t], old
                nc = costo(asig)
                if nc <= c or rng.random() < math.exp((c - nc) / temp):
                    c = nc
                else:
                    asig[t], asig[s] = asig[s], old
            else:
                nc = costo(asig)
                if nc <= c or rng.random() < math.exp((c - nc) / temp):
                    c = nc
                else:
                    asig[s] = old
            temp = max(0.05, temp * 0.999)
        if mejor is None or c < mejor[0]:
            mejor = (c, dict(asig))
    return mejor[1]


def cortos_dia(d, grandes, fijos):
    """fijos: dict día -> lista de cortos fijos (Real, Puno, y Ortega/Tupac ya ubicados)."""
    return [c for c in fijos.get(d, []) if c not in grandes]


def ubicar_cortos_semanales(asig_dias, R):
    """Real todos los días, Puno lun/mié/vie; Ortega y Tupac un día por semana (el que menos km agrega,
    a 2 días o más de su pedido grande)."""
    fijos = {d: ["SOCORRO REAL"] for d in range(6)}
    for d in (0, 2, 4):
        fijos[d].append("SOCORRO PUNO")
    for s in ("ORTEGA", "TUPAC"):
        dg = asig_dias.get(s)
        mejor = None
        for d in range(6):
            if dg is not None and abs(d - dg) < 2:
                continue
            g = [x for x, dd in asig_dias.items() if dd == d]
            base = R.mejor(g + cortos_dia(d, g, fijos))[0]
            extra = R.mejor(g + cortos_dia(d, g, fijos) + [s])[0] - base
            if mejor is None or extra < mejor[0]:
                mejor = (extra, d)
        fijos[mejor[1]].append(s)
    return fijos


def main(entrada, salida):
    suc = leer(entrada)
    R = Rutas(suc)
    rng = random.Random(SEMILLA)
    nombres = list(suc)
    grandes_todas = [s for s in nombres if s not in SIN_GRANDE]
    quinc = [s for s in grandes_todas if suc[s]["cap"] >= 30]
    seman = [s for s in grandes_todas if suc[s]["cap"] < 30]

    # último pedido grande antes del patrón
    ultimo = dict(ULTIMO_ANTES)
    for f, (g, _) in TRANSICION.items():
        for s in g:
            ultimo[s] = f

    # Fase 1: todas semanal. Primero los cortos con un reparto provisional y luego se afina dos veces.
    fijos = ubicar_cortos_semanales({}, R)
    for _ in range(2):
        a1 = optimizar(grandes_todas, [], fijos, R, rng, primera_semana=ultimo)
        dias1 = {s: d for s, (w, d) in a1.items()}
        fijos = fijos1 = ubicar_cortos_semanales(dias1, R)
    # Fase 2: semanas A y B (las de 7 y 15 días van las dos semanas; las de 30 y 45, en una)
    fijos2 = fijos1
    for _ in range(2):
        a2 = optimizar(seman, quinc, fijos2, R, rng)
        fijos2 = ubicar_cortos_semanales({s: d for s, (w, d) in a2.items() if s in seman}, R)

    # --- calendario día por día ---
    plan = {}  # fecha -> dict(grandes=[], cortos=[], nota="")
    d = INICIO
    while d <= FIN:
        if d.weekday() == 6:
            d += timedelta(days=1)
            continue
        if d in TRANSICION:
            g, c = TRANSICION[d]
            plan[d] = dict(grandes=list(g), cortos=list(c), nota="Transición (ciclo actual)")
        elif d >= INICIO_PATRON:
            wd = d.weekday()
            lunes = d - timedelta(days=wd)
            if lunes < FASE2:
                g = [s for s, dd in dias1.items() if dd == wd]
                c = cortos_dia(wd, g, fijos1)
                nota = "Fase 1 (semanal)"
            else:
                semana = ((lunes - FASE2).days // 7) % 2
                g = [s for s, (w, dd) in a2.items() if dd == wd and (s in seman or w == semana)]
                c = cortos_dia(wd, g, fijos2)
                nota = "Fase 2 · semana " + "AB"[semana]
            plan[d] = dict(grandes=g, cortos=c, nota=nota)
        d += timedelta(days=1)

    # feriados: los pedidos grandes pasan al día hábil anterior o siguiente con menos carga; los cortos se omiten
    for f, nom in sorted(FERIADOS.items()):
        if f not in plan:
            continue
        mov = plan[f]["grandes"]
        cand = []
        for paso in (-1, 1):
            x = f + timedelta(days=paso)
            while x in FERIADOS or x.weekday() == 6:
                x += timedelta(days=paso)
            if x in plan:
                cand.append(x)
        dest = min(cand, key=lambda x: (len(plan[x]["grandes"]), x))
        for s in mov:
            if s not in plan[dest]["grandes"]:
                plan[dest]["grandes"].append(s)
            if s in plan[dest]["cortos"]:
                plan[dest]["cortos"].remove(s)
        if mov:
            plan[dest]["nota"] += f" · + lo del {f.day}/{f.month} ({nom})"
        plan[f] = dict(grandes=[], cortos=[], nota="FERIADO: " + nom + (f" → pasa al {dest.day}/{dest.month}" if mov else ""), feriado=True)

    for f, p in plan.items():
        km_, orden = R.mejor(p["grandes"] + p["cortos"])
        p["km"], p["orden"] = km_, orden

    escribir(salida, suc, R, plan, dias1, fijos1, a2, fijos2, seman, quinc, ultimo)


# ---------------- Excel ----------------
AMA = PatternFill("solid", fgColor="FFE699")
VER = PatternFill("solid", fgColor="92D050")
CAB = PatternFill("solid", fgColor="D9EAF7")
TIT = PatternFill("solid", fgColor="1F4E78")
FER = PatternFill("solid", fgColor="FBBDBD")
GRI = PatternFill("solid", fgColor="F2F2F2")
fino = Side(style="thin", color="BFBFBF")
BOR = Border(left=fino, right=fino, top=fino, bottom=fino)
NEG = Font(bold=True)
CORTO = {"SOCORRO REAL": "Real", "SOCORRO PUNO": "Puno", "LOS HEROES": "Heroes", "MERCADO TAMBO": "Tambo", "PIOPATA": "Pio Pata"}
nc = lambda s: CORTO.get(s, s.title())


def maps(orden, R):
    pts = [DROGUERIA[0], *orden, DROGUERIA[0]]
    return "https://www.google.com/maps/dir/" + "/".join(f"{R.p[x][0]:.6f},{R.p[x][1]:.6f}" for x in pts)


def escribir(salida, suc, R, plan, dias1, fijos1, a2, fijos2, seman, quinc, ultimo):
    wb = openpyxl.Workbook()
    # 1. calendario
    ws = wb.active
    ws.title = "Cronograma"
    for c in range(1, 8):
        ws.column_dimensions[get_column_letter(c)].width = 17
    fila = 1
    for anio, mes, nombre in ((2026, 11, "NOVIEMBRE"), (2026, 12, "DICIEMBRE")):
        ws.merge_cells(start_row=fila, start_column=1, end_row=fila, end_column=7)
        x = ws.cell(fila, 1, nombre)
        x.fill, x.font, x.alignment = TIT, Font(bold=True, color="FFFFFF", size=13), Alignment(horizontal="center")
        fila += 1
        for i, dn in enumerate(DIAS):
            x = ws.cell(fila, i + 1, dn)
            x.fill, x.font, x.alignment, x.border = CAB, NEG, Alignment(horizontal="center"), BOR
        fila += 1
        d = date(anio, mes, 1) - timedelta(days=date(anio, mes, 1).weekday())
        while d.month <= mes and d.year == anio or (d.month == mes):
            if d > date(anio, mes, 28) and d.month != mes:
                break
            sem = [d + timedelta(days=i) for i in range(7)]
            alto = max([len(plan.get(x, {}).get("grandes", [])) for x in sem] + [2])
            altoc = max([len(plan.get(x, {}).get("cortos", [])) for x in sem] + [1])
            for i, x in enumerate(sem):
                col = i + 1
                if x.month != mes:
                    continue
                c = ws.cell(fila, col, x.day)
                c.font, c.alignment, c.border = NEG, Alignment(horizontal="center"), BOR
                if x.weekday() == 6 or x in FERIADOS:
                    c.fill = FER
                elif x.weekday() == 5:
                    c.fill = GRI
                p = plan.get(x)
                if not p:
                    continue
                if p.get("feriado"):
                    ws.cell(fila + 1, col, "FERIADO").font = Font(bold=True, color="C00000")
                    continue
                for j, s in enumerate(p["grandes"]):
                    y = ws.cell(fila + 1 + j, col, nc(s))
                    y.fill, y.alignment, y.border = AMA, Alignment(horizontal="center"), BOR
                for j, s in enumerate(p["cortos"]):
                    y = ws.cell(fila + 1 + alto + j, col, nc(s))
                    y.fill, y.alignment, y.border = VER, Alignment(horizontal="center"), BOR
                k = ws.cell(fila + 1 + alto + altoc, col, f"{p['km']:.1f} km")
                k.font, k.alignment = Font(italic=True, color="7F7F7F", size=9), Alignment(horizontal="center")
            fila += 3 + alto + altoc
            d += timedelta(days=7)
            if d.month != mes and d > date(anio, mes, 1):
                break
        fila += 1
    ws.cell(fila, 1, "Amarillo = pedido grande").fill = AMA
    ws.cell(fila, 3, "Verde = pedido corto").fill = VER
    ws.cell(fila, 5, "Rojo = domingo / feriado").fill = FER
    ws.cell(fila + 1, 1, "km aprox. = recorrido del día saliendo y volviendo a droguería (línea recta × 1.3)").font = Font(italic=True, color="7F7F7F")

    # 2. rutas del día
    wr = wb.create_sheet("Ruta por día")
    cab = ["Fecha", "Día", "Etapa", "Pedidos grandes", "Pedidos cortos", "Orden de visita (sale y vuelve a droguería)", "km aprox.", "Google Maps"]
    for i, t in enumerate(cab):
        x = wr.cell(1, i + 1, t)
        x.fill, x.font, x.border = CAB, NEG, BOR
    for i, w in enumerate([11, 6, 34, 34, 22, 70, 9, 14]):
        wr.column_dimensions[get_column_letter(i + 1)].width = w
    r = 2
    for f in sorted(plan):
        p = plan[f]
        vals = [f.strftime("%d/%m/%Y"), DIAS[f.weekday()], p["nota"], ", ".join(nc(s) for s in p["grandes"]), ", ".join(nc(s) for s in p["cortos"]),
                " → ".join(["Droguería", *[nc(s) for s in p["orden"]], "Droguería"]) if p["orden"] else "", round(p["km"], 1) if p["orden"] else ""]
        for i, v in enumerate(vals):
            x = wr.cell(r, i + 1, v)
            x.border = BOR
            x.alignment = Alignment(wrap_text=True, vertical="top")
        if p["orden"]:
            x = wr.cell(r, 8, "Abrir ruta")
            x.hyperlink, x.font = maps(p["orden"], R), Font(color="0563C1", underline="single")
        if p.get("feriado"):
            for i in range(1, 9):
                wr.cell(r, i).fill = FER
        r += 1
    wr.freeze_panes = "A2"

    # 3. patrón semanal
    wp = wb.create_sheet("Patrón semanal")
    wp.column_dimensions["A"].width = 26
    for c in range(2, 8):
        wp.column_dimensions[get_column_letter(c)].width = 18

    def bloque(r, titulo, grandes_por_dia, cortos_por_dia):
        x = wp.cell(r, 1, titulo)
        x.font = Font(bold=True, size=12)
        for i in range(6):
            y = wp.cell(r + 1, i + 2, DIAS[i])
            y.fill, y.font, y.border = CAB, NEG, BOR
        wp.cell(r + 2, 1, "Pedido grande").font = NEG
        wp.cell(r + 3, 1, "Pedido corto").font = NEG
        wp.cell(r + 4, 1, "Orden de visita").font = NEG
        wp.cell(r + 5, 1, "km aprox.").font = NEG
        tot = 0
        for i in range(6):
            g, c = grandes_por_dia[i], cortos_por_dia[i]
            kmd, orden = R.mejor(g + c)
            tot += kmd
            for k, (v, fill) in enumerate(((", ".join(nc(s) for s in g), AMA), (", ".join(nc(s) for s in c), VER), (" → ".join(nc(s) for s in orden), None), (round(kmd, 1), None))):
                y = wp.cell(r + 2 + k, i + 2, v)
                y.alignment, y.border = Alignment(wrap_text=True, vertical="top"), BOR
                if fill and v:
                    y.fill = fill
        wp.cell(r + 6, 1, "Total semana (km)").font = NEG
        wp.cell(r + 6, 2, round(tot, 1)).font = NEG
        return r + 8, tot

    def gdia(dias):
        return [[s for s, d in dias.items() if d == i] for i in range(6)]

    g1 = gdia(dias1)
    r, km1 = bloque(1, f"Fase 1 · todas semanal (16/11 al {(FASE2 - timedelta(days=1)).strftime('%d/%m')})", g1, [cortos_dia(i, g1[i], fijos1) for i in range(6)])
    for w in range(2):
        g = [[s for s, (ww, d) in a2.items() if d == i and (s in seman or ww == w)] for i in range(6)]
        r, _ = bloque(r, f"Fase 2 · semana {'AB'[w]} (desde {FASE2.strftime('%d/%m')}, alternadas)", g, [cortos_dia(i, g[i], fijos2) for i in range(6)])
    # comparación con el ciclo actual (4 al 10 de noviembre)
    actual = [(["ORTEGA", "MERCADO TAMBO"], ["SOCORRO PUNO", "SOCORRO REAL"]), (["SOCORRO REAL", "LIBERTAD"], ["TUPAC"]),
              (["PARRA", "PIOPATA"], ["SOCORRO PUNO", "SOCORRO REAL"]), (["MERCADO", "LOS HEROES"], ["ORTEGA", "SOCORRO REAL"]),
              (["SUMAR", "CONCEPCION", "ANDALUZ"], ["SOCORRO PUNO", "SOCORRO REAL"]), (["HUANCAS", "TUPAC"], ["SOCORRO REAL"])]
    r, km0 = bloque(r, "Ciclo ACTUAL (semana 4–10 nov, para comparar)", [a[0] for a in actual], [a[1] for a in actual])
    wp.cell(r, 1, "Ahorro Fase 1 vs actual").font = Font(bold=True, color="00B050")
    wp.cell(r, 2, f"{km0 - km1:.1f} km por semana ({(km0 - km1) / km0 * 100:.0f} %)").font = Font(bold=True, color="00B050")

    # 4. sucursales
    wsu = wb.create_sheet("Sucursales")
    cab = ["Sucursal", "Latitud", "Longitud", "Resultado", "Capacidad (días)", "Pedido grande", "Pedido corto", "km desde droguería"]
    for i, t in enumerate(cab):
        x = wsu.cell(1, i + 1, t)
        x.fill, x.font, x.border = CAB, NEG, BOR
    for i, w in enumerate([18, 12, 12, 10, 15, 34, 26, 18]):
        wsu.column_dimensions[get_column_letter(i + 1)].width = w
    for j, (n, s) in enumerate(suc.items()):
        fr = "No (solo cortos)" if n in SIN_GRANDE else ("Semanal; cada 15 días en Fase 2" if n in quinc else "Semanal")
        co = {"SOCORRO REAL": "Todos los días (si no hay grande)", "SOCORRO PUNO": "Lun, mié y vie", "ORTEGA": "1 vez por semana", "TUPAC": "1 vez por semana"}.get(n, "")
        for i, v in enumerate([n, round(s["lat"], 6), round(s["lon"], 6), s["res"], s["cap"], fr, co, round(km(R.p[DROGUERIA[0]], R.p[n]), 1)]):
            wsu.cell(j + 2, i + 1, v).border = BOR
    j += 3
    wsu.cell(j, 1, DROGUERIA[0]).font = NEG
    wsu.cell(j, 2, DROGUERIA[1])
    wsu.cell(j, 3, DROGUERIA[2])
    wsu.cell(j, 4, "punto de salida (Jr. Lima 284)")

    # 5. distancias
    wd = wb.create_sheet("Distancias (km)")
    ns = [DROGUERIA[0], *suc]
    for i, n in enumerate(ns):
        for c in ((1, i + 2), (i + 2, 1)):
            x = wd.cell(*c, nc(n))
            x.fill, x.font, x.border = CAB, NEG, BOR
        for k, m in enumerate(ns):
            x = wd.cell(i + 2, k + 2, round(km(R.p[n], R.p[m]), 1))
            x.border = BOR
    wd.column_dimensions["A"].width = 14
    wb.save(salida)
    print(f"Fase 1: {km1:.1f} km/semana · actual: {km0:.1f} km/semana · ahorro {km0 - km1:.1f} km")
    for i in range(6):
        print(DIAS[i], [nc(s) for s in g1[i]], [nc(s) for s in cortos_dia(i, g1[i], fijos1)], f"{R.mejor(g1[i] + cortos_dia(i, g1[i], fijos1))[0]:.1f} km")
    for w in range(2):
        print("Fase 2 semana", "AB"[w])
        for i in range(6):
            g = [s for s, (ww, d) in a2.items() if d == i and (s in seman or ww == w)]
            print(" ", DIAS[i], [nc(s) for s in g], [nc(s) for s in cortos_dia(i, g, fijos2)], f"{R.mejor(g + cortos_dia(i, g, fijos2))[0]:.1f} km")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
