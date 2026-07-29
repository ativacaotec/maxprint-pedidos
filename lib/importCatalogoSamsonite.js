'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { abrirPdf, lerPagina } = require('./pdfLayout');

/**
 * Importador dos catálogos Samsonite / American Tourister.
 *
 * Por que um importador só para essa marca
 * ----------------------------------------
 * O lib/importCatalogo.js foi feito para o catálogo da Maxprint, onde cada
 * produto é um "card" fechado e o código do produto está no card. Aqui não
 * existe código no PDF nem card: a página inteira é UM modelo (VARRO, IKONN,
 * NEW CITY PRO 2) e dentro dela ficam de um a seis itens, cada um com uma
 * tabelinha MATERIAL GROUP / MATERIAL DESCRIPTION / WHOLESALE. Rodar o
 * importador da Maxprint aqui devolve nove "códigos" que na verdade são NCM.
 *
 * Dois layouts convivem nos arquivos do cliente:
 *   - "ficha"  - páginas paisagem da Samsonite/American Tourister, com a
 *                tabelinha de preço, as especificações rotuladas e a régua de
 *                amostras de cor;
 *   - "grade"  - páginas retrato do catálogo BTS (linha escolar), uma grade de
 *                fotos com código, descrição e material embaixo de cada uma.
 * O layout é detectado por página, então um PDF misto funciona.
 *
 * A foto certa
 * ------------
 * A reclamação do cliente era ver "mala aberta" no lugar da foto frontal. As
 * miniaturas de detalhe moram numa caixa rotulada "Detalhes do produto:" e são
 * descartadas por posição; o logo lateral, as setas de navegação, o selo de PET
 * reciclado e os ícones das especificações saem por tamanho/posição. Sobram as
 * fotos grandes, que são então casadas com as amostras de cor por distância no
 * espaço Lab (ver casarAmostrasComFotos).
 *
 * Recorte por rasterização, igual ao importador da Maxprint: a página vira PNG
 * pelo pdftoppm e o pedaço é extraído com o sharp. Decodificar o XObject do PDF
 * quebraria nas máscaras de transparência que este catálogo usa em quase toda
 * foto.
 */

const DPI_PADRAO = 150;

/* Chrome da página (não é produto).
 * Em fração da página porque os dois catálogos têm formatos diferentes: a
 * ficha da Samsonite é paisagem de 1583 pt e a grade do BTS é retrato de 768
 * pt. Com margem em pontos fixos, o que era a faixa da marca d'água na
 * primeira comia a coluna da esquerda inteira na segunda. */
const MARGEM_ESQUERDA = 0.048; // faixa da marca d'água "Samsonite" na lateral
const MARGEM_DIREITA = 0.043;  // seta de navegação e o texto de copyright girado
const MARGEM_TOPO = 0.027;
const MARGEM_RODAPE = 0.052;   // logo + categoria no rodapé

const AREA_MINIMA_FOTO = 8000;      // pt²; abaixo disso é ícone/selo, não produto
const LADO_MINIMO_FOTO = 70;        // pt
const ALTURA_MAXIMA_BLOCO = 340;    // pt; da tabelinha para cima, o que é do item
const FRACAO_FOTO_SECUNDARIA = 0.45; // foto menor que isso em área é foto de apoio

/* ------------------------------------------------------------------ *
 * Geometria
 * ------------------------------------------------------------------ */

