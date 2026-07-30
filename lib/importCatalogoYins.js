'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

/**
 * Leitura dos catálogos em PDF da Yin's.
 *
 * DIFERENÇA PARA AS OUTRAS MARCAS
 * Na Maxprint e na Samsonite o PDF é só a foto: preço, saldo e descrição vêm de
 * planilha ou do HTML da fábrica. Na Yin's não existe base nenhuma além do
 * catálogo — código, descrição, custo, imposto e situação de estoque saem todos
 * daqui. Se a leitura erra, o catálogo do cliente nasce errado.
 *
 * TRÊS DESENHOS DE PÁGINA NA MESMA PASTA
 *   A1 · uma página por produto, com as cores em chips embaixo: cada chip tem
 *        foto, código próprio, nome da cor e a tarja de situação.
 *   A2 · duas ou três fichas empilhadas na mesma página, sem chips. É o desenho
 *        da Papelaria inteira.
 *   ST · "story" 750x1334, quatro produtos por página em grade 2x2. Aqui o EAN
 *        vem escrito; no A4 ele é código de barras em imagem.
 * O desenho é detectado por página, então um PDF misto funciona.
 *
 * POR COORDENADA, NÃO POR ORDEM DO TEXTO
 * As fichas A4 têm rótulos girados 90° em volta da foto ("RODAS 360°", "CINTA
 * ELÁSTICA"). Lidos em sequência, embaralham tudo. Cada palavra é lida com a
 * posição dela (`pdftotext -bbox-layout`) e casada por onde está na página.
 *
 * TEXTO FANTASMA — a parte que mais importa
 * Os catálogos são refeitos em cima do arquivo anterior e sobra entulho
 * invisível: preço em branco sem o selo colorido por baixo, código de outro
 * produto escondido atrás da foto. O `pdftotext` lê isso igual ao texto de
 * verdade. Medido nos arquivos de 27/07/2026: a página 2 do catálogo de viagem
 * tem um "R$147,00" que ninguém enxerga, e a 4, um "R$178,00". Sem o filtro, a
 * importação inventaria preço que o cliente nunca viu. Ver `fantasmasDaPagina`.
 *
 * Depende do poppler (pdftotext, pdftohtml, pdftoppm), que já é usado pelo
 * importador de catálogo da Samsonite.
 */

/* ------------------------------------------------------------------ *
 * Ferramentas externas
 * ------------------------------------------------------------------ */

const FERRAMENTAS = ['pdftotext', 'pdftohtml', 'pdftoppm'];

async function conferirFerramentas() {
  const faltando = [];
  for (const f of FERRAMENTAS) {
    try { await execFileAsync('which', [f]); } catch (_) { faltando.push(f); }
  }
  if (faltando.length) {
    throw new Error(
      `Faltam no servidor: ${faltando.join(', ')}. Instale com "apt install poppler-utils".`
    );
  }
}

const OPCOES_EXEC = { maxBuffer: 1024 * 1024 * 256 };

/* ------------------------------------------------------------------ *
 * Palavras com posição
 * ------------------------------------------------------------------ */

const RE_PAGINA = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
const RE_PALAVRA = /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/word>/g;

