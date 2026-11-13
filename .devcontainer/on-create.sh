#!/usr/bin/env bash
# Prepara o container uma vez, na criação (docs/worktrees.md#devcontainer).
# O clone aberto é o checkout principal, onde `bun run dev` recusa; o trabalho
# fica num worktree em $FNFE_WORKTREES_DIR, um volume que sobrevive ao rebuild.
set -euo pipefail

target="${FNFE_WORKTREES_DIR:?}/devcontainer"

# O clone montado do host chega com outro dono (root, no Docker Desktop), e o
# Git recusa repositório alheio. Só este caminho é liberado; o worktree mora no
# volume, é do usuário `node` e não precisa disso.
git config --global --add safe.directory "$(pwd)"

if [ -e "$target/.git" ]; then
  # Rebuild com o volume preservado: o worktree e o banco local continuam.
  (cd "$target" && bun run worktree:setup)
else
  # Volume novo com clone antigo: o `.git` ainda registra o worktree que
  # morava no volume apagado. Sai só esse registro, sem `git worktree prune`.
  if git worktree list --porcelain | grep -qxF "worktree $target"; then
    git worktree remove --force "$target"
  fi
  bun run worktree:create devcontainer --from HEAD
fi

(cd "$target" && node apps/console/node_modules/playwright/cli.js install chromium)

echo
echo "Pronto. Abra $target no editor e rode: bun run dev"
