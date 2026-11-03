"""Pin the official NFS-e (padrão nacional) XSD packages; preserve bytes and generate the
offline runtime catalog of @freecorps/fiscal-nfse.

Run with --download to fetch the pinned archives into .ci-results/nfse-sources.
No application/runtime path downloads schemas.
"""
from pathlib import Path
from zipfile import ZipFile
from io import BytesIO
import hashlib
import json
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".ci-results/nfse-sources"
DEST = ROOT / "packages/fiscal-nfse/schemas"
# DPS, pedido de registro de evento and the types they include. CNC, evento and NFSe are
# outside the issuing path and stay out of the catalog.
FILES = [
    "DPS_v1.01.xsd",
    "pedRegEvento_v1.01.xsd",
    "tiposComplexos_v1.01.xsd",
    "tiposEventos_v1.01.xsd",
    "tiposSimples_v1.01.xsd",
    "xmldsig-core-schema.xsd",
]
# XSD regular expressions are implicitly anchored and have no ^/$ metacharacters
# (XML Schema Part 2, appendix F). The official TSSerieDPS of the production package writes
# them anyway; a conforming validator such as libxml2 reads them as literals and refuses every
# series. The catalog keeps the original (CC BY-ND 3.0); src/schema.ts drops the BOM and the
# two anchors in memory when loading. Here the patch is only checked and recorded in the
# manifest. The produção restrita package of 2026-10-20 already writes the pattern unanchored.
SERIE_PATCH = (
    '<xs:pattern value="^0{0,4}\\d{1,5}$"/>',
    '<xs:pattern value="0{0,4}\\d{1,5}"/>',
    "TSSerieDPS: anchors ^ and $ removed when loading (literal characters in XSD regex)",
)
# One entry per pinned archive. `prefix` is the folder of the XSDs inside the ZIP.
GROUPS = [
    {
        "id": "nfse-1.01-20260209",
        "page": "https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual",
        "source": (
            "https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/"
            "nfse-esquemas_xsd-v1-01-20260209.zip"
        ),
        "archiveSha256": "e7935cbd9470527c6cc32984c1b2263e614183bf0139ce2733eaaed2de9a8072",
        "retrievedAt": "2026-10-09",
        "prefix": "Schemas/1.01/",
        "patches": {"tiposSimples_v1.01.xsd": [SERIE_PATCH]},
    },
    # Layout of NT 009 (finNFSe in infDPS, xDescServ after cNBS, IBSCBS reshaped), live in
    # produção restrita: the Sefin refused a DPS of the production package with E1235 on
    # 2026-11-02 (#197).
    {
        "id": "nfse-1.01-prodrest-20261020",
        "page": "https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita",
        "source": (
            "https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/producao-restrita/"
            "esquemas_prod_restrita_20261020.zip"
        ),
        "archiveSha256": "25fdcecc651a67a216496ab10d7566631e6ed10f721e37d62c7845dadb0ea267",
        "retrievedAt": "2026-11-02",
        "prefix": "",
        "patches": {},
    },
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pin(group, files, catalog):
    path = CACHE / (group["id"] + ".zip")
    if "--download" in sys.argv:
        request = urllib.request.Request(group["source"], headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            path.write_bytes(response.read())
    data = path.read_bytes()
    if sha(data) != group["archiveSha256"]:
        raise ValueError("Archive differs from reviewed pin: " + group["id"])
    archive = ZipFile(BytesIO(data))
    for name in FILES:
        entry = group["prefix"] + name
        raw = archive.read(entry)
        bom = raw.startswith(b"\xef\xbb\xbf")
        xml = raw.decode("utf-8-sig")
        if 'encoding="utf-8"' not in xml[:100].lower():
            raise ValueError("Unreviewed encoding declaration: " + name)
        applied = []
        for before, _after, note in group["patches"].get(name, []):
            if xml.count(before) != 1:
                raise ValueError("Patch target not found once: " + name)
            applied.append(note)
        original = raw.decode("utf-8")
        relative = group["id"] + "/" + name
        destination = DEST / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(raw)
        catalog[relative] = original
        item = {
            "path": relative,
            "archivePath": entry,
            "sha256": sha(raw),
            "byteOrderMark": bom,
            "runtimeUtf8Sha256": sha(original.encode()),
        }
        if applied:
            item["loadTimeAdjustment"] = "; ".join(applied)
        files.append(item)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    files, catalog = [], {}
    for group in GROUPS:
        pin(group, files, catalog)
    manifest = {
        "version": 2,
        "sources": [
            {
                "id": g["id"],
                "page": g["page"],
                "source": g["source"],
                "archiveSha256": g["archiveSha256"],
                "retrievedAt": g["retrievedAt"],
            }
            for g in GROUPS
        ],
        "files": files,
        "redistribution": {
            "license": "CC-BY-ND-3.0",
            "source": "Portal NFS-e (gov.br/nfse): Documentação Atual, Esquemas XSD v1.01-20260209; Documentação Técnica (Homologação/testes), Esquemas XSD de 20/10/2026",
            "attribution": "Receita Federal, Portal NFS-e, https://www.gov.br/nfse",
            "xmldsig": "W3C Software Notice and License 19980720, full text in LICENSING.md",
            "decision": "Redistributed unmodified by maintainer decision on 2026-10-20; the BOM and the TSSerieDPS anchors are adjusted in memory when loading; see LICENSING.md"
        },
    }
    (DEST / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n"
    )
    (ROOT / "packages/fiscal-nfse/src/schemas.json").write_text(
        json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n"
    )
    print(f"Pinned {len(files)} XSDs from {', '.join(g['id'] for g in GROUPS)}")


if __name__ == "__main__":
    main()
