#!/usr/bin/env python3
"""Lista skill instalada que aponta para skill ausente.

Uma skill que manda usar outra e nao a encontra vira instrucao morta: o agente
segue sem ela e ninguem fica sabendo. Este script cruza o texto das skills de
`.agents/skills/` com os nomes reais das skills dos repositorios de origem e
imprime o que ficou pendurado.

    python .agents/skills/check-refs.py <pasta-de-skills-de-origem> [outras-origens...]

Aceita uma ou mais pastas de origem para descobrir os nomes conhecidos.
Veja EXTERNAS.md para as excecoes documentadas.

Conta referencias marcadas (crase, negrito, barra, link ou aspas) e expressoes
como "nome skill". "how" e "why" sem essas marcas sao palavras comuns em ingles;
`**how**` conta como referencia. Sai 1 quando acha pendencia, para uso em CI.
"""

import io
import os
import re
import sys

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)))

# As duas referencias que ficam abertas de proposito (motivo no EXTERNAS.md).
ACEITAS = {("how", "interrogate"), ("triage", "setup-matt-pocock-skills")}

# Entradas descritivas do catalogo, nao chamadas do fluxo de trabalho.
CATALOGO_EXCLUIDAS = {"convex-agent", "convex-improve-convex-plugin"}


def skills_do_repo(caminho):
    """Nome de toda skill (pasta com SKILL.md) sob `caminho`."""
    nomes = set()
    for dirpath, dirs, files in os.walk(caminho):
        dirs[:] = [d for d in dirs if d != ".git"]
        if "SKILL.md" in files:
            nomes.add(os.path.basename(dirpath))
    return nomes


def apelidos(nome):
    """`principle-x` tambem e citado como `x` no texto das skills."""
    return {nome, nome[len("principle-"):]} if nome.startswith("principle-") else {nome}


def padroes(nome):
    e = re.escape(nome)
    return [
        r"`%s`" % e,
        r"\*\*%s\*\*" % e,
        r"/%s\b" % e,
        r"\.\./(?:principle-)?%s/SKILL\.md" % e,
        r"\b%s skill\b" % e,
        r'"%s"' % e,
    ]


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    for origem in argv[1:]:
        if not os.path.isdir(origem):
            print("origem inexistente: %s" % origem)
            return 2
    conhecidas = set().union(*(skills_do_repo(origem) for origem in argv[1:]))
    if not conhecidas:
        print("nenhuma skill encontrada nas origens")
        return 2
    instaladas = {
        d for d in os.listdir(RAIZ)
        if os.path.isfile(os.path.join(RAIZ, d, "SKILL.md"))
    }
    # Regex por alvo, compilada uma vez: sem isso a varredura roda em minutos.
    ausentes = sorted(a for a in conhecidas if a not in instaladas)
    regex = {
        alvo: re.compile("|".join(p for a in apelidos(alvo) for p in padroes(a)))
        for alvo in ausentes
    }
    pendentes = []
    for skill in sorted(instaladas):
        for dirpath, dirs, files in os.walk(os.path.join(RAIZ, skill)):
            dirs[:] = [d for d in dirs if d != ".git"]
            for fn in sorted(files):
                if not fn.endswith((".md", ".sh", ".yaml")):
                    continue
                caminho = os.path.join(dirpath, fn)
                with io.open(caminho, encoding="utf-8", errors="replace") as f:
                    texto = f.read()
                for alvo in ausentes:
                    if alvo == skill or (skill, alvo) in ACEITAS:
                        continue
                    # Teste barato antes da regex: o nome tem de aparecer cru.
                    curto = alvo[len("principle-"):] if alvo.startswith("principle-") else alvo
                    if alvo not in texto and curto not in texto:
                        continue
                    for i, linha in enumerate(texto.splitlines(), 1):
                        if (skill == "convex" and alvo in CATALOGO_EXCLUIDAS
                                and linha.strip().startswith("- **%s**:" % alvo)):
                            continue
                        if regex[alvo].search(linha):
                            pendentes.append((skill, alvo, caminho, i, linha.strip()))
    if not pendentes:
        print("nenhuma referencia pendurada (%d skills)" % len(instaladas))
        return 0
    for skill, alvo, caminho, i, linha in pendentes:
        print("%s -> %s ausente\n    %s:%d  %s" % (skill, alvo, caminho, i, linha[:120]))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
