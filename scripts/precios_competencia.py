"""
Precios de la competencia (Mifarma y Boticas Perú) para el módulo Comparativo.

Lo ejecuta GitHub Actions cada noche (.github/workflows/precios.yml) y guarda en data/competencia/:
  mifarma.json / boticasperu.json   -> catálogo de hoy  {"fecha": "...", "p": {id: [nombre, marca, presentación, unidades, precio, oferta, tarjeta, url]}}
  hist-mifarma.json / hist-boticasperu.json -> historial {id: [[fecha, precio, oferta], ...]}  (solo se agrega una fila cuando el precio cambia)

También se puede correr a mano:  python scripts/precios_competencia.py  [mifarma|boticasperu]
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from html import unescape
from pathlib import Path

import requests
from bs4 import BeautifulSoup

CARPETA = Path(__file__).resolve().parent.parent / "data" / "competencia"
HOY = (datetime.now(timezone.utc) - timedelta(hours=5)).strftime("%Y-%m-%d")   # fecha de Lima
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
PAUSA = 1.0   # segundos entre consultas, para no saturar los sitios

sesion = requests.Session()
sesion.headers["user-agent"] = UA


def num(v):
    try:
        x = float(v)
        return round(x, 2) if x > 0 else None
    except (TypeError, ValueError):
        return None


def pedir(url, intentos=4, **kw):
    """GET con reintentos (errores de red o 429/5xx)."""
    for i in range(intentos):
        try:
            r = sesion.get(url, timeout=60, **kw)
            if r.status_code < 500 and r.status_code != 429:
                return r
        except requests.RequestException as e:
            print("  error de red:", e)
        time.sleep(5 * (i + 1))
    return None


# ============================ MIFARMA ============================
MF_API = "https://5doa19p9r7.execute-api.us-east-1.amazonaws.com/MMMFPRD/products/"
MF_PARAMS = {"companyCode": "MF", "saleChannel": "WEB", "saleChannelType": "DIGITAL"}
MF_HEAD = {"accept": "application/json, text/plain, */*", "origin": "https://www.mifarma.com.pe",
           "referer": "https://www.mifarma.com.pe/", "drugstore-stock": "1253", "deliverytype": "PROG"}


def mf_token():
    """Token de visitante anónimo (el mismo que la web le da a cualquiera). Necesita MIFARMA_API_KEY."""
    clave = os.environ.get("MIFARMA_API_KEY", "").strip()
    if not clave:
        return None
    r = sesion.post("https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + clave,
                    json={"returnSecureToken": True}, headers={"referer": "https://www.mifarma.com.pe/"}, timeout=30)
    r.raise_for_status()
    return r.json()["idToken"]


def mf_codigos():
    urls, pendientes, vistos = [], ["https://www.mifarma.com.pe/sitemap.xml"], set()
    while pendientes:
        u = pendientes.pop()
        if u in vistos:
            continue
        vistos.add(u)
        r = pedir(u)
        if not r or r.status_code != 200:
            print("  sitemap no disponible:", u)
            continue
        locs = re.findall(r"<loc>\s*(.*?)\s*</loc>", r.text)
        (pendientes if "<sitemapindex" in r.text else urls).extend(locs)
        time.sleep(PAUSA)
    cods = [m.group(1) for u in urls if (m := re.search(r"/producto/[^/]+/(\w+)/?$", u))]
    return list(dict.fromkeys(cods))


def mifarma():
    cods = mf_codigos()
    print(f"Mifarma: {len(cods)} códigos en el sitemap")
    head = dict(MF_HEAD)
    tok = mf_token()
    if tok:
        head["x-access-token"] = tok
    out, renovado = {}, time.time()
    for i in range(0, len(cods), 20):
        lote = cods[i:i + 20]
        if tok and time.time() - renovado > 45 * 60:          # el token dura 1 hora
            head["x-access-token"] = tok = mf_token(); renovado = time.time()
        r = pedir(MF_API + ",".join(lote), params=MF_PARAMS, headers=head)
        if r is not None and r.status_code in (401, 403) and os.environ.get("MIFARMA_API_KEY"):
            head["x-access-token"] = tok = mf_token(); renovado = time.time()
            r = pedir(MF_API + ",".join(lote), params=MF_PARAMS, headers=head)
        if r is None or r.status_code != 200:
            print("  lote falló:", None if r is None else r.status_code)
            if r is not None and r.status_code in (401, 403):
                raise SystemExit("Mifarma pide token: configura el secreto MIFARMA_API_KEY.")
            continue
        for p in r.json():
            precio = num(p.get("price"))
            if not precio:
                continue
            out[p["id"]] = [p.get("name"), p.get("brand"), p.get("noFractionatedText"), p.get("quantityUnits") or None,
                            precio, num(p.get("priceAllPaymentMethod")), num(p.get("priceWithpaymentMethod")),
                            f"https://www.mifarma.com.pe/producto/{p.get('slug')}/{p['id']}"]
        if i // 20 % 50 == 0:
            print(f"  {i + len(lote)}/{len(cods)} · {len(out)} con precio")
        time.sleep(PAUSA)
    return out


# ============================ BOTICAS PERÚ ============================
BP = "https://www.boticasperu.pe"
BP_GRID = BP + "/on/demandware.store/Sites-BoticasPeru-Site/es_PE/Search-UpdateGrid"


def unidades(nombre):
    m = re.search(r"(\d+)\s*(UN|UND|TAB|CAP|SOB|AMP|COMP)\b", nombre or "", re.I)
    return int(m.group(1)) if m else None


def boticasperu():
    out, start, SZ = {}, 0, 60
    while True:
        r = pedir(BP_GRID, params={"cgid": "root", "start": start, "sz": SZ})
        if not r or r.status_code != 200:
            print("  Boticas Perú dejó de responder en", start)
            break
        soup = BeautifulSoup(r.text, "html.parser")
        nuevos = 0
        for div in soup.select("div.product[data-pid]"):
            a = div.select_one(".pdp-link a")
            if not a or div["data-pid"] in out:
                continue
            ga = {}
            try:
                ga = json.loads(unescape(a.get("data-ga", "")))["ecommerce"]["items"][0]
            except Exception:
                pass
            venta = div.select_one(".sales .value")
            antes = div.select_one(".strike-through .value, .list .value")
            precio = num(venta.get("content")) if venta else None
            precio = precio or num(ga.get("price"))
            if not precio:
                continue
            nombre = a.get_text(strip=True)
            pres = nombre.rsplit(" - ", 1)[1] if " - " in nombre else None
            regular = num(antes.get("content")) if antes else None
            # Si hay precio tachado, "precio" es la oferta y el regular es el tachado
            out[div["data-pid"]] = [nombre, ga.get("item_brand"), pres, unidades(pres or nombre),
                                    regular or precio, precio if regular else None, None, BP + a["href"]]
            nuevos += 1
        if nuevos == 0:
            break
        if start // SZ % 20 == 0:
            print(f"  Boticas Perú: {len(out)} productos")
        start += SZ
        time.sleep(PAUSA)
    return out


# ============================ GUARDAR ============================
def guardar(tienda, prods):
    CARPETA.mkdir(parents=True, exist_ok=True)
    f_cat, f_hist = CARPETA / f"{tienda}.json", CARPETA / f"hist-{tienda}.json"
    previo = json.loads(f_cat.read_text("utf-8")) if f_cat.exists() else {"p": {}}
    # Seguro: si hoy salió mucho menos que la última vez, algo falló; no se pisa lo bueno.
    if previo["p"] and len(prods) < 0.6 * len(previo["p"]):
        print(f"{tienda}: solo {len(prods)} productos (antes {len(previo['p'])}); NO se guarda.")
        return False
    hist = json.loads(f_hist.read_text("utf-8")) if f_hist.exists() else {}
    cambios = 0
    for pid, p in prods.items():
        fila = [HOY, p[4], p[5]]
        h = hist.setdefault(pid, [])
        if not h or h[-1][1:] != fila[1:]:
            h.append(fila); cambios += 1
    f_cat.write_text(json.dumps({"fecha": HOY, "p": prods}, ensure_ascii=False, separators=(",", ":")), "utf-8")
    f_hist.write_text(json.dumps(hist, ensure_ascii=False, separators=(",", ":")), "utf-8")
    print(f"{tienda}: {len(prods)} productos guardados · {cambios} precios nuevos o cambiados")
    return True


if __name__ == "__main__":
    tiendas = sys.argv[1:] or ["boticasperu", "mifarma"]
    ok = True
    for t in tiendas:
        try:
            ok &= guardar(t, {"mifarma": mifarma, "boticasperu": boticasperu}[t]())
        except SystemExit as e:
            print(e); ok = False
        except Exception as e:
            print(f"{t}: error {e!r}"); ok = False
    sys.exit(0 if ok else 1)
