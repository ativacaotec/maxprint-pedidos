#!/usr/bin/env bash
#
# Instalação do sistema de pedidos Maxprint num VPS Ubuntu.
#
# O servidor da Ativação JÁ TEM Node, MongoDB, Nginx e Certbot instalados por
# causa do painel de faturamento. Este script confere o que existe e instala só
# o que faltar, sem encostar no que já está rodando.
#
#   bash install.sh
#
set -euo pipefail

echo "== Conferindo o que já existe no servidor =="

precisa_apt=0

if command -v node >/dev/null 2>&1; then
  echo "  Node.js $(node -v) já instalado"
else
  echo "  Node.js não encontrado, vou instalar a versão 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if command -v mongod >/dev/null 2>&1; then
  echo "  MongoDB $(mongod --version | head -1 | awk '{print $3}') já instalado"
else
  echo "  MongoDB não encontrado. Instale seguindo a documentação oficial e rode este script de novo."
  exit 1
fi

if command -v nginx >/dev/null 2>&1; then
  echo "  Nginx $(nginx -v 2>&1 | awk -F/ '{print $2}') já instalado"
else
  echo "  Nginx não encontrado, vou instalar"
  precisa_apt=1
  apt-get install -y nginx
fi

if command -v certbot >/dev/null 2>&1; then
  echo "  Certbot já instalado"
else
  echo "  Certbot não encontrado, vou instalar"
  apt-get install -y certbot python3-certbot-nginx
fi

# O importador de catálogo rasteriza a página para recortar a foto de cada
# produto. Isso é feito com o pdftoppm, que vem no poppler-utils.
if command -v pdftoppm >/dev/null 2>&1; then
  echo "  poppler-utils já instalado"
else
  echo "  poppler-utils não encontrado, vou instalar (necessário para as fotos do catálogo)"
  apt-get update -qq
  apt-get install -y poppler-utils
fi

if command -v pm2 >/dev/null 2>&1; then
  echo "  pm2 já instalado"
else
  echo "  pm2 não encontrado, vou instalar"
  npm install -g pm2
fi

echo
echo "== Dependências do projeto =="
npm install --omit=dev

echo
echo "== Configuração =="
if [ -f .env ]; then
  echo "  .env já existe, não vou sobrescrever"
else
  cp .env.example .env
  SEGREDO=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
  sed -i "s|SESSION_SECRET=.*|SESSION_SECRET=$SEGREDO|" .env
  echo "  .env criado com SESSION_SECRET gerado na hora"
fi

mkdir -p public/img uploads

echo
echo "Pronto. Agora:"
echo "  1) npm run create-admin      cria o primeiro administrador"
echo "  2) pm2 start server.js --name maxprint-pedidos && pm2 save"
echo "  3) configure o Nginx e o certificado (veja o DEPLOY.md)"
echo