function desescapar(t) {
  return String(t)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Todas as páginas do PDF, cada uma com as palavras e onde elas estão. */
async function lerPalavras(caminhoPdf) {
  const { stdout } = await execFileAsync(
    'pdftotext', ['-bbox-layout', caminhoPdf, '-'], OPCOES_EXEC);
  const paginas = [];
  let mp;
  RE_PAGINA.lastIndex = 0;
  while ((mp = RE_PAGINA.exec(stdout))) {
    const corpo = mp[3];
    const palavras = [];
    let mw;
    RE_PALAVRA.lastIndex = 0;
    while ((mw = RE_PALAVRA.exec(corpo))) {
      const txt = desescapar(mw[5]).trim();
      if (!txt) continue;
      palavras.push({
        x: parseFloat(mw[1]), y: parseFloat(mw[2]),
        x2: parseFloat(mw[3]), y2: parseFloat(mw[4]), txt,
      });
    }
    paginas.push({ largura: parseFloat(mp[1]), altura: parseFloat(mp[2]), palavras });
  }
  return paginas;
}

/** Agrupa palavras em linhas pela altura, para os trechos que são texto corrido. */
function emLinhas(palavras, tol = 3) {
  const ordenadas = [...palavras].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const linhas = [];
  let atual = [];
  let base = null;
  for (const w of ordenadas) {
    if (base === null || Math.abs(w.y - base) <= tol) {
      if (base === null) base = w.y;
      atual.push(w);
    } else {
      linhas.push(atual); atual = [w]; base = w.y;
    }
  }
  if (atual.length) linhas.push(atual);
  return linhas.map((l) => {
    const ord = [...l].sort((a, b) => a.x - b.x);
    return {
      y: Math.min(...l.map((w) => w.y)),
      x: Math.min(...l.map((w) => w.x)),
      txt: ord.map((w) => w.txt).join(' '),
      palavras: ord,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Texto invisível
 * ------------------------------------------------------------------ */

const RE_TEXTO_XML = /<text top="(-?\d+)" left="(-?\d+)" width="(\d+)" height="(\d+)" font="(\d+)">([\s\S]*?)<\/text>/g;
const RE_FONTE = /<fontspec id="(\d+)"[^>]*color="([^"]+)"/g;
const RE_ALTURA_PAGINA = /<page number="\d+"[^>]*height="(\d+)"/;

function corClara(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255)) / 3 > 200;
}

/**
 * Trechos de texto que estão no arquivo mas NÃO aparecem na página.
 *
 * O teste não depende de adivinhação: renderiza a página a 60 dpi e olha o que
 * há ATRÁS de cada texto. Letra clara sobre fundo claro não existe para o
 * cliente. Uma segunda passada derruba texto que se sobrepõe a outro texto —
 * material bem feito não empilha duas frases no mesmo lugar; quando empilha, a
 * de trás é sobra de versão anterior, e é a que tem fundo claro atrás.
 */
async function fantasmasDaPagina(caminhoPdf, pagina, alturaPdf, pastaTmp, sharp) {
  const base = path.join(pastaTmp, `f${pagina}`);
  try {
    await execFileAsync('pdftohtml',
      ['-xml', '-i', '-f', String(pagina), '-l', String(pagina), caminhoPdf, base], OPCOES_EXEC);
    await execFileAsync('pdftoppm',
      ['-r', '60', '-jpeg', '-singlefile', '-f', String(pagina), '-l', String(pagina),
        caminhoPdf, base + 'r'], OPCOES_EXEC);
  } catch (_) {
    return [];
  }

  const xml = base + '.xml';
  const img = base + 'r.jpg';
  if (!fs.existsSync(xml) || !fs.existsSync(img)) return [];

  const conteudo = fs.readFileSync(xml, 'utf8');
  const alturaXml = Number((RE_ALTURA_PAGINA.exec(conteudo) || [])[1] || 0);
  if (!alturaXml) return [];

  const fontes = {};
  let mf;
  RE_FONTE.lastIndex = 0;
  while ((mf = RE_FONTE.exec(conteudo))) fontes[mf[1]] = mf[2];

  const { data, info } = await sharp(img).raw().toBuffer({ resolveWithObject: true });
  const escalaImg = info.height / alturaXml;
  const escalaPdf = alturaPdf / alturaXml;
  const canais = info.channels;

  const pixel = (x, y) => {
    const i = (y * info.width + x) * canais;
    return [data[i], data[i + 1], data[i + 2]];
  };

  const medidos = [];
  let mt;
  RE_TEXTO_XML.lastIndex = 0;
  while ((mt = RE_TEXTO_XML.exec(conteudo))) {
    const top = Number(mt[1]), left = Number(mt[2]);
    const w = Number(mt[3]), h = Number(mt[4]);
    const texto = desescapar(mt[6].replace(/<[^>]+>/g, '')).trim();
    if (!texto || w <= 0 || h <= 0) continue;

    let x0 = Math.max(0, Math.min(Math.round(left * escalaImg), info.width - 1));
    let y0 = Math.max(0, Math.min(Math.round(top * escalaImg), info.height - 1));
    let x1 = Math.max(x0 + 1, Math.min(Math.round((left + w) * escalaImg), info.width));
    let y1 = Math.max(y0 + 1, Math.min(Math.round((top + h) * escalaImg), info.height));

    let total = 0, claros = 0, maisEscuro = 255;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const [r, g, b] = pixel(x, y);
        const menor = Math.min(r, g, b);
        if (menor > 235) claros++;
        if (menor < maisEscuro) maisEscuro = menor;
        total++;
      }
    }
    const fracaoClara = total ? claros / total : 0;
    const fonteClara = corClara(fontes[mt[5]]);
    medidos.push({
      x0: left, y0: top, x1: left + w, y1: top + h,
      texto, fracaoClara, fonteClara, maisEscuro,
      fantasma: fonteClara && fracaoClara > 0.5 && maisEscuro > 215,
    });
  }

  for (let i = 0; i < medidos.length; i++) {
    const a = medidos[i];
    if (a.fantasma || !a.fonteClara) continue;
    for (let j = i + 1; j < medidos.length; j++) {
      const b = medidos[j];
      if (b.fantasma || !b.fonteClara) continue;
      const larg = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const alt = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (larg <= 0 || alt <= 0) continue;
      const menor = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
      if (menor <= 0 || (larg * alt) / menor < 0.3) continue;
      const perdedor = a.fracaoClara > b.fracaoClara ? a : b;
      if (perdedor.fracaoClara > 0.3) perdedor.fantasma = true;
    }
  }

  return medidos.filter((m) => m.fantasma).map((m) => ({
    x0: m.x0 * escalaPdf, y0: m.y0 * escalaPdf,
    x1: m.x1 * escalaPdf, y1: m.y1 * escalaPdf, texto: m.texto,
  }));
}

