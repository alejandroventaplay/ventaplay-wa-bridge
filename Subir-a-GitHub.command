#!/bin/zsh -il
# Sube el WA Bridge a GitHub (repo privado). El login en GitHub lo haces tú.
cd "${0:A:h}" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
REPO="alejandroventaplay/ventaplay-wa-bridge"
pausa() { read "?Enter para cerrar"; }

if ! command -v gh >/dev/null; then
  if command -v brew >/dev/null; then
    echo "Instalando GitHub CLI (gh)..."; brew install gh || { echo "Falló instalar gh"; pausa; exit 1; }
  else
    echo "Falta GitHub CLI. Instálalo desde https://cli.github.com y vuelve a abrir este archivo."; pausa; exit 1
  fi
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Inicia sesión en GitHub (se abre el navegador; el login lo haces tú):"
  gh auth login --hostname github.com --git-protocol https --web || { echo "No se completó el login"; pausa; exit 1; }
fi
gh auth setup-git >/dev/null 2>&1

if git remote get-url origin >/dev/null 2>&1; then
  echo "Subiendo cambios a $(git remote get-url origin)..."
  git push -u origin HEAD || { echo "Falló git push"; pausa; exit 1; }
elif gh repo view "$REPO" >/dev/null 2>&1; then
  git remote add origin "https://github.com/$REPO.git"
  git push -u origin HEAD || { echo "Falló git push"; pausa; exit 1; }
else
  echo "Creando $REPO (privado) y subiendo el código..."
  gh repo create "$REPO" --private --source . --remote origin --push \
    --description "VentaPlay WA Bridge: vincula un WhatsApp por QR y lee contactos y chats para migrarlos (solo lectura)" \
    || { echo "Falló crear el repo"; pausa; exit 1; }
fi

echo ""; echo "Listo: https://github.com/$REPO"
open "https://github.com/$REPO"
pausa
