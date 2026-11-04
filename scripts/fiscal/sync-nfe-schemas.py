"""Pin official XSD archives; preserve bytes and generate an offline runtime catalog.

Run with --download to fetch the pinned archives into .ci-results/69-sources.
No application/runtime path downloads schemas. Each package's decision and the dated survey of
the portal are in docs/plataforma/NFE-SCHEMAS.md and packages/fiscal-nfe/schemas/portal-survey.json;
`bun run xml:portal` reports a new, withdrawn or changed package.
"""
from pathlib import Path
from zipfile import ZipFile
from io import BytesIO
from http.cookiejar import CookieJar
import hashlib
import json
import re
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".ci-results/69-sources"
DEST = ROOT / "packages/fiscal-nfe/schemas"
RETRIEVED_AT = "2026-10-26"
# (cache name, portal code, nested zip, local package, archive folder taken, renames).
# `folder` keeps only the XSDs under that path of the archive: PL_010d_v1.03 also ships the
# NF-e and CCC layouts, which are not the events package. A rename fixes only a file name
# the portal published with a typo; the bytes stay intact and `archivePath` keeps the original.
# `folder` may be a tuple of prefixes: from PL_010g's Evento/ only the 110300 detail and the
# tiposBasico_v1.03.xsd it includes (it adds TCnpjBase) enter; e110001 stays out because the
# platform does not accept event cancellation (docs/plataforma/NFE-SCHEMAS.md).
SOURCES = [
    ("PL_010g_v1.03", "EQhOQMgipXY=", None, "nfe-4.00-010g",
     ("PL_010g_v1.03/NFe/", "PL_010g_v1.03/Evento/e110300_v1.00.xsd",
      "PL_010g_v1.03/Evento/tiposBasico_v1.03.xsd"), {}),
    ("PL_010d_v1.03", "+pBOYTXBtbk=", None, "events-1.00-alphanumeric", "PL_010d_v1.03/Evento/", {}),
    ("distribution", "0Yynu2Ck+bM=", None, "cancellation-1.01", None, {}),
    ("dfe-1.04", "IzuP2y0G6hk=", None, "distribution-1.04", None, {}),
    ("cce-1.01", "+0MSTVshMl8=", None, "correction-1.01", None, {}),
    ("manifestation-1.01", "Q7x6aqhBAy4=", None, "manifestation-1.01", None, {}),
    ("rtc-events-1.40", "kp0SXLu+ZdI=", None, "rtc-events-1.40", "Eventos_RTC/",
     {"e112120_v1.00 .xsd": "e112120_v1.00.xsd"}),
]

PINNED = {'nfe-4.00-010g': 'b329ecbe7e4c05a41bfbc1527f105defb7047328acfeada7c77e1666da485eaf', 'events-1.00-alphanumeric': '45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b', 'cancellation-1.01': '71ccd5fcc48f9604a2a8965146df45e3b73e96e87942ab3391be0d55cc0df718', 'distribution-1.04': '9bd6d478dd04770016783a914111f3e2cc794c6a2f2b62ac7243fb101c138740', 'correction-1.01': 'c300695ae3344dcb0c000ec806559e7392c54f7be99599274965050112771f77', 'manifestation-1.01': '05877dd4a4a42ea7e1b251a2c2ecc365d3c73f3a1a9794760486db7cbe2a116e', 'rtc-events-1.40': 'a4c57ce95b225cd8852f90bd6c39ca28ae551636ff3f67eb2602b9fa847129b2'}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def decimal_fields(catalog, layout):
    """Decimal policy of the NF-e layout. `layout` holds only the paths taken from the archive's
    NFe/ folder, so an event detail pinned in the same local package cannot change the policy."""
    import xml.etree.ElementTree as ET
    ns = "{http://www.w3.org/2001/XMLSchema}"
    if "nfe-4.00-010g/leiauteNFe_v4.00.xsd" not in layout:
        raise ValueError("Decimal policy without the NF-e layout")
    roots = [ET.fromstring(catalog[path]) for path in sorted(layout)]
    complex_types = {n.get("name"): n for root in roots for n in root.findall(ns + "complexType")}
    groups = {n.get("name"): n for root in roots for n in root.findall(ns + "group")}
    result = {}
    def walk(node, path, stack=()):
        for item in node:
            kind = item.tag.removeprefix(ns)
            if kind == "element":
                name, type_name = item.get("name"), item.get("type", "").split(":")[-1]
                if not name:
                    continue
                field = path + "." + name
                if type_name.startswith("TDec"):
                    if "03v00a04" in type_name:
                        scale = 4
                    elif "0302a04" in type_name or "0302_04" in type_name:
                        scale = 4
                    else:
                        match = re.match(r"TDec_?\d{2}(\d{2})", type_name)
                        if not match:
                            raise ValueError("Unreviewed decimal type " + type_name)
                        scale = int(match[1])
                    result[field] = {"scale": scale, "xsdType": type_name}
                elif name == "pICMSInter":
                    result[field] = {"scale": 2, "xsdType": "inline-pICMSInter"}
                if type_name in complex_types and type_name not in stack:
                    walk(complex_types[type_name], field, stack + (type_name,))
                walk(item, field, stack)
            elif kind == "group" and item.get("ref") in groups:
                walk(groups[item.get("ref")], path, stack)
            elif kind not in ("annotation", "simpleType"):
                walk(item, path, stack)
    layout = ET.fromstring(catalog["nfe-4.00-010g/leiauteNFe_v4.00.xsd"])
    for node in layout.iter(ns + "element"):
        if node.get("name") in ("imposto", "total"):
            walk(node, node.get("name"))
    return dict(sorted(result.items()))