function tirarFantasmas(palavras, fantasmas) {
  if (!fantasmas.length) return palavras;
  return palavras.filter((p) => {
    const cx = (p.x + p.x2) / 2, cy = (p.y + p.y2) / 2;
    return !fantasmas.some((f) =>
      cx >= f.x0 - 1 && cx <= f.x1 + 1 && cy >= f.y0 - 2 && cy <= f.y1 + 2);
  });
}

/* ------------------------------------------------------------------ *
 * Imagens com posição
 * ------------------------------------------------------------------ */

const RE_IMAGEM = /<image top="(-?\d+)" left="(-?\d+)" width="(\d+)" height="(\d+)" src="([^"]+)"/g;

async function imagensDaPagina(caminhoPdf, pagina, alturaPdf, pastaTmp) {
  const base = path.join(pastaTmp, `i${pagina}`);
  try {
    await execFileAsync('pdftohtml',
      ['-xml', '-f', String(pagina), '-l', String(pagina), caminhoPdf, base], OPCOES_EXEC);
  } catch (_) {
    return [];
  }
  const xml = base + '.xml';
  if (!fs.existsSync(xml)) return [];
  const conteudo = fs.readFileSync(xml, 'utf8');
  const alturaXml = Number((RE_ALTURA_PAGINA.exec(conteudo) || [])[1] || 0);
  if (!alturaXml) return [];
  // A escala vem da altura REAL da página. Chumbar A4 aqui jogaria as fotos dos
  // catálogos story (750x1334) para coordenadas erradas, e a foto de um produto
  // cairia dentro da ficha do vizinho.
  const escala = alturaXml / alturaPdf;

  const imgs = [];
  let mi;
  RE_IMAGEM.lastIndex = 0;
  while ((mi = RE_IMAGEM.exec(conteudo))) {
    const arq = path.join(pastaTmp, path.basename(mi[5]));
    if (!fs.existsSync(arq)) continue;
    imgs.push({
      arq,
      y: Number(mi[1]) / escala, x: Number(mi[2]) / escala,
      w: Number(mi[3]) / escala, h: Number(mi[4]) / escala,
    });
  }
  return imgs;
}

/** A maior imagem cujo CENTRO cai dentro da caixa da ficha. */
function dentroDaCaixa(imgs, caixa, minimo = 60) {
  const grandes = imgs.filter((i) => i.w >= minimo && i.h >= minimo);
  if (!caixa) return grandes;
  return grandes.filter((i) => {
    const cx = i.x + i.w / 2, cy = i.y + i.h / 2;
    return cx >= caixa.x0 && cx <= caixa.x1 && cy >= caixa.y0 && cy <= caixa.y1;
  });
}

function maiorImagem(imgs) {
  if (!imgs.length) return null;
  return imgs.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
}

/** A foto de um chip de cor fica logo ACIMA do código, na mesma coluna. */
function fotoDoChip(imgs, xCentro, yCodigo) {
  const cands = imgs.filter((i) =>
    i.w >= 40 && i.h >= 40 &&
    i.y + i.h <= yCodigo + 12 &&
    i.x - 25 <= xCentro && xCentro <= i.x + i.w + 25);
  if (!cands.length) return null;
  return cands.reduce((a, b) => (a.y >= b.y ? a : b));
}

module.exports = {
  conferirFerramentas,
  lerPalavras,
  emLinhas,
  fantasmasDaPagina,
  tirarFantasmas,
  imagensDaPagina,
  dentroDaCaixa,
  maiorImagem,
  fotoDoChip,
  desescapar,
};

/* ================================================================== *
 * Leitura das fichas
 * ================================================================== */

const RE_SIT = /^(REGULAR|REDUZIDO|ZERADO|PR[ÉE][\s-]?VENDA|PR[ÉE])$/i;
const RE_SIT_TEXTO = /\b(REGULAR|REDUZIDO|ZERADO|PR[ÉE][\s-]?VENDA)\b/i;
const RE_COD = /^[A-Z]{2}\d{3,6}[A-Z0-9\-.]{0,12}$/;
const RE_IPI = /([\d,.]+)\s*%\s*IPI/i;
const RE_PRECO = /R\$\s?([\d.]+,\d{2})/;

/** Situação normalizada. São QUATRO tarjas, não três: a PRÉ-VENDA apareceu nos
 *  catálogos de Volta às Aulas e Mochilas e deixava 78 fichas mudas. */
function normalizarSituacao(txt) {
  const t = String(txt || '').trim().toUpperCase();
  if (t.startsWith('PR')) return 'PRE-VENDA';
  return t;
}