function multiplicar(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function aplicarMatriz(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Caixa que envolve um retângulo do espaço do usuário depois da matriz. */
function caixaDeRetangulo(m, x0, y0, x1, y1) {
  const cantos = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => aplicarMatriz(m, x, y));
  const xs = cantos.map((c) => c[0]);
  const ys = cantos.map((c) => c[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function intersecao(a, b) {
  return {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  };
}

function centro(c) {
  return [c.x + c.largura / 2, c.y + c.altura / 2];
}

/* ------------------------------------------------------------------ *
 * Imagens com recorte (clip) aplicado
 * ------------------------------------------------------------------ */

/**
 * O lerPagina() do pdfLayout devolve a caixa em que a imagem foi COLOCADA,
 * ignorando o clip corrente. Nestes catálogos isso não serve: nas páginas de
 * fotos grandes (MERITON, por exemplo) as três fotos são o mesmo XObject de
 * 1152x1160 pt colocado sobrepondo a página inteira e recortado por um clip
 * para a faixa em que cada uma aparece. Sem o clip, o recorte sairia com os
 * três produtos juntos e ainda estouraria a página.
 *
 * Então aqui a lista de operações é percorrida de novo acompanhando também a
 * pilha de clip, e a caixa devolvida é a interseção do que foi colocado com o
 * que ficou visível. O texto continua vindo do pdfLayout.
 */
async function lerImagensVisiveis(page, OPS) {
  const viewport = page.getViewport({ scale: 1 });
  const H = viewport.height;
  const W = viewport.width;
  const ops = await page.getOperatorList();

  let ctm = [1, 0, 0, 1, 0, 0];
  let clip = { x0: 0, y0: 0, x1: W, y1: H };
  const pilha = [];
  let clipPendente = false;
  const imagens = [];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];

    if (fn === OPS.save) { pilha.push({ ctm: ctm.slice(), clip: { ...clip } }); continue; }
    if (fn === OPS.restore) {
      const e = pilha.pop();
      if (e) { ctm = e.ctm; clip = e.clip; }
      continue;
    }
    if (fn === OPS.transform) { ctm = multiplicar(ctm, args); continue; }

    // O pdf.js emite o clip ANTES do caminho que o define; guardo a intenção e
    // aplico no constructPath seguinte, usando o bbox que ele já traz pronto.
    if (fn === OPS.clip || fn === OPS.eoClip) { clipPendente = true; continue; }
    if (fn === OPS.constructPath) {
      if (clipPendente) {
        const mm = args[2];
        if (mm && mm.length >= 4) {
          clip = intersecao(clip, caixaDeRetangulo(ctm, mm[0], mm[1], mm[2], mm[3]));
        }
        clipPendente = false;
      }
      continue;
    }

    // Form XObject: carrega matriz própria e bbox, que também recorta.
    if (fn === OPS.paintFormXObjectBegin) {
      pilha.push({ ctm: ctm.slice(), clip: { ...clip } });
      const m = args[0];
      const bbox = args[1];
      if (m && m.length >= 6) ctm = multiplicar(ctm, [m[0], m[1], m[2], m[3], m[4], m[5]]);
      if (bbox && bbox.length >= 4) {
        clip = intersecao(clip, caixaDeRetangulo(ctm, bbox[0], bbox[1], bbox[2], bbox[3]));
      }
      continue;
    }
    if (fn === OPS.paintFormXObjectEnd) {
      const e = pilha.pop();
      if (e) { ctm = e.ctm; clip = e.clip; }
      continue;
    }

    if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintJpegXObject ||
      fn === OPS.paintImageXObjectRepeat ||
      fn === OPS.paintInlineImageXObject
    ) {
      const colocada = caixaDeRetangulo(ctm, 0, 0, 1, 1);
      const v = intersecao(colocada, clip);
      if (v.x1 - v.x0 > 1 && v.y1 - v.y0 > 1) {
        imagens.push({
          nome: typeof args?.[0] === 'string' ? args[0] : '',
          x: v.x0,
          y: H - v.y1, // sistema de tela, igual ao pdfLayout
          largura: v.x1 - v.x0,
          altura: v.y1 - v.y0,
        });
      }
    }
  }

  return { largura: W, altura: H, imagens };
}

/* ------------------------------------------------------------------ *
 * Texto em linhas
 * ------------------------------------------------------------------ */

/**
 * Junta os fragmentos de texto em linhas.
 *
 * Duas manhas deste PDF obrigam a fazer na mão em vez de só ordenar por y:
 *  - itens lado a lado na mesma altura (o item do meio e o da direita) ficam a
 *    5 pt de distância vertical; sem cortar por distância horizontal, o "PESO
 *    (KG)" de um entraria na linha do outro;
 *  - o texto sai quebrado por caractere ("2," + "78", "3" + "5"), então só
 *    entra espaço quando o vão entre um fragmento e o próximo é de verdade.
 */
function juntarLinhas(itens) {
  const linhas = [];
  const ordenados = [...itens].sort((a, b) => (a.y - b.y) || (a.x - b.x));

  for (const t of ordenados) {
    const cy = t.y + t.altura / 2;
    // O vão é medido dos dois lados: o valor do NCM às vezes é desenhado 1 pt
    // acima do rótulo e chega antes dele na ordenação, então a linha precisa
    // poder crescer para a esquerda também.
    const alvo = linhas.find((l) =>
      Math.abs(l.cy - cy) < Math.max(2.5, t.tamanho * 0.4) &&
      Math.max(t.x - l.x1, l.x0 - (t.x + t.largura)) < Math.max(10, t.tamanho * 2.6)
    );
    if (alvo) {
      alvo.itens.push(t);
      alvo.x0 = Math.min(alvo.x0, t.x);
      alvo.x1 = Math.max(alvo.x1, t.x + t.largura);
      alvo.cy = (alvo.cy * (alvo.itens.length - 1) + cy) / alvo.itens.length;
    } else {
      linhas.push({ cy, x0: t.x, x1: t.x + t.largura, itens: [t] });
    }
  }

  return linhas
    .map((l) => {
      const itensOrdenados = l.itens.sort((a, b) => a.x - b.x);
      return {
        texto: montarTexto(itensOrdenados),
        x0: itensOrdenados[0].x,
        x1: Math.max(...itensOrdenados.map((i) => i.x + i.largura)),
        y: Math.min(...itensOrdenados.map((i) => i.y)),
        cy: l.cy,
        tamanho: Math.max(...itensOrdenados.map((i) => i.tamanho)),
        itens: itensOrdenados,
      };
    })
    .sort((a, b) => a.y - b.y || a.x0 - b.x0);
}

function montarTexto(itens) {
  let texto = '';
  let fim = null;
  for (const it of itens) {
    if (fim !== null && it.x - fim > Math.max(0.8, it.tamanho * 0.12)) texto += ' ';
    texto += it.texto;
    fim = it.x + it.largura;
  }
  return texto.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * Cor: Lab, dominante e casamento
 * ------------------------------------------------------------------ */

function rgbParaLab(r, g, b) {
  const f = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const R = f(r), G = f(g), B = f(b);
  let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const h = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  X = h(X); Y = h(Y); Z = h(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

/**
 * Distância perceptual entre duas cores.
 *
 * Em RGB puro, preto (#1a1a1a), cinza-chumbo (#3a3a3a) e azul-marinho
 * (#1b2a44) ficam a poucas unidades um do outro e a foto errada ganha o
 * casamento. Em Lab a diferença de croma pesa de verdade, e o L (claro/escuro)
 * ainda separa o preto do cinza.
 */
function distanciaLab(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Cor dominante de uma região do raster, ignorando o fundo.
 *
 * O fundo das fotos é branco (ou quase), e a sombra embaixo do produto é cinza
 * clara: os dois entram como "pixel claro" e saem da conta. O que sobra é
 * quantizado em caixas de 5 níveis por canal e a caixa mais cheia devolve a
 * média dos seus pixels — isso resiste melhor a reflexo e a logotipo colorido
 * do que a média simples da foto inteira.
 */
function corDominante(raster, caixaPx, limiteClaro = 232) {
  const { dados, largura, altura, canais } = raster;
  const x0 = Math.max(0, Math.round(caixaPx.x0));
  const y0 = Math.max(0, Math.round(caixaPx.y0));
  const x1 = Math.min(largura, Math.round(caixaPx.x1));
  const y1 = Math.min(altura, Math.round(caixaPx.y1));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;

  const passo = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 6000)));
  const caixas = new Map();
  let total = 0;

  for (let y = y0; y < y1; y += passo) {
    for (let x = x0; x < x1; x += passo) {
      const p = (y * largura + x) * canais;
      const r = dados[p], g = dados[p + 1], b = dados[p + 2];
      if (canais === 4 && dados[p + 3] < 128) continue;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum > limiteClaro) continue;
      const chave = (r >> 6) * 64 + (g >> 6) * 8 + (b >> 6);
      let c = caixas.get(chave);
      if (!c) { c = { n: 0, r: 0, g: 0, b: 0 }; caixas.set(chave, c); }
      c.n++; c.r += r; c.g += g; c.b += b;
      total++;
    }
  }

  // Foto de produto branco ou creme: quase tudo caiu no filtro de claro.
  if (total < 25) {
    return limiteClaro >= 250 ? null : corDominante(raster, caixaPx, 250);
  }

  let melhor = null;
  for (const c of caixas.values()) if (!melhor || c.n > melhor.n) melhor = c;
  return [Math.round(melhor.r / melhor.n), Math.round(melhor.g / melhor.n), Math.round(melhor.b / melhor.n)];
}

function paraHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

/**
 * Casa amostras de cor com fotos resolvendo o conjunto de uma vez.
 *
 * Casar cada amostra com a foto mais parecida, uma de cada vez, erra quando
 * duas amostras escuras disputam a mesma foto preta: a primeira leva e a
 * segunda fica com a sobra. Aqui o custo é a soma das distâncias Lab e todas as
 * atribuições possíveis são testadas (são no máximo seis fotos por item, então
 * força bruta é mais barata do que escrever um húngaro).
 */
function casarAmostrasComFotos(amostras, fotos) {
  const n = amostras.length;
  const m = fotos.length;
  const par = new Array(n).fill(-1);
  if (!n || !m) return par;

  const comCor = amostras.every((a) => a.lab) && fotos.every((f) => f.lab);
  if (!comCor || Math.max(n, m) > 7) {
    // Sem cor confiável sobra a ordem da esquerda para a direita.
    for (let i = 0; i < Math.min(n, m); i++) par[i] = i;
    return par;
  }

  const custo = amostras.map((a) => fotos.map((f) => distanciaLab(a.lab, f.lab)));
  const usados = new Array(m).fill(false);
  const pares = Math.min(n, m); // quantas amostras têm que sair com foto
  let melhor = { soma: Infinity, par: null };

  const visitar = (i, soma, feitos, atual) => {
    if (soma >= melhor.soma) return;              // poda: já perdeu
    if (feitos + (n - i) < pares) return;         // poda: não dá mais para fechar
    if (i === n) {
      if (feitos === pares) melhor = { soma, par: atual.slice() };
      return;
    }
    for (let j = 0; j < m; j++) {
      if (usados[j]) continue;
      usados[j] = true;
      atual[i] = j;
      visitar(i + 1, soma + custo[i][j], feitos + 1, atual);
      usados[j] = false;
      atual[i] = -1;
    }
    // Só quando sobram amostras: deixar sem foto tem custo zero, então sem o
    // controle de "feitos" acima o ótimo seria não casar nada.
    if (m < n) {
      atual[i] = -1;
      visitar(i + 1, soma, feitos, atual);
    }
  };

  visitar(0, 0, 0, par.slice());
  return melhor.par || par;
}

/* ------------------------------------------------------------------ *
 * Raster
 * ------------------------------------------------------------------ */

async function rasterizarPagina(caminhoPdf, numero, destino, dpi) {
  const prefixo = path.join(destino, 'pg');
  await execFileAsync('pdftoppm', [
    '-f', String(numero), '-l', String(numero),
    '-r', String(dpi),
    '-png', '-singlefile',
    caminhoPdf, prefixo,
  ], { maxBuffer: 1024 * 1024 * 64 });
  return `${prefixo}.png`;
}

async function lerRaster(png, sharp) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return { dados: data, largura: info.width, altura: info.height, canais: info.channels };
}

