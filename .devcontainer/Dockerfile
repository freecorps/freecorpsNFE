# Ambiente de desenvolvimento do freecorpsNFE (docs/worktrees.md#devcontainer).
# As versões acompanham package.json e apps/console/package.json;
# tests/ci.devcontainer.test.ts falha quando divergem. Debian 13 porque o backend
# local do Convex exige glibc 2.39 ou mais nova; o Debian 12 traz a 2.36.
FROM mcr.microsoft.com/devcontainers/javascript-node:24-trixie@sha256:375f1ba34dab874ae487acb0b2bb3e9fd1b67fe3ea6e80c16e35713487f47c6a

ARG BUN_VERSION=1.4.0
ARG VP_VERSION=1.4.0
ARG PLAYWRIGHT_VERSION=1.64.1

# Bibliotecas do sistema que o Chromium do Playwright exige. O navegador em si
# é baixado no worktree, pela versão do lockfile, porque mora no cache do usuário.
RUN npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm

USER node
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
# O Node vem da imagem; o Vite+ não instala outro.
RUN curl -fsSL https://vite.plus | VP_VERSION="${VP_VERSION}" VP_NODE_MANAGER=no bash
ENV PATH="/home/node/.bun/bin:/home/node/.local/share/vite-plus/bin:${PATH}"

# Ponto de montagem do volume dos worktrees. Criado aqui para o volume novo
# nascer com o dono do usuário, e não do root.
RUN mkdir -p /home/node/worktrees
