#!/usr/bin/env bash
#
# Publica o código do servidor no GitHub.
#
# Você cola o token aqui dentro do servidor. Ele NÃO aparece na tela, não fica
# no histórico do shell e não é gravado em disco — é a mesma forma que usamos
# para a chave do Resend.
#
#   bash publicar-no-github.sh
#
set -euo pipefail

REPO="ativacaotec/maxprint-pedidos"
PASTA="/root/maxprint-pedidos"

cd "$PASTA"

echo
echo "  Publicar o sistema no GitHub ($REPO)"
echo "  ---------------------------------------------------------"
echo
echo "  Você vai precisar de um token do GitHub com permissão de escrita"
echo "  neste repositório. Para criar:"
echo
echo "    github.com  →  Settings  →  Developer settings"
echo "    →  Personal access tokens  →  Tokens (classic)"
echo "    →  Generate new token (classic)"
echo "    →  marque o escopo  repo   →  Generate"
echo
echo "  Copie o token (começa com ghp_) e cole abaixo."
echo

read -rsp "  Token: " TOKEN
echo
echo

if [ -z "$TOKEN" ]; then
  echo "  Nenhum token informado. Nada foi feito."
  exit 1
fi

# ------------------------------------------------------------------
# Prepara o repositório local
# ------------------------------------------------------------------

if [ ! -d .git ]; then
  echo "  · iniciando o repositório local"
  git init -q
  git branch -M main
fi

git config user.email "ia.ativacao@gmail.com"
git config user.name "Ativacao"

# Garante que arquivo pesado e segredo não entrem, mesmo se o .gitignore
# tiver ficado para trás.
for padrao in "node_modules/" ".env" "public/img/" "uploads/" "*.bak.*"; do
  grep -qxF "$padrao" .gitignore 2>/dev/null || echo "$padrao" >> .gitignore
done

echo "  · conferindo o que vai subir"
git add -A

# Três situações diferentes, e confundi-las já custou caro aqui:
#   a) há mudanças novas          -> commita e envia
#   b) nada novo, mas há commit   -> só envia (era o caso depois de uma
#      local ainda não enviado       publicação feita direto no servidor)
#   c) nada novo e nada pendente  -> não faz nada
PENDENTES=$(git rev-list --count @{u}..HEAD 2>/dev/null || echo 0)

if git diff --cached --quiet 2>/dev/null; then
  if [ "$PENDENTES" -gt 0 ]; then
    echo "    nenhum arquivo novo, mas há $PENDENTES commit(s) ainda não enviado(s)"
  else
    echo
    echo "  Nada mudou desde a última publicação. Nada a fazer."
    exit 0
  fi
else

ARQUIVOS=$(git diff --cached --name-only | wc -l)
echo "    $ARQUIVOS arquivo(s)"

# Trava de segurança: se um .env escapar, paro tudo.
if git diff --cached --name-only | grep -qx ".env"; then
  echo
  echo "  PAREI: o arquivo .env entrou no pacote e ele tem a chave do e-mail."
  echo "  Rode:  git rm --cached .env    e tente de novo."
  exit 1
fi

git commit -q -m "Sistema multimarca: Samsonite ao lado da Maxprint

- modelo de Marca (cor, logo, condicoes de prazo, pedido minimo, frete CIF)
- Produto/Usuario/Pedido passam a ter marca; clientes antigos seguem so na Maxprint
- catalogo do cliente com abas por marca, carrinho separado e cores no card
- importacao da Samsonite no painel, em segundo plano
- prazos 60/90, 90 e 60/90/120 liberados acima de R\$ 15.000
- aviso de pedido por e-mail com o nome da marca
- telas responsivas para celular"

fi

echo "  · enviando"

# O token entra só na chamada do push e sai logo depois: não fica gravado no
# remote nem no .git/config.
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/${REPO}.git"

if git push -q "https://${TOKEN}@github.com/${REPO}.git" main --force-with-lease 2>/dev/null \
   || git push -q "https://${TOKEN}@github.com/${REPO}.git" main; then
  echo
  echo "  Pronto. Código publicado em https://github.com/${REPO}"
else
  echo
  echo "  O envio falhou. Causas mais comuns:"
  echo "   · o token não tem o escopo 'repo'"
  echo "   · o token expirou"
  echo "   · o repositório tem commits que este servidor não conhece"
  echo
  echo "  Nada foi perdido: o commit está gravado aqui. Dá para tentar de novo."
  exit 1
fi

unset TOKEN
echo
echo "  Agora vale deixar o repositório PRIVADO:"
echo "  github.com/${REPO}/settings  →  Danger Zone  →  Change visibility"
echo
