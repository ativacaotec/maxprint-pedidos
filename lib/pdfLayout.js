'use strict';

/**
 * Leitura de layout de PDF: texto com posição e imagens com posição.
 *
 * O catálogo da Maxprint é uma peça de design, não uma tabela. Cada produto
 * mora num "card" com foto de um lado e texto do outro. Para saber qual foto
 * pertence a qual produto, não basta extrair texto e imagens soltos: é preciso
 * saber ONDE cada coisa está na página e agrupar o que está junto.
 *
 * Este módulo devolve, por página:
 *   - itens de texto com caixa (x, y, largura, altura) e tamanho de fonte
 *   - retângulos das imagens desenhadas
 *
 * As coordenadas saem já convertidas para o sistema de tela (origem no canto
 * superior esquerdo), que é o mesmo do raster gerado pelo pdftoppm. Assim o
 * recorte da foto é uma multiplicação simples por dpi/72.
 */

let pdfjsPromise = null;
function carregarPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

/** Multiplica duas matrizes de transformação do PDF [a,b,c,d,e,f]. */
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

/** Caixa que envolve o quadrado unitário depois de aplicada a matriz. */
function caixaDoQuadradoUnitario(m, altura) {
  const cantos = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ]);
  const xs = cantos.map((c) => c[0]);
  const ys = cantos.map((c) => c[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return {
    x: x0,
    y: altura - y1, // vira sistema de tela
    largura: x1 - x0,
    altura: y1 - y0,
  };
}

async function lerPagina(page) {
  const pdfjs = await carregarPdfjs();
  const OPS = pdfjs.OPS;
  const viewport = page.getViewport({ scale: 1 });
  const H = viewport.height;

  const conteudo = await page.getTextContent();
  const textos = [];
  for (const it of conteudo.items) {
    const s = (it.str || '').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    const t = it.transform;
    const tamanho = Math.hypot(t[2], t[3]) || it.height || 0;
    textos.push({
      texto: s,
      x: t[4],
      y: H - t[5] - tamanho,
      largura: it.width || 0,
      altura: tamanho,
      fonte: it.fontName || '',
      tamanho,
    });
  }

  // Imagens: acompanho a matriz corrente (CTM) andando pela lista de operações.
  const ops = await page.getOperatorList();
  const imagens = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const pilha = [];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];

    if (fn === OPS.save) { pilha.push(ctm.slice()); continue; }
    if (fn === OPS.restore) { ctm = pilha.pop() || [1, 0, 0, 1, 0, 0]; continue; }
    if (fn === OPS.transform) { ctm = multiplicar(ctm, args); continue; }

    if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintJpegXObject ||
      fn === OPS.paintImageXObjectRepeat ||
      fn === OPS.paintInlineImageXObject
    ) {
      const caixa = caixaDoQuadradoUnitario(ctm, H);
      if (caixa.largura > 1 && caixa.altura > 1) {
        imagens.push({ ...caixa, nome: typeof args?.[0] === 'string' ? args[0] : '' });
      }
    }
  }

  return { largura: viewport.width, altura: H, textos, imagens };
}

async function abrirPdf(caminhoOuBuffer) {
  const pdfjs = await carregarPdfjs();
  const fs = require('fs');
  const dados = typeof caminhoOuBuffer === 'string'
    ? new Uint8Array(fs.readFileSync(caminhoOuBuffer))
    : new Uint8Array(caminhoOuBuffer);
  return pdfjs.getDocument({
    data: dados,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
}

module.exports = { abrirPdf, lerPagina };