/**
 * Quanto de respiro cabe de cada lado sem entrar na foto do lado.
 *
 * A folga existe para não cortar a sombra do produto, mas na página do GUARD IT
 * as caixas das fotos se encostam: com folga fixa, o recorte da mochila saía
 * com uma tira da bolsa aberta vizinha grudada na borda.
 */
function folgaLateral(caixa, vizinhas, folga) {
  let esq = folga;
  let dir = folga;
  for (const v of vizinhas) {
    if (!(v.y < caixa.y + caixa.altura && v.y + v.altura > caixa.y)) continue;
    const fimV = v.x + v.largura;
    if (fimV <= caixa.x + 1) esq = Math.min(esq, Math.max(0, caixa.x - fimV));
    if (v.x >= caixa.x + caixa.largura - 1) dir = Math.min(dir, Math.max(0, v.x - (caixa.x + caixa.largura)));
  }
  return { esq, dir };
}

/**
 * Encolhe a caixa da foto quando alguma coisa invade a área dela.
 *
 * A caixa de colocação de muitas fotos é bem maior que o produto: sobra
 * transparência dos dois lados, e nessa sobra entra a foto do produto vizinho
 * (NETWORK 4, GUARD IT) ou a própria ficha técnica do item. Recortar a caixa
 * crua entregava dois produtos no mesmo arquivo, que é justamente o que não
 * pode acontecer.
 *
 * O corte é feito no "vale": a coluna de pixels praticamente vazia mais próxima
 * da borda do invasor é a separação entre um produto e o outro. A busca é
 * limitada a 45% da largura por lado, para nunca comer o produto; e se não
 * existe vale nenhum nesse trecho, os dois estão de fato encostados na arte e
 * aí é melhor entregar a foto inteira do que cortar o produto ao meio.
 *
 * Sem invasor, a caixa fica como está — no catálogo BTS a "foto" é um conjunto
 * (mochila + lancheira + estojo) separado por espaços brancos, e cortar no
 * primeiro vale jogaria fora dois terços do produto.
 */
function ajustarCaixaDaFoto(raster, escala, caixa, vizinhas, linhas) {
  const px0 = Math.max(0, Math.round(caixa.x * escala));
  const px1 = Math.min(raster.largura, Math.round((caixa.x + caixa.largura) * escala));
  const py0 = Math.max(0, Math.round(caixa.y * escala));
  const py1 = Math.min(raster.altura, Math.round((caixa.y + caixa.altura) * escala));
  if (px1 - px0 < 20 || py1 - py0 < 20) return caixa;

  const cruzaY = (a) => a.y < caixa.y + caixa.altura && a.y + (a.altura || a.tamanho) > caixa.y;
  const meio = caixa.x + caixa.largura / 2;

  // Quem invade pela esquerda entra com a borda direita dele; quem invade pela
  // direita, com a borda esquerda.
  let invasorDir = Infinity;
  let invasorEsq = -Infinity;
  const anotar = (aX0, aX1) => {
    const cA = (aX0 + aX1) / 2;
    if (cA < meio && aX1 > caixa.x + 2) invasorEsq = Math.max(invasorEsq, aX1);
    if (cA > meio && aX0 < caixa.x + caixa.largura - 2) invasorDir = Math.min(invasorDir, aX0);
  };
  for (const v of vizinhas) if (cruzaY(v)) anotar(v.x, v.x + v.largura);
  for (const l of linhas) if (cruzaY(l)) anotar(l.x0, l.x1);
  if (invasorDir === Infinity && invasorEsq === -Infinity) return caixa;

  // Perfil de tinta: quantas linhas da coluna não são fundo.
  const amostradas = Math.max(1, Math.ceil((py1 - py0) / 2));
  const tinta = new Array(px1 - px0).fill(0);
  for (let x = px0; x < px1; x++) {
    let n = 0;
    for (let y = py0; y < py1; y += 2) {
      const p = (y * raster.largura + x) * raster.canais;
      if (Math.min(raster.dados[p], raster.dados[p + 1], raster.dados[p + 2]) < 242) n++;
    }
    tinta[x - px0] = n;
  }
  const limiar = Math.max(1, Math.round(amostradas * 0.02));
  const orcamento = Math.round(caixa.largura * 0.45 * escala); // corte máximo por lado

  // Vale mais próximo da borda do invasor, dentro do orçamento de corte.
  const valeMaisPerto = (de, ate, alvo) => {
    let melhor = null;
    for (let x = Math.min(de, ate); x <= Math.max(de, ate); x++) {
      if (x < px0 || x >= px1) continue;
      if (tinta[x - px0] > limiar) continue;
      if (melhor === null || Math.abs(x - alvo) < Math.abs(melhor - alvo)) melhor = x;
    }
    return melhor;
  };

  let x0 = caixa.x;
  let x1 = caixa.x + caixa.largura;

  if (invasorEsq > -Infinity) {
    const vale = valeMaisPerto(px0, px0 + orcamento, Math.round(invasorEsq * escala));
    if (vale !== null) x0 = vale / escala;
  }
  if (invasorDir < Infinity) {
    const vale = valeMaisPerto(px1 - orcamento, px1 - 1, Math.round(invasorDir * escala));
    if (vale !== null) x1 = vale / escala;
  }

  return { ...caixa, x: x0, largura: Math.max(10, x1 - x0) };
}