/** "6,5" / "6.5" / "6,5," viram 6.5. Devolve null no que não for número.
 *  O catálogo de papelaria trouxe "+6,5.% IPI" numa ficha, e um Number() cru
 *  contaminava o preço inteiro com NaN. */
function numero(txt) {
  if (txt === null || txt === undefined) return null;
  const t = String(txt).trim().replace(/\./g, '').replace(',', '.').replace(/\.$/, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function achar(re, texto) {
  const m = re.exec(texto);
  return m ? m[1] : '';
}

/* --------------------------- chips de cor -------------------------- */

/**
 * Chips do desenho A4, casados pela posição horizontal.
 *
 * A conta é palavra a palavra, e não por linha: as quatro tarjas dividem a
 * mesma altura, então "a linha" é a fileira inteira. E há páginas com código
 * invisível de versão anterior por baixo — preferir o código que começa como o
 * REF da página é o que separa o dado bom do lixo herdado.
 */
function coresA4(palavras, ref) {
  const prefixo = (/^[A-Z]+\d+/i.exec(String(ref).toUpperCase()) || [String(ref).toUpperCase().slice(0, 6)])[0];
  const centro = (w) => (w.x + w.x2) / 2;

  const tarjas = palavras.filter((w) => RE_SIT.test(w.txt)).sort((a, b) => a.x - b.x);
  const marcas = palavras.filter((w) => w.txt.toLowerCase().replace(/:$/, '') === 'cor').sort((a, b) => a.x - b.x);
  const codigos = palavras.filter((w) => RE_COD.test(w.txt));

  return tarjas.map((s) => {
    const cs = centro(s);
    let marca = null;
    for (const m of marcas) {
      if (s.y - m.y > 0 && s.y - m.y < 40 && Math.abs(centro(m) - cs) < 80) {
        if (!marca || m.y > marca.y) marca = m;
      }
    }
    let nome = '';
    if (marca) {
      const seguintes = marcas.filter((m) => m.x > marca.x + 5).map((m) => m.x);
      const limite = seguintes.length ? Math.min(...seguintes) : marca.x + 140;
      nome = palavras
        .filter((w) => Math.abs(w.y - marca.y) <= 3 && w.x > marca.x && w.x < limite && w !== marca)
        .sort((a, b) => a.x - b.x).map((w) => w.txt).join(' ').replace(/^[:\s]+/, '').trim();
    }
    const alvoY = marca ? marca.y : s.y;
    const cands = codigos
      .filter((c) => alvoY - c.y > 0 && alvoY - c.y < 26 && Math.abs(centro(c) - cs) < 80)
      .sort((a, b) => {
        const pa = a.txt.toUpperCase().startsWith(prefixo) ? 0 : 1;
        const pb = b.txt.toUpperCase().startsWith(prefixo) ? 0 : 1;
        return pa - pb || Math.abs(centro(a) - cs) - Math.abs(centro(b) - cs);
      });
    return { codigo: cands.length ? cands[0].txt : '', cor: nome, situacao: normalizarSituacao(s.txt) };
  });
}

/* ------------------------------- A4 -------------------------------- */

function lerPaginaA4(pg, npag) {
  const ws = pg.palavras;
  const refs = ws.filter((w) => w.txt.toUpperCase().startsWith('REF')).sort((a, b) => a.y - b.y);

  const ancoras = [];
  for (const r of refs) {
    const cod = ws.filter((w) => Math.abs(w.y - r.y) <= 4 && w.x >= r.x2 && w.x < r.x2 + 60)
      .sort((a, b) => a.x - b.x);
    if (cod.length) ancoras.push({ ref: cod[0].txt.trim(), y: r.y, x: r.x });
  }
  if (!ancoras.length) return [];

  const itens = [];
  ancoras.forEach((a, k) => {
    const y0 = a.y - 20;
    const y1 = k + 1 < ancoras.length ? ancoras[k + 1].y - 20 : pg.altura;
    const faixa = ws.filter((w) => w.y >= y0 && w.y < y1);
    const it = montarA4(faixa, a.ref, npag, ancoras.length > 1);
    if (it) {
      // Caixa da ficha: a foto é procurada SÓ aqui dentro. Sem isso, duas
      // fichas na mesma página levam a mesma foto.
      it.caixa = { x0: 0, x1: 470, y0, y1: Math.min(y1, pg.altura) };
      itens.push(it);
    }
  });
  return itens;
}

function montarA4(ws, ref, npag, compacta) {
  const ls = emLinhas(ws);
  const texto = ls.map((l) => l.txt).join('\n');

  const lref = ls.find((l) => l.txt.startsWith('REF'));
  let nome = '', descricao = '';
  if (lref) {
    const direita = ls
      .filter((l) => l.x > lref.x + 60 && l.y < lref.y + 30 && !/^R\$/.test(l.txt))
      .sort((a, b) => a.y - b.y);
    if (direita.length) nome = direita[0].txt;
    if (direita.length > 1 && !/NCM|DOWNLOADS|CAIXA|REGULAR|REDUZIDO|ZERADO|PR[ÉE]|%/i.test(direita[1].txt)) {
      descricao = direita[1].txt;
    }
  }

  const precos = [];
  ls.forEach((l, i) => {
    const mp = RE_PRECO.exec(l.txt);
    if (!mp) return;
    const v = numero(mp[1]);
    if (v === null) return;
    const contexto = ls.slice(i, i + 3).map((x) => x.txt).join(' ');
    let condicao = '';
    for (let j = i; j < Math.min(i + 3, ls.length); j++) {
      const mc = /(CAIXA MASTER:\s*[^|]+|VALOR UNIT[ÁA]RIO)/i.exec(ls[j].txt);
      if (mc) { condicao = mc[1].trim(); break; }
    }
    const ipi = RE_IPI.exec(contexto);
    precos.push({
      valor: v,
      ipi: ipi ? numero(ipi[1]) : null,
      st: /\+\s*ST\b/i.test(contexto),
      condicao,
    });
  });

  // Ficha com um preço só: o imposto pode estar na linha de cima ou de baixo do
  // valor, dependendo de quanto texto a ficha tem. Não há a quem confundir.
  if (precos.length === 1 && precos[0].ipi === null) {
    const ipi = RE_IPI.exec(texto);
    if (ipi) precos[0].ipi = numero(ipi[1]);
  }
  if (precos.length === 1 && !precos[0].st) precos[0].st = /\+\s*ST\b/i.test(texto);

  let cores = coresA4(ws, ref);
  if (!cores.length || cores.every((c) => !c.codigo)) {
    // Ficha compacta: um código só, o próprio REF, com a cor na linha "COR:".
    const ms = RE_SIT_TEXTO.exec(texto);
    const mcor = /\bCORE?S?:\s*([^|\n]+)/i.exec(texto);
    cores = [{
      codigo: ref,
      cor: mcor ? mcor[1].trim() : '',
      situacao: ms ? normalizarSituacao(ms[1]) : '',
    }];
  }

  return {
    pagina: npag,
    layout: compacta ? 'A4-compacta' : 'A4',
    ref,
    nome,
    descricao,
    precos,
    cores,
    coresAnunciadas: achar(/CORES:\s*([^|\n]+)/, texto).trim(),
    tamanho: achar(/TAM(?:ANHO)?\.?:\s*([^|\n]+)/, texto).trim(),
    caixaMaster: achar(/CAIXA MASTER:\s*([^|\n]+)/, texto).trim(),
    embalagem: achar(/EMB(?:ALAGEM)?:\s*([^|\n]+)/i, texto).trim(),
    ncm: achar(/NCM:\s*([\d.]+)/, texto),
    ean: achar(/EAN:\s*(\d{8,14})/, texto),
    lancamento: /LAN[ÇC]A/i.test(texto),
    textoFicha: texto,
  };
}

/* ------------------------------ story ------------------------------ */

function lerPaginaStory(pg, npag) {
  const ws = pg.palavras;
  const meio = pg.largura / 2;
  const itens = [];
  for (const lado of ['esq', 'dir']) {
    const filtro = lado === 'esq' ? (w) => w.x < meio - 5 : (w) => w.x >= meio - 5;
    const ls = emLinhas(ws.filter(filtro));
    let bloco = [];
    for (const l of ls) {
      bloco.push(l);
      if (/\bEAN:/.test(l.txt) || /\bNCM:/.test(l.txt)) {
        const it = montarStory(bloco, npag, lado);
        if (it) {
          it.caixa = {
            x0: lado === 'esq' ? 0 : meio - 10,
            x1: lado === 'esq' ? meio + 10 : pg.largura,
            y0: Math.min(...bloco.map((b) => b.y)) - 6,
            y1: Math.max(...bloco.map((b) => b.y)) + 10,
          };
          itens.push(it);
        }
        bloco = [];
      }
    }
  }
  return itens;
}

function montarStory(linhas, npag, lado) {
  const texto = linhas.map((l) => l.txt).join('\n');
  const mref = /REF\.\s?([A-Z0-9][A-Z0-9\-./]{2,20})/i.exec(texto);
  if (!mref) return null;
  const ref = mref[1].trim();

  // O título é o que vem ANTES da primeira linha de ficha técnica. Sem esse
  // corte, "LENÇO ESTAMPADO JULIA" virava "LENÇO ESTAMPADO JULIA MATERIAL:
  // POLIÉSTER | TAM: 90X180CM +6,5%IPI +ST EMB: 1PEÇA" no nome do produto.
  const FICHA = /R\$|EAN|NCM|CORES?:|EMB\b|EMBALAGEM|CX\.?\s?MASTER|MATERIAL|TAM\b|TAM\.|LAN[ÇC]A|MENTO|%|PEDIDO M[IÍ]NIMO|SUM[ÁA]RIO|^TABELA/i;
  let titulo = '';
  let descricao = '';
  for (const l of linhas) {
    const t = l.txt.trim();
    if (!t || /^REF\./i.test(t)) continue;
    if (FICHA.test(t)) {
      if (!descricao && /MATERIAL|TAM/i.test(t)) descricao = t;
      if (titulo) break;
      continue;
    }
    titulo = titulo ? titulo + ' ' + t : t;
    if (titulo.length > 90) break;
  }

  const precos = [];
  const re = /R\$\s?([\d.]+,\d{2})/g;
  let mp;
  while ((mp = re.exec(texto))) {
    const v = numero(mp[1]);
    if (v === null) continue;
    const trecho = texto.slice(mp.index, mp.index + 60);
    const ipi = RE_IPI.exec(trecho);
    precos.push({ valor: v, ipi: ipi ? numero(ipi[1]) : null, st: /\+\s*ST\b/i.test(trecho), condicao: '' });
  }
  if (precos.length === 1 && precos[0].ipi === null) {
    const ipi = RE_IPI.exec(texto);
    if (ipi) precos[0].ipi = numero(ipi[1]);
  }

  const ms = RE_SIT_TEXTO.exec(texto);
  const mcor = /CORES:\s*([^\n]+)/i.exec(texto);
  return {
    pagina: npag,
    layout: 'story-' + lado,
    ref,
    nome: titulo.trim(),
    descricao: descricao.trim(),
    precos,
    cores: [{ codigo: ref, cor: mcor ? mcor[1].trim() : '', situacao: ms ? normalizarSituacao(ms[1]) : '' }],
    coresAnunciadas: mcor ? mcor[1].trim() : '',
    tamanho: achar(/TAM\.?:\s*([^\n]+)/i, texto).trim(),
    caixaMaster: achar(/CX\.MASTER:\s*([^\n]+)/i, texto).trim(),
    embalagem: achar(/EMB(?:ALAGEM)?:\s*([^\n|]+)/i, texto).trim(),
    ncm: achar(/NCM:\s*([\d.]+)/, texto),
    ean: achar(/EAN:\s*(\d{8,14})/, texto),
    lancamento: /LAN[ÇC]A/i.test(texto),
    textoFicha: texto,
  };
}

module.exports.lerPaginaA4 = lerPaginaA4;
module.exports.lerPaginaStory = lerPaginaStory;
module.exports.coresA4 = coresA4;
module.exports.normalizarSituacao = normalizarSituacao;
module.exports.numero = numero;

/* ================================================================== *
 * Segmentos, tirados do sumário do próprio catálogo
 * ================================================================== */

/**
 * Cada catálogo abre com um índice clicável ("clique nas categorias abaixo
 * para ir direto à sessão dos produtos"). Os links apontam para a página onde
 * a seção começa. Lendo o texto do link e resolvendo o destino sai a
 * segmentação da própria fábrica — melhor do que qualquer categoria inventada
 * por mim. No catálogo de Mochilas: Executivas, Casuais, Maternidade,
 * Esportivas, Sacolas Esportivas, Sacolas de Viagem.
 */
async function lerSecoes(caminhoPdf, paginas) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (_) {
    return [];
  }
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(fs.readFileSync(caminhoPdf)),
      useSystemFonts: true,
      disableFontFace: true,
    }).promise;
  } catch (_) {
    return [];
  }

  const achados = [];
  const limite = Math.min(6, doc.numPages);   // o sumário mora nas primeiras
  for (let n = 1; n <= limite; n++) {
    let page, anots;
    try {
      page = await doc.getPage(n);
      anots = await page.getAnnotations();
    } catch (_) { continue; }

    for (const a of anots || []) {
      if (a.subtype !== 'Link' || !a.dest) continue;
      let destino = null;
      try {
        const d = typeof a.dest === 'string' ? await doc.getDestination(a.dest) : a.dest;
        if (Array.isArray(d) && d[0]) destino = (await doc.getPageIndex(d[0])) + 1;
      } catch (_) { destino = null; }
      if (!destino || destino <= n) continue;
      if (!Array.isArray(a.rect) || a.rect.length < 4) continue;
      // O /Rect não vem normalizado: em alguns catálogos o y de cima vem
      // primeiro. Sem ordenar, a faixa fica invertida e nenhuma palavra cai
      // dentro do link.
      const xs = [a.rect[0], a.rect[2]].sort((p, q) => p - q);
      const ys = [a.rect[1], a.rect[3]].sort((p, q) => p - q);
      achados.push({ paginaLink: n, destino, x0: xs[0], x1: xs[1], y0: ys[0], y1: ys[1] });
    }
  }
  try { await doc.destroy(); } catch (_) {}
  if (!achados.length) return [];

  // O texto do link: as palavras da mesma página que caem dentro do retângulo.
  // O PDF conta o y de baixo para cima; o pdftotext conta de cima para baixo.
  for (const a of achados) {
    const pg = paginas[a.paginaLink - 1];
    if (!pg) { a.nome = ''; continue; }
    const yTopo = pg.altura - a.y1;
    const yBase = pg.altura - a.y0;
    const dentro = pg.palavras.filter((w) => {
      const cx = (w.x + w.x2) / 2, cy = (w.y + w.y2) / 2;
      return cx >= a.x0 - 2 && cx <= a.x1 + 2 && cy >= yTopo - 3 && cy <= yBase + 3;
    }).sort((p, q) => (Math.round(p.y / 3) - Math.round(q.y / 3)) || (p.x - q.x));
    const bruto = dentro.map((w) => w.txt).join(' ');
    // Em alguns catálogos o retângulo do link encosta na faixa de EAN/NCM da
    // ficha de baixo; e o próprio "Sumário" não é seção.
    const nome = bruto.split(/\s*(?:EAN|NCM)\s*:/)[0].trim().replace(/^[.|\-\s]+|[.|\-\s]+$/g, '');
    a.nome = /^sum[áa]rio$/i.test(nome) ? '' : nome;
  }

  const nomeados = achados
    .filter((a) => a.nome && a.nome.length > 2 && !/^[\d\W]+$/.test(a.nome))
    .sort((a, b) => a.destino - b.destino);

  return nomeados.map((a, k) => ({
    nome: a.nome,
    de: a.destino,
    ate: k + 1 < nomeados.length ? nomeados[k + 1].destino - 1 : 1e6,
  }));
}

