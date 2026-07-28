# Como colocar o sistema no ar

Guia escrito para o VPS que a Ativação já tem na Hostinger
(`srv1820329.hstgr.cloud`, IP `179.197.68.179`).

A boa notícia: o servidor **já tem tudo que este sistema precisa**, porque o
painel de faturamento roda nele. Node.js 20, MongoDB 7, Nginx e Certbot estão
instalados. Não vamos instalar nada pesado, só acrescentar.

**O painel de faturamento não é tocado em nenhum passo deste guia.** Ele
continua na porta 3000, com o banco dele, o processo dele e o domínio dele.

---

## Como os dois sistemas convivem

| | Painel de faturamento | Pedidos Maxprint |
|---|---|---|
| Pasta | `/root/vps-backend` | `/root/maxprint-pedidos` |
| Porta interna | 3000 | **3001** |
| Banco | `controle_faturamento` | `maxprint_pedidos` |
| Processo pm2 | `painel-faturamento` | `maxprint-pedidos` |
| Endereço | ativacaorep.tech | **pedidos.ativacaorep.tech** |

---

## Passo 1 · Criar o subdomínio no DNS

No painel da Hostinger, em **Domínios → ativacaorep.tech → DNS/Nameservers**,
adicione um registro:

| Campo | Valor |
|---|---|
| Tipo | **A** |
| Nome | **pedidos** |
| Valor | **179.197.68.179** |
| TTL | o padrão |

Faça isso primeiro, porque o DNS leva de minutos a algumas horas para propagar.
Para conferir se já propagou, no terminal do VPS:

```bash
dig +short pedidos.ativacaorep.tech
```

Quando responder `179.197.68.179`, pode seguir.

---

## Passo 2 · Levar o código para o servidor

Crie um repositório novo e privado no GitHub (por exemplo
`ativacaotec/maxprint-pedidos`), suba os arquivos, e no VPS:

```bash
cd /root
git clone https://github.com/ativacaotec/maxprint-pedidos.git
cd maxprint-pedidos
```

Se preferir não usar Git agora, dá para enviar a pasta por `scp` ou pelo
gerenciador de arquivos da Hostinger. Só que sem Git as atualizações futuras
viram trabalho manual, então vale fazer certo desde o começo.

---

## Passo 3 · Instalar

```bash
cd /root/maxprint-pedidos
bash install.sh
```

O script confere o que já existe e instala só o que falta. No seu servidor, a
única coisa nova deve ser o **poppler-utils**, usado para recortar a foto de
cada produto das páginas do catálogo em PDF.

Ele também cria o `.env` já com um `SESSION_SECRET` aleatório.

---

## Passo 4 · Ajustar o `.env`

```bash
nano /root/maxprint-pedidos/.env
```

O que importa conferir:

```
PORT=3001
MONGO_URL=mongodb://127.0.0.1:27017/maxprint_pedidos
COOKIE_SEGURO=sim
URL_PUBLICA=https://pedidos.ativacaorep.tech
EMAIL_PROVEDOR=resend
EMAIL_API_KEY=cole-aqui-a-chave
EMAIL_REMETENTE=pedidos@ativacaorep.tech
```

Sobre o `COOKIE_SEGURO`: deixe `nao` enquanto estiver testando por IP e porta.
Depois que o HTTPS estiver no ar (passo 7), troque para `sim` e reinicie.

Sobre o e-mail: **sem a chave o sistema funciona igual**, só não manda o aviso
de pedido novo. Crie a conta gratuita em resend.com (ou brevo.com), gere uma
API key e cole aqui.

---

## Passo 5 · Criar o primeiro administrador

```bash
cd /root/maxprint-pedidos
npm run create-admin
```

Ele pede nome, usuário e senha. Depois disso, todos os outros usuários são
criados pela aba **Clientes** do próprio painel.

---

## Passo 6 · Subir o processo

```bash
cd /root/maxprint-pedidos
pm2 start server.js --name maxprint-pedidos
pm2 save
```

Confira se subiu:

```bash
pm2 status
curl -s http://127.0.0.1:3001/api/saude
```

Deve responder algo como `{"ok":true,"banco":true,"versao":"1.0.0"}`.

---

## Passo 7 · Nginx e HTTPS

Crie o arquivo de configuração:

```bash
nano /etc/nginx/sites-available/maxprint-pedidos
```

Com este conteúdo:

```nginx
server {
    listen 80;
    server_name pedidos.ativacaorep.tech;

    # O catálogo em PDF pode ter dezenas de megabytes.
    client_max_body_size 200M;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Importar um catálogo grande demora. Sem isso, o Nginx corta no meio.
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

Ative e recarregue:

```bash
ln -s /etc/nginx/sites-available/maxprint-pedidos /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

O `nginx -t` testa a configuração antes de aplicar. Se ele reclamar, **não
recarregue**, corrija primeiro — recarregar com erro derruba o painel de
faturamento junto.

Agora o certificado:

```bash
certbot --nginx -d pedidos.ativacaorep.tech
```

O Certbot ajusta o arquivo sozinho e passa a renovar o certificado
automaticamente. Feito isso, volte no `.env`, troque `COOKIE_SEGURO=sim` e
reinicie:

```bash
pm2 restart maxprint-pedidos
```

---

## Passo 8 · Carregar as bases

Entre em `https://pedidos.ativacaorep.tech`, faça login com o administrador e
vá na aba **Importar bases**. A ordem que funciona melhor:

1. **Tabela de preço** — é ela que libera o carrinho
2. **Estoque disponível** — pode subir as três planilhas de uma vez
3. **Catálogos em PDF** — pode subir vários; é a importação mais demorada,
   porque cada foto é recortada da página

Depois de cada uma, o sistema mostra um **relatório de conferência**: quantos
itens entraram, quantos cruzaram com as outras bases e quais ficaram órfãos.
Vale ler antes de liberar o primeiro cliente.

Com os arquivos de julho/2026, o resultado esperado é:

- 453 produtos no catálogo
- 392 com saldo disponível
- 91% dos vendáveis com foto
- 28 itens fora por falta de preço, quase todos sem saldo

---

## Passo 9 · Criar o primeiro cliente

Aba **Clientes → Novo cliente**. Preencha razão social, CNPJ, endereço,
transportadora e o **desconto**, que é o número que forma o preço dele.

O sistema gera a senha e mostra **uma única vez**. Anote e mande junto com o
endereço para o cliente.

O catálogo nasce **travado** de propósito: o login já funciona, mas o cliente
vê um aviso e não entra. Confira a base e o desconto e só então use o botão
**Liberar**.

---

## Como atualizar depois

```bash
cd /root/maxprint-pedidos
git pull
npm install --omit=dev   # só quando o package.json mudar
pm2 restart maxprint-pedidos
```

Se o `.env.example` ganhar uma variável nova, copie a linha para o seu `.env`
à mão — o `git pull` não mexe nele, porque ele está no `.gitignore`.

---

## Testar depois de instalar

```bash
cd /root/maxprint-pedidos
npm run teste
```

Roda um teste de ponta a ponta num banco separado (`maxprint_pedidos_teste`),
que é apagado no fim. Ele confere login, a parede entre cliente e painel, o
cálculo de desconto e prazo, a trava de estoque, o pedido mínimo, o frete CIF,
o envio e a geração de Excel e PDF. Não encosta nos dados de produção.

---

## Comandos do dia a dia

```bash
pm2 status                       # os dois sistemas estão de pé?
pm2 logs maxprint-pedidos        # log ao vivo
pm2 restart maxprint-pedidos     # reiniciar
systemctl status mongod          # o banco está rodando?
nginx -t                         # a configuração do Nginx está válida?
df -h /                          # espaço em disco
```

---

## Três coisas que vale arrumar no servidor

Achei isso ao conferir o VPS, e nenhuma impede o sistema novo de entrar:

**A porta 3000 está aberta para a internet.** O painel de faturamento pode ser
acessado direto por `IP:3000`, driblando o HTTPS. O certo é o Node dele escutar
só em `127.0.0.1` e deixar o Nginx como única porta de entrada.

**O firewall do VPS está sem regras.** Vale liberar só 22, 80 e 443.

**Há atualizações de segurança pendentes** e o sistema pede reinício desde a
última leva de pacotes.

---

## Backup

O banco é pequeno, então o backup é rápido e vale agendar:

```bash
mongodump --db maxprint_pedidos --out /root/backup/$(date +%F)
```

As fotos dos produtos ficam em `public/img/` e **não vão para o Git** (estão no
`.gitignore`, porque são centenas de megabytes). Se o servidor for reinstalado,
elas voltam sozinhas: basta subir os catálogos em PDF de novo pelo painel.
