#!/bin/zsh -il
# Lanzador VentaPlay WA Bridge (login shell para encontrar node/nvm/fnm)
cd "${0:A:h}" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$HOME/.wa-bridge-tools/bin:$PATH"

if ! command -v node >/dev/null; then
  echo "No encuentro Node. Instálalo desde https://nodejs.org (versión 22 o más) y vuelve a abrir este archivo."
  read "?Enter para cerrar"; exit 1
fi
echo "Node $(node -v)"

if ! command -v pnpm >/dev/null; then
  echo "Instalando pnpm (una sola vez)..."
  npm install -g pnpm@10 --prefix "$HOME/.wa-bridge-tools" || { echo "Falló instalar pnpm"; read "?Enter para cerrar"; exit 1; }
  export PATH="$HOME/.wa-bridge-tools/bin:$PATH"
fi
echo "pnpm $(pnpm -v)"

pnpm install || { echo "Falló pnpm install"; read "?Enter para cerrar"; exit 1; }
(sleep 8; open "http://localhost:5190") &
pnpm dev
echo "El servidor se detuvo."; read "?Enter para cerrar"