function segmentoDaPagina(secoes, pagina) {
  const s = (secoes || []).find((x) => pagina >= x.de && pagina <= x.ate);
  return s ? s.nome : '';
}

module.exports.lerSecoes = lerSecoes;
module.exports.segmentoDaPagina = segmentoDaPagina;

/* ================================================================== *
 * Importação de um catálogo inteiro
 * ================================================================== */

const crypto = require('crypto');

function limpo(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

function normalizarCodigoYins(codigo) {
  return String(codigo || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/**
 * O que o cliente compra de fato: peça, embalagem, kit, par ou jogo.
 *
 * Importa porque muda o pedido. Na Papelaria o preço vem marcado "(valor
 * embalagem)" com "EMBALAGEM: 12 PEÇAS" — quem digita 24 achando que são 24
 * peças está pedindo 288.
 */
function unidadeDeVenda(item) {
  const t = String(item.textoFicha || '').toUpperCase();
  if (/VALOR\s+EMBALAGEM/.test(t) || /EMBALAGEM:\s*\d+\s*PE[ÇC]AS/.test(t)) return 'embalagem';
  const emb = (item.embalagem || '').toUpperCase() + ' ' + (item.caixaMaster || '').toUpperCase();
  if (/\bKIT/.test(emb)) return 'kit';
  if (/\bPAR\b|\bPARES\b/.test(emb)) return 'par';
  if (/\bJOGO/.test(emb)) return 'jogo';
  if (/\bBLISTER/.test(emb)) return 'blister';
  return 'peça';
}

function pedidoMinimoDe(item) {
  const m = /PEDIDO\s+M[IÍ]NIMO:\s*(\d+)/i.exec(item.textoFicha || '');
  return m ? Number(m[1]) : 0;
}

/**
 * Lê um catálogo inteiro e devolve um registro por SKU, com a foto de cada um.
 *
 * @param {string} caminhoPdf
 * @param {object} opcoes
 *   pastaImagens  onde gravar as fotos
 *   prefixo       prefixo do nome do arquivo de foto
 *   titulo        nome do catálogo (vira a categoria do produto)
 *   porConteudo   Map compartilhado entre catálogos: sha1 da foto -> código.
 *                 Foto que já é de outro código não vale para este; melhor sem
 *                 foto do que com a foto do vizinho.
 *   aoAndar       callback({pagina, total, produtos})
 */
async function importarCatalogoYins(caminhoPdf, opcoes = {}) {
  const {
    pastaImagens,
    prefixo = 'yins',
    titulo = '',
    porConteudo = new Map(),
    aoAndar = () => {},
  } = opcoes;

  await conferirFerramentas();
  const sharp = require('sharp');
  fs.mkdirSync(pastaImagens, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yins-'));

  const avisos = [];
  const aviso = (t) => { if (avisos.length < 500) avisos.push(t); };
  const produtos = [];
  const vistos = new Set();

  try {
    const paginas = await lerPalavras(caminhoPdf);
    const secoes = await lerSecoes(caminhoPdf, paginas);

    for (let n = 1; n <= paginas.length; n++) {
      const pg = paginas[n - 1];
      const fantasmas = await fantasmasDaPagina(caminhoPdf, n, pg.altura, tmp, sharp);
      const limpas = { ...pg, palavras: tirarFantasmas(pg.palavras, fantasmas) };

      const itens = limpas.largura < 700 ? lerPaginaA4(limpas, n) : lerPaginaStory(limpas, n);
      if (itens.length) {
        const imgs = await imagensDaPagina(caminhoPdf, n, pg.altura, tmp);
        const ws = limpas.palavras;

        for (const it of itens) {
          const unidade = unidadeDeVenda(it);
          const minimo = pedidoMinimoDe(it);
          const precos = it.precos || [];
          const unitario = precos.find((p) => /UNIT/i.test(p.condicao || ''));
          const principal = unitario || precos[0] || null;
          const caixa = precos.find((p) => p !== principal && /CAIXA/i.test(p.condicao || ''));

          for (const sku of it.cores) {
            const codigo = normalizarCodigoYins(sku.codigo || it.ref);
            if (!codigo) continue;
            if (vistos.has(codigo)) { aviso(`pág ${n}: código repetido ${codigo}`); continue; }
            vistos.add(codigo);

            let arquivo = '';
            const alvo = ws.filter((w) => w.txt === sku.codigo);
            let foto = null;
            if (alvo.length && it.layout === 'A4') {
              foto = fotoDoChip(imgs, (alvo[0].x + alvo[0].x2) / 2, alvo[0].y);
            }
            if (!foto) foto = maiorImagem(dentroDaCaixa(imgs, it.caixa));

            if (foto) {
              try {
                const pronto = await sharp(foto.arq)
                  .flatten({ background: '#ffffff' })
                  .resize(900, 900, { fit: 'inside', withoutEnlargement: true })
                  .jpeg({ quality: 86 })
                  .toBuffer();
                const digital = crypto.createHash('sha1').update(pronto).digest('hex');
                const dono = porConteudo.get(digital);
                if (dono && dono !== codigo) {
                  aviso(`foto igual em ${dono} e ${codigo} — os dois ficam sem foto`);
                  const anterior = produtos.find((p) => p.codigo === dono);
                  if (anterior && anterior.imagem) {
                    try { fs.unlinkSync(path.join(pastaImagens, anterior.imagem)); } catch (_) {}
                    anterior.imagem = '';
                    anterior.fotoRepetida = true;
                  }
                } else {
                  arquivo = `${prefixo}-${codigo}.jpg`;
                  fs.writeFileSync(path.join(pastaImagens, arquivo), pronto);
                  porConteudo.set(digital, codigo);
                }
              } catch (e) {
                aviso(`${codigo}: falhou a foto (${e.message})`);
              }
            }

            produtos.push({
              codigo,
              codigoOriginal: limpo(sku.codigo || it.ref),
              ref: limpo(it.ref),
              nome: limpo(it.nome).slice(0, 160),
              descricao: limpo(it.descricao).slice(0, 300),
              catalogo: titulo,
              segmento: segmentoDaPagina(secoes, n) || titulo,
              pagina: n,
              cor: limpo(sku.cor),
              coresAnunciadas: limpo(it.coresAnunciadas),
              situacao: sku.situacao || '',
              preco: principal ? principal.valor : 0,
              precoCaixa: caixa ? caixa.valor : null,
              condicaoCaixa: caixa ? limpo(caixa.condicao) : '',
              ipi: principal ? principal.ipi : null,
              st: !!(principal && principal.st),
              unidadeVenda: unidade,
              embalagem: limpo(it.embalagem),
              caixaMaster: limpo(it.caixaMaster),
              pedidoMinimo: minimo,
              tamanho: limpo(it.tamanho),
              ncm: limpo(it.ncm),
              ean: limpo(it.ean),
              lancamento: !!it.lancamento,
              imagem: arquivo,
            });
          }
        }
      }

      if (n % 10 === 0 || n === paginas.length) {
        aoAndar({ pagina: n, total: paginas.length, produtos: produtos.length });
      }
      // A pasta temporária acumula uma imagem por foto de cada página; sem
      // limpar, um catálogo de 485 páginas enche o disco do servidor.
      for (const f of fs.readdirSync(tmp)) {
        try { fs.unlinkSync(path.join(tmp, f)); } catch (_) {}
      }
    }

    const relatorio = {
      catalogo: titulo,
      paginas: paginas.length,
      secoes: secoes.length,
      produtos: produtos.length,
      comFoto: produtos.filter((p) => p.imagem).length,
      semFoto: produtos.filter((p) => !p.imagem).length,
      semPreco: produtos.filter((p) => !p.preco).length,
      semSituacao: produtos.filter((p) => !p.situacao).length,
      fotosRepetidas: produtos.filter((p) => p.fotoRepetida).length,
    };
    return { produtos, relatorio, avisos, secoes };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports.importarCatalogoYins = importarCatalogoYins;
module.exports.normalizarCodigoYins = normalizarCodigoYins;
module.exports.unidadeDeVenda = unidadeDeVenda;