async function recortar(png, caixaOriginal, escala, destinoArquivo, sharp, raster, todasFotos = [], linhas = []) {
  const vizinhas = todasFotos.filter((v) => v !== caixaOriginal);
  const caixa = ajustarCaixaDaFoto(raster, escala, caixaOriginal, vizinhas, linhas);
  const folgaPt = 2; // respiro para a sombra do produto
  const { esq, dir } = folgaLateral(caixa, vizinhas, folgaPt);
  const left = Math.max(0, Math.round((caixa.x - esq) * escala));
  const top = Math.max(0, Math.round((caixa.y - folgaPt) * escala));
  const width = Math.min(raster.largura - left, Math.round((caixa.largura + esq + dir) * escala));
  const height = Math.min(raster.altura - top, Math.round((caixa.altura + folgaPt * 2) * escala));
  if (width < 20 || height < 20) return null;

  await sharp(png)
    .extract({ left, top, width, height })
    .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(destinoArquivo);
  return { largura: width, altura: height };
}

/* ------------------------------------------------------------------ *
 * Layout "ficha" (Samsonite / American Tourister)
 * ------------------------------------------------------------------ */

const RE_ESPECS = {
  laptop: /LAPTOP:\s*([^\n]{1,24}?)(?=\s{2,}|$|PESO|CAPACIDADE)/i,
  pesoKg: /PESO\s*\(KG\):\s*([\d.,]+)/i,
  litros: /CAPACIDADE\s*\(LITROS\):\s*([\d.,]+)/i,
  medidas: /MEDIDAS\s*\(CM\):\s*([0-9,.\sXx()APL]+?)(?=\s*(?:GARANTIA|MATERIAL|NCM|$))/i,
  garantia: /GARANTIA:\s*([^\n]{1,20}?)(?=\s*(?:MATERIAL|NCM|CORES|$))/i,
  material: /MATERIAL:\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ /%\d.]{3,40}?)(?=\s*(?:NCM|CORES|MATERIAL GROUP|$))/i,
  ncm: /NCM:\s*(\d[\d.\s]{5,12})/i,
};

/** Acha as tabelinhas MATERIAL GROUP / MATERIAL DESCRIPTION / WHOLESALE. */
function acharTabelas(textos) {
  const grupos = textos.filter((t) => /^MATERIAL GROUP/i.test(t.texto));
  const tabelas = [];

  for (const g of grupos) {
    const mesmaLinha = (t) => Math.abs(t.y - g.y) < 4 && t.x > g.x;
    const descricao = textos.filter((t) => mesmaLinha(t) && /^MATERIAL DESCRIPTION/i.test(t.texto))
      .sort((a, b) => a.x - b.x)[0];
    const preco = textos.filter((t) => mesmaLinha(t) && /WHOLESALE/i.test(t.texto))
      .sort((a, b) => a.x - b.x)[0];
    if (!descricao || !preco) continue;

    const colunas = [
      { chave: 'materialGroup', c: g.x + g.largura / 2, x0: g.x },
      { chave: 'materialDescription', c: descricao.x + descricao.largura / 2 },
      { chave: 'wholesale', c: preco.x + preco.largura / 2, x1: preco.x + preco.largura },
    ];

    // A linha de valores fica logo abaixo do cabeçalho e usa as mesmas colunas.
    // Ela não pode ser montada por juntarLinhas: entre "VARRO" e "SPINNER 55/20
    // EXP" há 55 pt de vão, que a montagem de linha trata como coluna nova.
    // A distância entre o cabeçalho e a linha de valores varia de 14 a 30 pt de
    // página para página, então a janela é folgada e o que garante que só uma
    // linha entre é o agrupamento por y logo abaixo.
    const candidatos = textos.filter(
      (t) => t.y > g.y + 4 && t.y < g.y + 45 &&
        t.x > g.x - 20 && t.x < colunas[2].x1 + 40
    );
    if (!candidatos.length) continue;
    const yValores = Math.min(...candidatos.map((t) => t.y));
    const alvo = candidatos.filter((t) => t.y < yValores + 14);

    const celulas = { materialGroup: [], materialDescription: [], wholesale: [] };
    for (const t of alvo) {
      const c = t.x + t.largura / 2;
      const col = colunas.reduce((a, b) => (Math.abs(b.c - c) < Math.abs(a.c - c) ? b : a));
      celulas[col.chave].push(t);
    }

    const valores = {};
    for (const chave of Object.keys(celulas)) {
      valores[chave] = montarTexto(celulas[chave].sort((a, b) => a.x - b.x));
    }

    tabelas.push({
      x0: g.x,
      x1: colunas[2].x1,
      y0: g.y,
      y1: Math.max(...alvo.map((t) => t.y + t.altura)),
      materialGroup: valores.materialGroup,
      materialDescription: valores.materialDescription,
      wholesale: converterPreco(valores.wholesale),
      precoTexto: valores.wholesale,
    });
  }

  return tabelas.sort((a, b) => a.y0 - b.y0);
}

function converterPreco(texto) {
  const m = String(texto || '').match(/(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})/);
  if (!m) return null;
  return Number(`${m[1].replace(/\./g, '')}.${m[2]}`);
}

/** A linha faz parte de alguma tabelinha (cabeçalho ou linha de valores)? */
function ehLinhaDeTabela(linha, tabelas) {
  return tabelas.some(
    (t) => linha.y + linha.tamanho > t.y0 - 1 && linha.y < t.y1 + 1 &&
      linha.x1 > t.x0 - 25 && linha.x0 < t.x1 + 25
  );
}

/**
 * Monta os blocos de item a partir das tabelinhas.
 *
 * A tabelinha é a âncora porque é o único elemento que aparece uma vez por item
 * e sempre no mesmo formato. Cada linha de texto vai para a tabela que estiver
 * mais perto ACIMA dela, e não para uma faixa vertical fixa: em várias páginas
 * a tabelinha está deslocada uns 80 pt à direita da coluna de texto do item
 * (VARRO tamanho G, ODYSSEY tamanho G), e uma janela fixa deixava o item sem
 * especificação nenhuma.
 *
 * O teto de 340 pt existe para o item de baixo não puxar os bullets da
 * descrição do modelo, que ficam no alto da página; o limite de 120 pt na
 * horizontal impede que a coluna da esquerda invada o item da direita.
 */
