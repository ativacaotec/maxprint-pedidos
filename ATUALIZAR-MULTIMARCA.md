# Atualização: sistema multimarca (Samsonite)

Este é o passo a passo para colocar no ar a versão que passa a hospedar mais de
uma marca. Depois dela o sistema continua fazendo tudo o que já fazia para a
Maxprint, e ganha a aba da Samsonite.

Leia a seção 1 antes de rodar qualquer coisa: ela evita o único jeito de essa
atualização dar errado.

---

## 1. Antes de tudo: o servidor está na frente do GitHub

O código que está rodando em `/root/maxprint-pedidos` recebeu ajustes que nunca
subiram para o repositório. **Um `git pull` agora apagaria esses ajustes.**

O que sabemos que foi mexido direto no servidor:

- o *polyfill* de `Promise.withResolvers` no `server.js` (Node 20 não tem essa
  função, e o leitor de PDF precisa dela). **Já está incluído nesta versão**,
  então este ponto está resolvido.

Antes de publicar, guarde uma cópia do que está lá hoje:

```bash
cd /root
cp -a maxprint-pedidos maxprint-pedidos.backup-$(date +%F-%H%M)
ls -la maxprint-pedidos.backup-*
```

Com essa cópia, se qualquer coisa der errado o caminho de volta é uma linha só
(está no fim deste arquivo).

---

## 2. Subir os arquivos novos

Descompacte o pacote por cima da pasta do sistema. **Não** apague a pasta
antiga: `public/img/` guarda as fotos dos produtos e `.env` guarda a chave do
e-mail — os dois precisam continuar onde estão.

```bash
cd /root/maxprint-pedidos
# (envie o zip para o servidor e descompacte aqui, sobrescrevendo)
unzip -o /root/maxprint-multimarca.zip -d /root/maxprint-pedidos
```

O pacote **não contém** `node_modules/`, `public/img/`, `uploads/` nem `.env`,
justamente para não pisar em nada que já está funcionando.

---

## 3. Instalar e preparar

```bash
cd /root/maxprint-pedidos
npm install --omit=dev        # nenhuma dependência nova, mas garante consistência
npm run marcas                # cria as duas marcas no banco (Maxprint e Samsonite)
pm2 restart maxprint-pedidos
pm2 logs maxprint-pedidos --lines 30
```

`npm run marcas` pode ser rodado quantas vezes quiser: se a marca já existe,
ele não mexe nela.

---

## 4. Conferir que subiu certo

```bash
curl -s localhost:3001/api/saude
```

Depois, no navegador:

1. Entre no painel como `marcelo`.
2. Abra a aba **Marcas** — devem aparecer Maxprint e Samsonite.
3. Abra **Clientes** e edite um cliente: deve haver as caixinhas de marca.
4. Entre como um cliente de teste e confirme que o catálogo da Maxprint está
   igual ao de antes.

Se algo estiver estranho, volte para a cópia de segurança (fim do arquivo).

---

## 5. Importar a base da Samsonite

Painel → **Importar bases** → bloco **Samsonite**:

1. **Base da Samsonite** (obrigatório): o arquivo HTML da aplicação antiga.
2. **Catálogos em PDF** (opcional): os dois catálogos, de onde saem as fotos.
3. Botão **Importar Samsonite**.

A leitura dos PDFs leva alguns minutos. A barra de progresso mostra em que pé
está e **pode fechar a tela** — a importação continua no servidor.

No fim aparece o resumo: quantos produtos entraram, quantos ficaram com foto e
quantos ficaram sem. Os sem foto se resolvem um a um na aba **Produtos e fotos**,
do mesmo jeito que já acontece na Maxprint.

> Só os dois catálogos enviados cobrem cerca de 18% dos 1.546 produtos. Isso é
> esperado: os PDFs não trazem todas as linhas. Se aparecerem catálogos novos,
> é só importar de novo que as fotos entram.

---

## 6. Liberar a Samsonite para os clientes

Painel → **Clientes** → **Editar** no cliente → marque **Samsonite** em
"Marcas que este cliente enxerga" → **Salvar**.

Quem não tiver a caixinha marcada continua vendo só a Maxprint, exatamente como
hoje. Nenhum cliente existente muda de comportamento sozinho.

---

## 7. Regras da Samsonite já configuradas

| | |
|---|---|
| Condições de pagamento | 30, 30/60, 60, 30/60/90 |
| Acima de R$ 15.000 também | 60/90, 90, 60/90/120 |
| Prazo muda o preço? | **Não** (diferente da Maxprint, que soma até 2%) |
| Pedido mínimo (abaixo disso não fecha) | R$ 3.500 |
| Frete CIF a partir de | R$ 5.000 |
| Aviso por e-mail | sim, com o nome da marca no assunto |

Tudo isso é editável em **Painel → Marcas → Editar**, sem mexer em código.

---

## Se precisar voltar atrás

```bash
cd /root
pm2 stop maxprint-pedidos
mv maxprint-pedidos maxprint-pedidos.novo
mv maxprint-pedidos.backup-AAAA-MM-DDHHMM maxprint-pedidos
pm2 restart maxprint-pedidos
```

O banco não precisa voltar: os campos novos (`marcaSlug`, `marcasPermitidas`)
são ignorados pela versão antiga, e nada do que existia foi renomeado ou
apagado.
