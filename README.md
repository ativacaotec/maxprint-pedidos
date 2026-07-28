# Pedidos Maxprint · Ativação Group

Sistema web de digitação de pedidos de pronto entrega da Maxprint. O cliente
entra com login e senha, monta o pedido a partir do catálogo, escolhe a
condição de pagamento e envia. O representante acompanha tudo pelo painel.

Na prática, o sistema substitui a planilha "Tabela Maxprint", em que o pedido
era digitado à mão numa aba e consolidado por `INDEX/MATCH` em outra.

Para instalar, siga o **[DEPLOY.md](DEPLOY.md)**.

---

## O que ele faz

**Para o cliente**
- Catálogo com foto, código, preço dele, saldo e campo de quantidade na própria linha
- Nove categorias com submenu por linha de produto, busca por código, nome ou EAN
- Vitrine em cards ou lista compacta, para quem já sabe o que quer
- Cores do mesmo produto agrupadas num card só, trocando a foto ao escolher a cor
- Destaque com os 15 itens de maior estoque de cada categoria
- Carrinho que soma ao vivo, mostra quanto falta para o pedido mínimo e avisa o frete CIF
- Recálculo do preço na hora em que ele troca a condição de pagamento
- Download da cópia do pedido em Excel e em PDF com foto, antes de enviar
- Histórico dos pedidos anteriores, com um botão para repetir a compra

**Para o representante**
- Pedidos recebidos em destaque, com status novo, digitado, faturado ou cancelado
- Três botões de importação, cada um com relatório de conferência
- Cadastro de clientes com desconto próprio e trava de liberação do catálogo
- Tela de produtos para anexar foto no que o catálogo não ilustra
- Relatórios por cliente, por produto e por mês
- Aviso por e-mail quando chega pedido novo

---

## Regras de negócio

### Preço
```
base            = Preço c/ IPI da tabela Maxprint
custo do cliente = base − (base × desconto cadastrado na ficha dele)
```
A coluna ST (substituição tributária) **não entra no cálculo**, igual à
planilha que a Ativação usa hoje. Fica guardada só como informação.

O preço é sempre **por unidade**.

### Condição de pagamento
| Condição | Prazo médio | Ajuste |
|---|---|---|
| À vista | 0 dias | nenhum |
| 30 | 30 dias | nenhum |
| 30/60 | 45 dias | +1% |
| 60 | 60 dias | +2% |
| 30/60/90 | 60 dias | +2% |

A regra é uma fórmula, não uma tabela fixa, então qualquer condição nova cai
certa sozinha:

```
prazo médio <= 30 dias   ->  acréscimo = 0
30 < prazo médio <= 60   ->  acréscimo = 2% × (prazo médio − 30) / 30
prazo médio > 60         ->  não fecha, abre negociação com o representante
```

### Pedido
- Pedido mínimo: **R$ 3.000,00**
- A partir de R$ 3.000,00 o frete vira **CIF**
- Quantidade acima do saldo é bloqueada, e o bloqueio vale **no servidor**
- Item sem saldo não some do catálogo: vira **pedido programado**, limitado à
  quantidade prevista de chegada

Os dois valores são configuráveis na aba Configuração, sem mexer em código.

---

## As três importações

O sistema não guarda produto chumbado. Toda a base vem de três arquivos, cada
um com seu botão no painel.

| Botão | Arquivo | O que entrega |
|---|---|---|
| 1 · Catálogos | PDFs da Maxprint, Dazz e Logitech | foto, descrição, especificações, embalagem, caixa master, códigos por cor |
| 2 · Estoque | planilhas "Mapa de chegadas" | saldo, status, previsão de chegada mês a mês |
| 3 · Preço | planilha "Tabela Maxprint" | preço com IPI, EAN, NCM, caixa master, curva A, categoria |

As três se juntam pelo **código normalizado**: sem espaço, sem hífen, em
maiúsculas. Sem isso `74 986`, `910-007049` e `60000119` não se encontram — e
foi exatamente esse detalhe que fez a cobertura pular de quase nada para 94%.

### Como a foto sai do PDF
A página inteira é rasterizada uma vez com o `pdftoppm` e a região da foto é
recortada. Isso evita brigar com JPEG2000, máscara de transparência e espaço de
cor exótico, que é onde a extração direta do objeto de imagem quebra.

Três coisas que a leitura precisa engolir e engole:
- o catálogo Logitech tem a camada de texto incompleta, então o sistema casa a
  ficha pelo **modelo** (M170, MK270, C920s) que aparece na descrição da planilha
- etiqueta, toner, refil e papel fotográfico aparecem só em tabela no catálogo,
  sem foto individual: esses recebem a **foto da linha**, marcada como ilustrativa
- catálogo fechado como imagem, sem camada de texto nenhuma, é reportado com
  aviso claro em vez de importar errado

O que sobra sem foto aparece na aba **Produtos e fotos**, para anexar à mão.

---

## Estrutura

```
server.js               servidor Express: sessão, páginas e API
lib/
  codigo.js             normalização do código de produto
  prazo.js              regras de prazo e formação de preço
  importPreco.js        leitura da tabela de preço (9 abas)
  importEstoque.js      leitura dos mapas de chegadas (3 formatos)
  importCatalogo.js     leitura dos catálogos em PDF, com recorte das fotos
  pdfLayout.js          posição de texto e imagem dentro do PDF
  cruzamento.js         junção das três bases
  catalogoServico.js    catálogo já precificado para um cliente
  gerarExcel.js         Excel no formato da aba PEDIDO
  gerarPdf.js           PDF com foto de cada item
  email.js              aviso de pedido novo
models/                 Usuario, Produto, Pedido, Base, Importacao, Config
middleware/auth.js      login, parede do cliente externo, admin
routes/                 auth, catalogo, pedidos, admin, importacao
views/                  login.html, catalogo.html, painel.html
scripts/
  create_admin.js       cria o primeiro administrador
  teste_ponta_a_ponta.js teste com banco (npm run teste)
  teste_pipeline.js     teste do miolo, sem banco, contra arquivos reais
```

---

## Perfis de acesso

| Perfil | O que enxerga |
|---|---|
| `admin` | tudo, inclusive importações, clientes e configuração |
| `interno` | pedidos, produtos e relatórios; não mexe em cadastro |
| `cliente` | só o catálogo dele, e só quando o admin liberar |

O cliente externo não alcança nenhuma rota do painel: a checagem é feita no
servidor, em toda rota interna, não só na tela.

O desconto do cliente **nunca sai para o navegador dele**. O preço chega
calculado. Se o desconto trafegasse, a margem ficaria visível no código da
página.

---

## Testes

```bash
# miolo do sistema, sem banco, contra arquivos reais da Maxprint
node scripts/teste_pipeline.js /caminho/da/pasta/com/os/arquivos

# ponta a ponta, com MongoDB, em banco separado que é apagado no fim
npm run teste
```

---

## Stack

Node.js 20 · Express · MongoDB com Mongoose · express-session com connect-mongo ·
bcryptjs · multer · xlsx · exceljs · pdfkit · pdfjs-dist · sharp · poppler-utils

É a mesma stack do painel de faturamento da Ativação, de propósito: mesmo jeito
de instalar, de atualizar e de dar manutenção.