def main():
    from urllib.parse import quote
    CACHE.mkdir(parents=True, exist_ok=True)
    DEST.mkdir(parents=True, exist_ok=True)
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    archives, files, catalog = [], [], {}
    for name, code, nested, group, folder, renames in SOURCES:
        url = "https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=" + quote(code, safe="")
        path = CACHE / (name + ".zip")
        if "--download" in sys.argv:
            with opener.open(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as response:
                path.write_bytes(response.read())
        data = path.read_bytes()
        if sha(data) != PINNED[group]:
            raise ValueError("Archive differs from reviewed pin: " + group)
        archives.append({"id": group, "source": url, "archiveSha256": sha(data), "nested": nested})
        archive = ZipFile(BytesIO(data))
        if nested:
            archive = ZipFile(BytesIO(archive.read(nested)))
        for entry in sorted(archive.namelist()):
            if not entry.endswith(".xsd") or (folder and not entry.startswith(folder)):
                continue
            raw = archive.read(entry)
            encoding = re.search(br'encoding=[\"\x27]([^\"\x27]+)', raw[:150])
            declared = encoding[1].decode() if encoding else "utf-8-sig"
            decoded = declared
            try:
                xml = raw.decode(declared)
            except UnicodeDecodeError:
                # Some legacy official schemas declare UTF-8 but contain Latin-1 comments.
                # Preserve their bytes; record the explicit conversion used by the runtime.
                decoded = "iso-8859-1"
                xml = raw.decode(decoded)
            xml = re.sub(r'encoding=[\"\x27][^\"\x27]+[\"\x27]', 'encoding="UTF-8"', xml, count=1)
            relative = group + "/" + renames.get(Path(entry).name, Path(entry).name)
            if relative in catalog:
                raise ValueError("Two archive entries map to " + relative)
            destination = DEST / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
            catalog[relative] = xml
            files.append({"path": relative, "sourceArchive": group, "archivePath": entry,
                          "sha256": sha(raw), "declaredEncoding": declared, "decodedEncoding": decoded,
                          "runtimeUtf8Sha256": sha(xml.encode())})
    ns = "http://www.portalfiscal.inf.br/nfe"
    wrapper = lambda root, type_name, include: f'<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="{ns}" targetNamespace="{ns}" elementFormDefault="qualified"><xs:include schemaLocation="{include}"/><xs:element name="{root}" type="{type_name}"/></xs:schema>'
    derived = {
        "nfe-4.00-010g/procNFe_v4.00.xsd": (wrapper("nfeProc", "TNfeProc", "leiauteNFe_v4.00.xsd"), "Local entrypoint for official TNfeProc"),
        "events-1.00-alphanumeric/evento_v1.00.xsd": (wrapper("evento", "TEvento", "leiauteEvento_v1.00.xsd"), "Local entrypoint for official TEvento"),
        "distribution-1.04/xmldsig-core-schema_v1.01.xsd": (catalog["nfe-4.00-010g/xmldsig-core-schema_v1.01.xsd"], "Offline alias of nfe-4.00-010g/xmldsig-core-schema_v1.01.xsd"),
    }
    for path, (xml, origin) in derived.items():
        if path in catalog:
            raise ValueError("Derived entry shadows official source: " + path)
        catalog[path] = xml
        raw = xml.encode()
        (DEST / path).write_bytes(raw)
        files.append({"path": path, "sourceArchive": None, "derivedOrigin": origin, "sha256": sha(raw), "declaredEncoding": "utf-8", "decodedEncoding": "utf-8", "runtimeUtf8Sha256": sha(raw)})
    manifest = {"version": 1, "retrievedAt": RETRIEVED_AT, "sources": archives, "files": files,
                "redistribution": {"license": "not-explicitly-stated",
                                   "source": "Official NF-e portal archives (ENCAT, state finance secretariats and Receita Federal)",
                                   "xmldsig": "W3C Software Notice and License 19980720, full text in LICENSING.md",
                                   "decision": "Redistributed unmodified by maintainer decision on 2026-10-20; see LICENSING.md"}}
    (DEST / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    (ROOT / "packages/fiscal-nfe/src/schemas.json").write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    derived = {"catalogSha256": sha(json.dumps(catalog, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()), "decimalFields": decimal_fields(catalog, {f["path"] for f in files if (f.get("archivePath") or "").startswith("PL_010g_v1.03/NFe/")})}
    (ROOT / "packages/fiscal-nfe/src/schema-policy.json").write_text(json.dumps(derived, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"Pinned {len(files)} XSDs from {len(archives)} official archives")

if __name__ == "__main__":
    main()