function montarBlocosFicha(tabelas, linhas, linhasDoTitulo = []) {
  const blocos = tabelas.map((tab) => ({ tabela: tab, linhas: [] }));

  for (const l of linhas) {
    if (ehLinhaDeTabela(l, tabelas)) continue;
    // O nome do modelo é da página inteira, não de um item: na página de
    // acessórios ele caía dentro do primeiro bloco e virava o título do item.
    if (linhasDoTitulo.includes(l)) continue;
    let escolhido = -1;
    let menorCusto = Infinity;
    blocos.forEach((b, i) => {
      const t = b.tabela;
      const dy = t.y0 - l.y;
      if (dy < 2 || dy > ALTURA_MAXIMA_BLOCO) return;
      const dx = Math.max(0, Math.max(t.x0 - l.x1, l.x0 - t.x1));
      if (dx > 120) return;
      const custo = dx + dy * 0.6; // o bloco é alto e estreito: y pesa menos
      if (custo < menorCusto) { menorCusto = custo; escolhido = i; }
    });
    if (escolhido >= 0) blocos[escolhido].linhas.push(l);
  }

  return blocos.map((b) => {
    const ls = b.linhas.sort((a, c) => a.y - c.y);
    const x = ls.length ? Math.min(b.tabela.x0, ...ls.map((l) => l.x0)) : b.tabela.x0;
    const x1 = ls.length ? Math.max(b.tabela.x1, ...ls.map((l) => l.x1)) : b.tabela.x1;
    const y = ls.length ? Math.min(...ls.map((l) => l.y)) : b.tabela.y0 - 40;
    return {
      tabela: b.tabela,
      linhas: ls,
      caixa: { x, y, largura: x1 - x, altura: Math.max(20, b.tabela.y1 - y) },
      texto: ls.map((l) => l.texto).join('\n'),
    };
  });
}

