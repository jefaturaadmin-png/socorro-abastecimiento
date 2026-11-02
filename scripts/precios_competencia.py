"""
Precios de la competencia (Mifarma, Boticas Perú, Farmacias Líder, Inkafarma, Farmacias Universo y Boticas y Salud) para el módulo Comparativo.

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


# ============================ FARMACIAS LÍDER ============================
FL = "https://farmaciaslider.pe"


def fl_tarjetas(html, out):
    """Lee las tarjetas de producto de una página de categoría o de búsqueda."""
    soup = BeautifulSoup(html, "html.parser")
    nuevos = 0
    for card in soup.select("div.card-body"):
        a = card.select_one("h3.product-name a")
        pre = card.select_one(".preciocatalogo")
        if not a or not pre:
            continue
        m = re.search(r"/product/[^/]+/(\w+)/?$", a.get("href", ""))
        if not m or m.group(1) in out:
            continue
        precio = num(re.sub(r"[^\d.]", "", pre.get_text().replace(",", "")))
        if not precio:
            continue
        antes = card.select_one(".product-price del")
        antes = num(re.sub(r"[^\d.]", "", antes.get_text().replace(",", ""))) if antes else None
        nombre = a.get_text(strip=True)
        unidad = card.select_one("#productname2")
        marca = nombre.rsplit(" - ", 1)[1] if " - " in nombre else None
        # si hay precio tachado, el regular es el tachado y "precio" es la oferta
        out[m.group(1)] = [nombre, marca, unidad.get_text(strip=True) if unidad else None, unidades(nombre),
                           antes or precio, precio if antes and antes > precio else None, None, a["href"]]
        nuevos += 1
    return nuevos


def farmaciaslider():
    out = {}
    r = pedir(FL + "/")
    cats = list(dict.fromkeys(re.findall(r'href="(https://farmaciaslider\.pe/category/p/[^"]+)"', r.text if r else "")))
    print(f"Farmacias Líder: {len(cats)} categorías")
    for i, c in enumerate(cats):
        rr = pedir(c)
        if rr is not None and rr.status_code == 200:
            fl_tarjetas(rr.text, out)
        if i % 20 == 0:
            print(f"  categoría {i + 1}/{len(cats)} · {len(out)} productos")
        time.sleep(PAUSA)
    # Por si alguna categoría no trae todo: búsquedas amplias (el buscador devuelve todo sin páginas)
    for q in list("aeiou") + ["x", "mg", "ml"]:
        rr = pedir(FL + "/category_product_search", params={"product_name": q})
        if rr is not None and rr.status_code == 200:
            n = fl_tarjetas(rr.text, out)
            print(f"  búsqueda '{q}': +{n} · total {len(out)}")
        time.sleep(PAUSA)
    return out


# ============================ INKAFARMA ============================
# Misma plataforma que Mifarma (mismo dueño): sitemap con /producto/<slug>/<id> y la API de productos con otra compañía.
IK = "https://inkafarma.pe"
IK_APIS = [("https://5doa19p9r7.execute-api.us-east-1.amazonaws.com/MMPROD/products/", "IKF"),
           ("https://5doa19p9r7.execute-api.us-east-1.amazonaws.com/MMMFPRD/products/", "IKF"),
           ("https://5doa19p9r7.execute-api.us-east-1.amazonaws.com/MMIKPRD/products/", "IKF")]


def ik_codigos():
    urls, pendientes, vistos = [], [IK + "/sitemap.xml", "https://www.inkafarma.pe/sitemap.xml"], set()
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


def inkafarma():
    cods = ik_codigos()
    print(f"Inkafarma: {len(cods)} códigos en el sitemap")
    if not cods:
        return {}
    head = dict(MF_HEAD, origin=IK, referer=IK + "/")
    api = None
    for url, comp in IK_APIS:   # se prueba cuál responde
        r = pedir(url + ",".join(cods[:20]), params=dict(MF_PARAMS, companyCode=comp), headers=head)
        print("  probando", url, comp, "->", None if r is None else r.status_code)
        if r is not None and r.status_code == 200 and isinstance(r.json(), list) and r.json():
            api = (url, comp); break
    if not api:
        return {}
    out = {}
    for i in range(0, len(cods), 20):
        lote = cods[i:i + 20]
        r = pedir(api[0] + ",".join(lote), params=dict(MF_PARAMS, companyCode=api[1]), headers=head)
        if r is None or r.status_code != 200:
            continue
        for p in r.json():
            precio = num(p.get("price"))
            if not precio:
                continue
            out[p["id"]] = [p.get("name"), p.get("brand"), p.get("noFractionatedText"), p.get("quantityUnits") or None,
                            precio, num(p.get("priceAllPaymentMethod")), num(p.get("priceWithpaymentMethod")),
                            f"{IK}/producto/{p.get('slug')}/{p['id']}"]
        if i // 20 % 50 == 0:
            print(f"  {i + len(lote)}/{len(cods)} · {len(out)} con precio")
        time.sleep(PAUSA)
    return out


# ============================ TIENDAS CON PLATAFORMA COMÚN ============================
# Farmacias Universo y Boticas y Salud: se prueba en cada dominio si la tienda es Shopify, VTEX o WooCommerce
# (las tres tienen un listado público de productos); si ninguna responde, se leen las páginas de producto del sitemap.
def shopify(base):
    out, page = {}, 1
    while page < 400:
        r = pedir(f"{base}/products.json", params={"limit": 250, "page": page})
        if not r or r.status_code != 200 or "products" not in r.text[:50]:
            break
        prods = r.json().get("products", [])
        if not prods:
            break
        for p in prods:
            v = (p.get("variants") or [{}])[0]
            precio, antes = num(v.get("price")), num(v.get("compare_at_price"))
            if precio:
                out[str(p["id"])] = [p.get("title"), p.get("vendor"), None, unidades(p.get("title")),
                                     antes or precio, precio if antes and antes > precio else None, None, f"{base}/products/{p.get('handle')}"]
        page += 1
        time.sleep(PAUSA)
    return out


def vtex(base):
    out, desde = {}, 0
    while desde < 20000:
        r = pedir(f"{base}/api/catalog_system/pub/products/search", params={"_from": desde, "_to": desde + 49})
        if not r or r.status_code not in (200, 206):
            break
        try:
            prods = r.json()
        except ValueError:
            break
        if not isinstance(prods, list) or not prods:
            break
        for p in prods:
            try:
                of = p["items"][0]["sellers"][0]["commertialOffer"]
            except (KeyError, IndexError, TypeError):
                continue
            precio, antes = num(of.get("Price")), num(of.get("ListPrice"))
            if precio:
                out[str(p.get("productId"))] = [p.get("productName"), p.get("brand"), None, unidades(p.get("productName")),
                                                antes or precio, precio if antes and antes > precio else None, None, p.get("link")]
        desde += 50
        time.sleep(PAUSA)
    return out


def woo(base):
    out, page = {}, 1
    while page < 400:
        r = pedir(f"{base}/wp-json/wc/store/v1/products", params={"per_page": 100, "page": page})
        if not r or r.status_code != 200:
            break
        try:
            prods = r.json()
        except ValueError:
            break
        if not isinstance(prods, list) or not prods:
            break
        for p in prods:
            pr = p.get("prices") or {}
            div = 10 ** int(pr.get("currency_minor_unit", 2) or 2)
            precio = num((float(pr.get("price") or 0)) / div)
            antes = num((float(pr.get("regular_price") or 0)) / div)
            marca = ((p.get("brands") or [{}])[0] or {}).get("name") if p.get("brands") else None
            if precio:
                out[str(p["id"])] = [unescape(p.get("name") or ""), marca, None, unidades(p.get("name")),
                                     antes or precio, precio if antes and antes > precio else None, None, p.get("permalink")]
        page += 1
        time.sleep(PAUSA)
    return out


def jsonld(base, maximo=6000):
    """Último recurso: lee las páginas de producto del sitemap y toma el Product de su JSON-LD."""
    urls, pendientes, vistos = [], [base + "/sitemap.xml", base + "/sitemap_index.xml"], set()
    while pendientes and len(vistos) < 200:
        u = pendientes.pop()
        if u in vistos:
            continue
        vistos.add(u)
        r = pedir(u)
        if not r or r.status_code != 200:
            continue
        locs = re.findall(r"<loc>\s*(.*?)\s*</loc>", r.text)
        if "<sitemapindex" in r.text:
            pendientes.extend(l for l in locs if "product" in l or "producto" in l or "sitemap" in l)
        else:
            urls.extend(l for l in locs if re.search(r"/(product|producto|p)/|/p$|\.html$", l))
    out = {}
    for i, u in enumerate(dict.fromkeys(urls)):
        if i >= maximo:
            break
        r = pedir(u, intentos=2)
        if not r or r.status_code != 200:
            continue
        for bloque in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', r.text, re.S):
            try:
                d = json.loads(bloque)
            except ValueError:
                continue
            for x in (d if isinstance(d, list) else d.get("@graph", [d])):
                if not isinstance(x, dict) or x.get("@type") not in ("Product", ["Product"]):
                    continue
                of = x.get("offers") or {}
                of = of[0] if isinstance(of, list) and of else of
                precio = num(of.get("price") or of.get("lowPrice")) if isinstance(of, dict) else None
                marca = x.get("brand")
                marca = marca.get("name") if isinstance(marca, dict) else marca
                if precio and x.get("name"):
                    out[u] = [unescape(x["name"]), marca, None, unidades(x["name"]), precio, None, None, u]
        if i % 200 == 0:
            print(f"  {i}/{len(urls)} páginas · {len(out)} productos")
        time.sleep(0.4)
    return out


def pistas(base, html):
    """Diagnóstico: qué plataforma y qué direcciones de API aparecen en la página y en sus scripts."""
    print("  inicio de la página:", re.sub(r"\s+", " ", html[:600]))
    scripts = re.findall(r'<script[^>]+src="([^"]+)"', html)
    print("  scripts:", scripts[:15])
    vistos = set(re.findall(r'https?://[\w.-]+/[\w./-]*(?:api|graphql|catalog|product|search)[\w./?=&-]*', html, re.I))
    for src in scripts[:8]:
        u = src if src.startswith("http") else base + "/" + src.lstrip("/")
        r = pedir(u, intentos=1)
        if r is not None and r.status_code == 200:
            vistos |= set(re.findall(r'https?://[\w.-]+/[\w./-]*(?:api|graphql|catalog|product|search)[\w./-]*', r.text, re.I))
            vistos |= {"(ruta) " + x for x in re.findall(r'["\'](/(?:api|rest|graphql)[\w./-]*)["\']', r.text)[:40]}
    for v in sorted(vistos)[:80]:
        print("   ·", v)


def generica(nombre, dominios):
    for base in dominios:
        r = pedir(base + "/", intentos=2)
        print(f"{nombre}: {base} ->", None if r is None else r.status_code)
        if r is None or r.status_code >= 400:
            continue
        for f in (shopify, vtex, woo, jsonld):
            out = f(base)
            print(f"  {f.__name__}: {len(out)} productos")
            if len(out) >= 50:
                return out
        pistas(base, r.text)
    return {}


def universo():
    return generica("Farmacias Universo", ["https://www.farmaciasuniverso.com", "https://farmaciasuniverso.com",
                                           "https://www.farmaciasuniverso.pe", "https://farmaciasuniverso.pe",
                                           "https://www.farmaciauniverso.com", "https://www.boticasuniverso.com"])


def boticasysalud():
    return generica("Boticas y Salud", ["https://www.boticasysalud.com", "https://boticasysalud.com"])


# ============================ GUARDAR ============================
def guardar(tienda, prods):
    if not prods:
        print(f"{tienda}: 0 productos; no se guarda.")
        return False
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
    tiendas = sys.argv[1:] or ["boticasperu", "farmaciaslider", "mifarma", "inkafarma", "universo", "boticasysalud"]
    ok = True
    for t in tiendas:
        try:
            ok &= guardar(t, {"mifarma": mifarma, "boticasperu": boticasperu, "farmaciaslider": farmaciaslider,
                                  "inkafarma": inkafarma, "universo": universo, "boticasysalud": boticasysalud}[t]())
        except SystemExit as e:
            print(e); ok = False
        except Exception as e:
            print(f"{t}: error {e!r}"); ok = False
    sys.exit(0 if ok else 1)