/** Título do item: a linha de maior corpo dentro do bloco, sem o nome do modelo. */
function tituloDoBloco(bloco, modelo) {
  const candidatas = bloco.linhas.filter(
    (l) => l.texto.length > 2 &&
      l.tamanho >= 14 &&
      !/^(LAPTOP|PESO|CAPACIDADE|MEDIDAS|GARANTIA|MATERIAL|NCM|CORES|MATERIAL GROUP)/i.test(l.texto)
  );
  if (!candidatas.length) return '';
  const maior = Math.max(...candidatas.map((l) => l.tamanho));
  return candidatas
    .filter((l) => l.tamanho >= maior - 0.6)
    .map((l) => l.texto)
    .filter((t) => t.toUpperCase() !== String(modelo || '').toUpperCase())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nome do modelo: o título grande no alto e à esquerda da página. */
function modeloDaPagina(linhas, largura) {
  const candidatas = linhas.filter((l) => l.y < 140 && l.x0 < largura * 0.55 && l.tamanho >= 22 && l.texto.length > 1);
  if (!candidatas.length) return '';
  const maior = Math.max(...candidatas.map((l) => l.tamanho));
  // Filtra por FRAGMENTO e não por linha: ao lado de "IKONN" existe o selo
  // "Linha Best Seller" em corpo miúdo, que cai na mesma linha e entraria no
  // nome do modelo.
  const usadas = candidatas.filter((l) => l.tamanho >= maior - 1).sort((a, b) => a.y - b.y);
  const texto = usadas
    .map((l) => montarTexto(l.itens.filter((i) => i.tamanho >= maior - 1)))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { texto, linhas: usadas };
}

/**
 * Amostras de cor: retângulos chapados à direita do rótulo "CORES DISPONÍVEIS:".
 *
 * Elas são desenhadas como vetor, não como imagem, então não aparecem na lista
 * de XObjects — precisam ser achadas no raster. A faixa varrida é a altura do
 * rótulo com folga; uma coluna conta como amostra quando quase toda ela está
 * pintada, o que separa o retângulo da sigla fina que às vezes vem embaixo.
 */
function acharAmostras(raster, escala, rotulo, limiteDireita) {
  const xIni = Math.max(0, Math.round((rotulo.x1 + 3) * escala));
  const xFim = Math.min(raster.largura, Math.round(Math.min(limiteDireita, rotulo.x1 + 330) * escala));
  const yIni = Math.max(0, Math.round((rotulo.cy - rotulo.tamanho * 1.5) * escala));
  const yFim = Math.min(raster.altura, Math.round((rotulo.cy + rotulo.tamanho * 1.5) * escala));
  if (xFim - xIni < 8 || yFim - yIni < 8) return [];

  const { dados, largura, canais } = raster;
  const pintado = (x, y) => {
    const p = (y * largura + x) * canais;
    return 255 - Math.min(dados[p], dados[p + 1], dados[p + 2]) > 12;
  };

  const agrupar = (marcado) => {
    const faixas = [];
    let inicio = -1;
    for (let i = 0; i <= marcado.length; i++) {
      if (i < marcado.length && marcado[i]) { if (inicio < 0) inicio = i; continue; }
      if (inicio >= 0) {
        const larguraPt = (i - inicio) / escala;
        if (larguraPt >= 9 && larguraPt <= 95) faixas.push([xIni + inicio, xIni + i]);
        inicio = -1;
      }
    }
    return faixas;
  };

  // Passo 1: as amostras chapadas, que preenchem quase toda a faixa varrida.
  const alturaFaixa = yFim - yIni;
  const cheias = [];
  for (let x = xIni; x < xFim; x++) {
    let pintados = 0;
    for (let y = yIni; y < yFim; y++) if (pintado(x, y)) pintados++;
    cheias.push(pintados >= alturaFaixa * 0.45);
  }
  const fortes = agrupar(cheias);
  if (!fortes.length) return [];

  // Altura do retângulo, medida no meio da primeira amostra chapada. Todas as
  // amostras do item dividem a mesma linha de base. Fico com a maior sequência
  // contínua de linhas pintadas: a sigla impressa embaixo (P/AZ, P/AM) também
  // cai na faixa varrida e senão esticaria a caixa até ela.
  const xm0 = Math.round((fortes[0][0] + fortes[0][1]) / 2);
  let py0 = 0;
  let py1 = -1;
  let ini = -1;
  for (let y = yIni; y <= yFim; y++) {
    if (y < yFim && pintado(xm0, y)) { if (ini < 0) ini = y; continue; }
    if (ini >= 0) {
      if (y - 1 - ini > py1 - py0) { py0 = ini; py1 = y - 1; }
      ini = -1;
    }
  }
  if (py1 - py0 < 6) return [];

  // Passo 2: agora que a caixa é conhecida, vale a borda em vez do miolo. Sem
  // isso a amostra BRANCA (a linha OCTOLITE tem uma) some, porque só o
  // contorno cinza dela é diferente do fundo — e sumindo uma amostra, a foto
  // branca acabava casada com a amostra azul.
  // A tolerância de 2 px no topo e na base não é preciosismo: amostras vizinhas
  // do mesmo item começam e terminam com um ou dois pixels de diferença por
  // causa do antialiasing, e no teste exato só a primeira delas era encontrada.
  const perto = (x, y0, y1) => {
    for (let y = Math.max(yIni, y0); y <= Math.min(yFim - 1, y1); y++) if (pintado(x, y)) return true;
    return false;
  };
  const bordas = [];
  for (let x = xIni; x < xFim; x++) {
    const topo = perto(x, py0 - 2, py0 + 2);
    const base = perto(x, py1 - 2, py1 + 2);
    bordas.push((topo && base) || cheias[x - xIni]);
  }

  // As amostras de um item formam uma régua: mesma largura e mesmo passo. Esse
  // filtro derruba o que a varredura pega depois delas — na linha IKONN a foto
  // da mochila começa a 160 pt do rótulo e a silhueta dela virava uma "amostra
  // branca" no fim da fila.
  const faixas = [];
  for (const faixa of agrupar(bordas)) {
    if (faixas.length) {
      const anterior = faixas[faixas.length - 1];
      const larguraRef = faixas[0][1] - faixas[0][0];
      if (Math.abs((faixa[1] - faixa[0]) - larguraRef) > larguraRef * 0.35) break;
      if (faixa[0] - anterior[1] > larguraRef * 2.2) break;
    }
    faixas.push(faixa);
  }

  const amostras = [];
  for (const [px0, px1] of faixas) {
    const xm = Math.round((px0 + px1) / 2);
    const ym = Math.round((py0 + py1) / 2);
    const p = (ym * largura + xm) * canais;
    const centroPixel = [dados[p], dados[p + 1], dados[p + 2]];
    // Para o casamento uso a cor dominante do miolo: a amostra bicolor
    // (preto/azul da linha IKONN) tem o pixel central em cima da divisa.
    const dominante = corDominante(
      { dados, largura, altura: raster.altura, canais },
      {
        x0: px0 + (px1 - px0) * 0.2, y0: py0 + (py1 - py0) * 0.2,
        x1: px1 - (px1 - px0) * 0.2, y1: py1 - (py1 - py0) * 0.2,
      },
      250
    ) || centroPixel;

    amostras.push({
      hex: paraHex(centroPixel),
      lab: rgbParaLab(dominante[0], dominante[1], dominante[2]),
      caixa: {
        x: px0 / escala, y: py0 / escala,
        largura: (px1 - px0) / escala, altura: (py1 - py0) / escala,
      },
    });
  }

  return amostras;
}

/* ------------------------------------------------------------------ *
 * Layout "grade" (catálogo BTS)
 * ------------------------------------------------------------------ */

// O código do BTS às vezes traz letra no meio (155116A4001), então não dá
// para exigir só dígito.
const RE_CODIGO_BTS = /^(\d[0-9A-Z]{8,12})\s*U?$/;
const RE_TIPO_BTS = new RegExp(
  '^(MOCHILA COM RODAS|MOCHILA CASUAL|MOCHILA INFANTIL|MOCHILA|MALA COM RODAS|MALA RODA|MALA|' +
  'LANCHEIRA INFANTIL|LANCHEIRA CASUAL|LANCHEIRA|ESTOJO INFANTIL|ESTOJO CASUAL|ESTOJO|' +
  'BOLSA ESPORTIVA|BOLSA|NECESSAIRE|NECESSÁRIE|PENCIL CASE|PASTA|SACOLA|KIT|PACK)\\s+(.*)$', 'i'
);

/**
 * O catálogo BTS não tem tabela nem amostra de cor: é uma grade de fotos com
 * três linhas de texto embaixo (código, descrição, material). O modelo e a cor
 * moram dentro da descrição ("MOCHILA BERKELEY 5XT BURGUNDY"), então são
 * separados por expressão regular e a cor vira o rótulo da amostra — o hex, aí,
 * só pode sair da própria foto.
 */
function montarItensGrade(linhas, fotos) {
  const codigos = linhas.filter((l) => RE_CODIGO_BTS.test(l.texto.trim()));
  const itens = [];

  for (const lc of codigos) {
    const codigo = lc.texto.trim().match(RE_CODIGO_BTS)[1];
    const cx = (lc.x0 + lc.x1) / 2;
    const abaixo = linhas
      .filter((l) => l.y > lc.y + 2 && l.y < lc.y + 44 && Math.abs((l.x0 + l.x1) / 2 - cx) < 130)
      .sort((a, b) => a.y - b.y);
    const descricao = abaixo[0] ? abaixo[0].texto : '';
    const material = abaixo[1] ? abaixo[1].texto : '';

    let tipo = '';
    let modelo = descricao;
    let cor = '';
    const m = descricao.match(RE_TIPO_BTS);
    if (m) {
      tipo = m[1].toUpperCase();
      const resto = m[2];
      const partes = resto.split(/\s+5XT\s*/i);
      modelo = (partes[0] || resto).trim();
      cor = (partes[1] || '').trim();
    }

    // A foto é a que está logo acima do código, na mesma coluna da grade.
    const candidatas = fotos
      .map((f) => ({
        foto: f,
        dx: Math.abs(f.x + f.largura / 2 - cx),
        vao: lc.y - (f.y + f.altura),
      }))
      // O vão entre a foto e o código varia bastante (de 20 a 115 pt), então a
      // janela é larga; o que separa uma linha da grade da outra é a distância
      // horizontal, não a vertical.
      .filter((c) => c.dx < 140 && c.vao > -15 && c.vao < 170)
      .sort((a, b) => a.dx - b.dx);

    itens.push({
      codigo,
      tipo,
      modelo,
      corNome: cor,
      material,
      descricao,
      fotos: candidatas.length ? [candidatas[0].foto] : [],
      caixa: { x: lc.x0, y: lc.y, largura: lc.x1 - lc.x0, altura: 40 },
    });
  }

  return itens;
}

/* ------------------------------------------------------------------ *
 * Seleção das fotos
 * ------------------------------------------------------------------ */

/**
 * Separa foto de produto de tudo o que é enfeite da página.
 *
 * Descarta, nesta ordem: o que encosta nas bordas (marca d'água lateral, setas
 * de navegação, rodapé), o que é pequeno demais (ícone de especificação, logo),
 * as miniaturas da caixa "Detalhes do produto:" — que são a origem da
 * reclamação de "mala aberta" — e o selo de PET reciclado no canto inferior
 * direito.
 */
function selecionarFotos(imagens, linhas, dims) {
  const rotuloDetalhes = linhas.find((l) => /detalhes\s+do\s+produto/i.test(l.texto));
  const caixaDetalhes = rotuloDetalhes
    ? {
      x0: rotuloDetalhes.x0 - 70,
      x1: rotuloDetalhes.x0 + 830,
      y0: rotuloDetalhes.y - 12,
      y1: rotuloDetalhes.y + 230,
    }
    : null;

  const util = {
    x0: dims.largura * MARGEM_ESQUERDA,
    y0: dims.altura * MARGEM_TOPO,
    x1: dims.largura * (1 - MARGEM_DIREITA),
    y1: dims.altura * (1 - MARGEM_RODAPE),
  };

  const escolhidas = [];
  for (const im of imagens) {
    // A foto é aparada pela área útil em vez de descartada: várias fotos
    // encostam um ou dois pontos no rodapé, e descartar por isso deixava a
    // página inteira (BRAVO, por exemplo) sem foto nenhuma.
    const v = intersecao({ x0: im.x, y0: im.y, x1: im.x + im.largura, y1: im.y + im.altura }, util);
    const larg = v.x1 - v.x0;
    const alt = v.y1 - v.y0;
    if (larg <= 0 || alt <= 0) continue;
    // Sobrou menos da metade: era marca d'água lateral, seta ou rodapé.
    if (larg * alt < im.largura * im.altura * 0.55) continue;
    if (larg < LADO_MINIMO_FOTO || alt < LADO_MINIMO_FOTO) continue;
    if (larg * alt < AREA_MINIMA_FOTO) continue;
    // Fundo de página inteira (o BTS usa um) não é produto.
    if (larg * alt > dims.largura * dims.altura * 0.55) continue;

    const foto = { ...im, x: v.x0, y: v.y0, largura: larg, altura: alt };
    const [cx, cy] = centro(foto);
    if (caixaDetalhes && cx > caixaDetalhes.x0 && cx < caixaDetalhes.x1 &&
        cy > caixaDetalhes.y0 && cy < caixaDetalhes.y1) continue;

    // Selo "INTERIOR 100% PET RECICLADO": estreito, sempre no rodapé direito.
    if (foto.x > dims.largura * 0.82 && foto.y + alt > dims.altura * 0.85 && larg < 130) continue;

    escolhidas.push(foto);
  }
  return escolhidas;
}

/**
 * Distribui as fotos entre os itens da página e descarta as fotos de apoio.
 *
 * Fotos de apoio são as tomadas com a bolsa aberta que acompanham a frontal em
 * algumas páginas (GUARD IT 2.0, por exemplo). Elas sempre vêm bem menores que
 * a frontal do mesmo item, então caem pelo tamanho relativo — filtrar por
 * tamanho absoluto não daria, porque em página de acessórios a frontal inteira
 * é pequena.
 */
function distribuirFotos(itens, fotos) {
  const porItem = itens.map(() => []);
  if (!itens.length) return { porItem, descartadas: fotos.slice() };

  for (const f of fotos) {
    let melhor = 0;
    let melhorD = Infinity;
    const [fx, fy] = centro(f);
    itens.forEach((it, i) => {
      const [ix, iy] = centro(it.caixa);
      // Distância entre centros com o eixo vertical pesando o dobro, mais uma
      // multa para a foto que passa da borda direita do bloco.
      //
      // Distância entre as caixas não resolve: numa página de três tamanhos, a
      // foto do item de baixo encosta na caixa do item de cima e as duas
      // distâncias dão zero. O que separa de verdade é a altura — a foto fica
      // SEMPRE na mesma faixa horizontal do seu texto e nunca depois dele. A
      // multa é o que decide na NETWORK 4, onde as duas mochilas da direita
      // ficam mais perto do texto da pasta do que do texto delas.
      const excede = Math.max(0, (f.x + f.largura) - (it.caixa.x + it.caixa.largura));
      const d = Math.abs(fx - ix) + 2 * Math.abs(fy - iy) + excede;
      if (d < melhorD) { melhorD = d; melhor = i; }
    });
    porItem[melhor].push(f);
  }

  const descartadas = [];
  porItem.forEach((lista, i) => {
    if (lista.length < 2) return;
    const maior = Math.max(...lista.map((f) => f.largura * f.altura));
    porItem[i] = lista.filter((f) => {
      if (f.largura * f.altura >= maior * FRACAO_FOTO_SECUNDARIA) return true;
      descartadas.push(f);
      return false;
    });
  });

  porItem.forEach((lista) => lista.sort((a, b) => a.x - b.x));
  return { porItem, descartadas };
}

/* ------------------------------------------------------------------ *
 * Entrada principal
 * ------------------------------------------------------------------ */

function apelido(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toUpperCase()
    .slice(0, 28) || 'ITEM';
}

/**
 * @param {string} caminhoPdf
 * @param {object} opcoes
 *   pastaImagens - onde gravar os recortes (obrigatório para ter foto)
 *   prefixo      - prefixo do nome dos arquivos de imagem
 *   dpi          - resolução do raster usado no recorte e na leitura de cor
 *   aoProgredir  - callback(paginaAtual, totalPaginas)
 */
async function importarCatalogoSamsonite(caminhoPdf, opcoes = {}) {
  const {
    pastaImagens = null,
    prefixo = 'sam',
    dpi = DPI_PADRAO,
    aoProgredir = null,
  } = opcoes;

  const sharp = require('sharp');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const OPS = pdfjs.OPS;
  const escala = dpi / 72;

  const doc = await abrirPdf(caminhoPdf);
  const itens = [];
  const avisos = [];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'samsonite-'));
  if (pastaImagens) fs.mkdirSync(pastaImagens, { recursive: true });

  try {
    for (let n = 1; n <= doc.numPages; n++) {
      if (aoProgredir) aoProgredir(n, doc.numPages);

      let layout;
      let visiveis;
      try {
        const page = await doc.getPage(n);
        layout = await lerPagina(page);
        visiveis = await lerImagensVisiveis(page, OPS);
      } catch (e) {
        avisos.push(`Página ${n}: falhou na leitura (${e.message}).`);
        continue;
      }

      const dims = { largura: layout.largura, altura: layout.altura };

      // O copyright girado na borda direita sai em fragmentos de corpo 5 e só
      // atrapalha; o rodapé e a marca d'água lateral idem.
      const textos = layout.textos.filter(
        (t) => t.tamanho >= 6 &&
          t.x > dims.largura * MARGEM_ESQUERDA - 30 &&
          t.x < dims.largura * 0.985 &&
          t.y < dims.altura * (1 - MARGEM_RODAPE)
      );
      const linhas = juntarLinhas(textos);
      const fotos = selecionarFotos(visiveis.imagens, linhas, dims);

      const tabelas = acharTabelas(textos);
      const ehFicha = tabelas.length > 0;
      const tituloPagina = ehFicha ? modeloDaPagina(linhas, dims.largura) : { texto: '', linhas: [] };
      const blocos = ehFicha ? montarBlocosFicha(tabelas, linhas, tituloPagina.linhas) : [];
      const daGrade = ehFicha ? [] : montarItensGrade(linhas, fotos);

      if (!blocos.length && !daGrade.length) continue;

      const modelo = tituloPagina.texto;

      // Só rasteriza página que tem item; é a parte cara do processo.
      let png = null;
      let raster = null;
      try {
        png = await rasterizarPagina(caminhoPdf, n, tmp, dpi);
        raster = await lerRaster(png, sharp);
      } catch (e) {
        avisos.push(`Página ${n}: não consegui rasterizar para recortar as fotos (${e.message}).`);
      }

      const construidos = ehFicha
        ? blocos.map((b) => ({ tipoBloco: 'ficha', bloco: b, caixa: b.caixa }))
        : daGrade.map((g) => ({ tipoBloco: 'grade', grade: g, caixa: g.caixa }));

      const distribuicao = ehFicha
        ? distribuirFotos(construidos, fotos)
        : { porItem: daGrade.map((g) => g.fotos), descartadas: [] };

      for (const [idx, alvo] of construidos.entries()) {
        const minhasFotos = distribuicao.porItem[idx] || [];

        // Cores: amostras do raster (ficha) ou a cor que veio na descrição (grade).
        let amostras = [];
        if (ehFicha && raster) {
          const rotulo = alvo.bloco.linhas.find((l) => /^CORES\s*DISPON/i.test(l.texto));
          if (rotulo) {
            // Em página de acessórios o rótulo é mais largo que a tabelinha, e
            // aí o limite da tabela ficava À ESQUERDA do rótulo: faixa vazia,
            // nenhuma cor lida. O piso de 250 pt cobre até cinco amostras.
            const limite = Math.max(alvo.bloco.tabela.x1 + 45, rotulo.x1 + 330);
            amostras = acharAmostras(raster, escala, rotulo, limite);
            if (!amostras.length) {
              avisos.push(`Página ${n}, item ${idx + 1}: rótulo de cores encontrado, mas nenhuma amostra foi lida no raster.`);
            }
          }
        }

        // Cor dominante de cada foto, ainda no raster da página inteira.
        const fotosComCor = minhasFotos.map((f) => {
          let rgb = null;
          if (raster) {
            rgb = corDominante(raster, {
              x0: (f.x + f.largura * 0.12) * escala,
              y0: (f.y + f.altura * 0.08) * escala,
              x1: (f.x + f.largura * 0.88) * escala,
              y1: (f.y + f.altura * 0.92) * escala,
            });
          }
          return { ...f, rgb, lab: rgb ? rgbParaLab(rgb[0], rgb[1], rgb[2]) : null };
        });

        // Grava os recortes.
        // O índice entra no nome porque a mesma página repete descrição (a de
        // acessórios tem dois "RFID MONEY BELT") e um arquivo sobrescreveria o
        // outro.
        const base = alvo.tipoBloco === 'grade'
          ? alvo.grade.codigo
          : `${idx + 1}-${apelido(`${modelo || alvo.bloco.tabela.materialGroup}-${alvo.bloco.tabela.materialDescription}`)}`;
        const imagensGravadas = [];
        for (const [j, f] of fotosComCor.entries()) {
          if (!png || !pastaImagens) break;
          const nomeArq = `${prefixo}-p${n}-${base}-${j + 1}.png`;
          try {
            const dimensao = await recortar(png, f, escala, path.join(pastaImagens, nomeArq), sharp, raster, fotos, linhas);
            if (dimensao) {
              imagensGravadas.push({
                arquivo: nomeArq,
                largura: dimensao.largura,
                altura: dimensao.altura,
                corDominante: f.rgb ? paraHex(f.rgb) : '',
              });
            }
          } catch (e) {
            avisos.push(`Página ${n}, item ${idx + 1}: falha ao recortar a foto ${j + 1} (${e.message}).`);
          }
        }

        // Casamento amostra <-> foto.
        const cores = [];
        if (amostras.length) {
          const par = casarAmostrasComFotos(amostras, fotosComCor);
          if (amostras.length !== fotosComCor.length) {
            avisos.push(
              `Página ${n}, item ${idx + 1}: ${amostras.length} cor(es) e ${fotosComCor.length} foto(s); ` +
              'casei o que deu e o resto ficou sem foto.'
            );
          }
          amostras.forEach((a, i) => {
            const j = par[i];
            const sigla = siglaDaAmostra(a, linhas);
            cores.push({
              ordem: i,
              hex: a.hex,
              sigla,
              arquivoImagem: j >= 0 && imagensGravadas[j] ? imagensGravadas[j].arquivo : '',
            });
          });
        } else if (alvo.tipoBloco === 'grade') {
          // Sem amostra impressa: a cor do item é a da própria foto.
          cores.push({
            ordem: 0,
            hex: imagensGravadas[0] ? imagensGravadas[0].corDominante : '',
            sigla: alvo.grade.corNome || '',
            arquivoImagem: imagensGravadas[0] ? imagensGravadas[0].arquivo : '',
          });
        }

        if (!imagensGravadas.length) {
          avisos.push(`Página ${n}, item ${idx + 1}: nenhuma foto frontal foi identificada.`);
        }

        if (alvo.tipoBloco === 'ficha') {
          const tab = alvo.bloco.tabela;
          const textoBloco = alvo.bloco.texto;
          itens.push({
            pagina: n,
            modelo: modelo || tab.materialGroup,
            tipo: tituloDoBloco(alvo.bloco, modelo),
            codigo: (textoBloco.match(/\b\d{11,13}\b/) || [''])[0],
            materialGroup: tab.materialGroup,
            materialDescription: tab.materialDescription,
            wholesale: tab.wholesale,
            especificacoes: lerEspecificacoes(textoBloco),
            cores,
            imagens: imagensGravadas,
          });
        } else {
          const g = alvo.grade;
          itens.push({
            pagina: n,
            modelo: g.modelo,
            tipo: g.tipo,
            codigo: g.codigo,
            materialGroup: '',
            materialDescription: g.descricao,
            wholesale: null,
            especificacoes: {
              laptop: '', pesoKg: null, litros: null, medidas: '',
              garantia: '', material: g.material, ncm: '',
            },
            cores,
            imagens: imagensGravadas,
          });
        }
      }

      if (png) { try { fs.unlinkSync(png); } catch (_) {} }
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  if (!itens.length) {
    avisos.push(
      'Nenhum item foi reconhecido neste PDF. Ele provavelmente não é um catálogo Samsonite ' +
      '(nem no formato de ficha, nem no formato de grade do BTS).'
    );
  }

  return { paginas: doc.numPages, itens, avisos };
}

/** Sigla impressa embaixo da amostra (P/AZ, P/V, P/AM). */
function siglaDaAmostra(amostra, linhas) {
  const cxAmostra = amostra.caixa.x + amostra.caixa.largura / 2;
  const abaixo = linhas.filter(
    (l) => l.y >= amostra.caixa.y + amostra.caixa.altura - 2 &&
      l.y < amostra.caixa.y + amostra.caixa.altura + 22 &&
      Math.abs((l.x0 + l.x1) / 2 - cxAmostra) < amostra.caixa.largura &&
      /^[A-Z]{1,4}(\/[A-Z]{1,4})?$/.test(l.texto)
  );
  return abaixo.length ? abaixo[0].texto : '';
}

function lerEspecificacoes(texto) {
  const linha = String(texto || '').replace(/\n/g, '  ');
  const pegar = (re) => {
    const m = linha.match(re);
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
  };
  const numero = (s) => {
    if (!s) return null;
    const v = Number(String(s).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(v) ? v : null;
  };
  return {
    laptop: pegar(RE_ESPECS.laptop),
    pesoKg: numero(pegar(RE_ESPECS.pesoKg)),
    litros: numero(pegar(RE_ESPECS.litros)),
    medidas: pegar(RE_ESPECS.medidas),
    garantia: pegar(RE_ESPECS.garantia),
    material: pegar(RE_ESPECS.material),
    ncm: pegar(RE_ESPECS.ncm).replace(/\s/g, ''),
  };
}

module.exports = { importarCatalogoSamsonite };
