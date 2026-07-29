'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { abrirPdf, lerPagina } = require('./pdfLayout');
const { normalizarCodigo, codigoPlausivel } = require('./codigo');

/**
 * Importador dos catálogos em PDF.
 *
 * O que ele tira de cada página: os "cards" de produto, com nome,
 * especificações, códigos (um por cor), tipo de embalagem, caixa master,
 * caixa inner, selo INMETRO, marcação de curva A e a FOTO.
 *
 * Como a foto é obtida
 * --------------------
 * Em vez de decodificar o objeto de imagem de dentro do PDF (que quebra em
 * JPEG2000, em máscara de transparência e em espaço de cor exótico), a página
 * inteira é rasterizada uma vez com o pdftoppm e depois a região da foto é
 * recortada. O resultado é exatamente o que se vê na página, sem surpresa de
 * decodificação — e ainda pega efeito de sombra e recorte aplicados no layout.
 *
 * Por que isso importa: o catálogo Logitech e o de promoções têm a camada de
 * texto incompleta (parte do conteúdo virou vetor no fechamento do arquivo).
 * A rasterização não se importa com isso.
 */

const DPI_RASTER = 150;
const MARGEM_TOPO = 52;    // acima disso é cabeçalho
const MARGEM_RODAPE = 40;  // abaixo disso é rodapé
const PAD_CLUSTER = Number(process.env.PAD_CLUSTER || 10);    // folga para juntar elementos do mesmo card

/**
 * Modelo comercial (M170, MK270, C920s, H390, K120, GHE1000...).
 * Serve de plano B quando o PDF não entrega o código: é o caso do catálogo
 * Logitech, em que só 10 dos 31 part-numbers sobraram na camada de texto.
 * O modelo aparece em letra grande no card E dentro da descrição da planilha
 * ("MOUSE SEM FIO LOGITECH M170 VERMELHO"), então dá para casar por ele.
 */
const RE_MODELO = /\b(?:MK|GHE|GMO|HBT|FBT|MX-[A-Z]?|[MKCHR])[- ]?\d{2,4}[A-Z]?\b/gi;

function acharModelos(texto) {
  const achados = new Set();
  const m = String(texto || '').match(RE_MODELO);
  if (m) {
    for (const t of m) {
      const limpo = t.toUpperCase().replace(/[\s-]/g, '');
      if (limpo.length >= 3) achados.add(limpo);
    }
  }
  return [...achados];
}

const RE_EMBALAGEM = /(CX\s*C\/?\s*\d+|CAIXA\s+COM\s+\d+|BLISTER|POTE\s*C\/?\s*\d+|ESTOJO|PL[ÁA]STICO\s*C\/?\s*\d+|DISPLAY|PACOTE|UNIT[ÁA]RIO|TIPO DE EMBALAGEM)/i;

/* ------------------------------------------------------------------ *
 * Agrupamento espacial (union-find simples)
 * ------------------------------------------------------------------ */

function intersecta(a, b, pad) {
  return !(
    a.x - pad > b.x + b.largura + pad ||
    b.x - pad > a.x + a.largura + pad ||
    a.y - pad > b.y + b.altura + pad ||
    b.y - pad > a.y + a.altura + pad
  );
}

function agrupar(elementos, pad) {
  const pai = elementos.map((_, i) => i);
  const raiz = (i) => (pai[i] === i ? i : (pai[i] = raiz(pai[i])));
  const unir = (i, j) => { const a = raiz(i), b = raiz(j); if (a !== b) pai[a] = b; };

  for (let i = 0; i < elementos.length; i++) {
    for (let j = i + 1; j < elementos.length; j++) {
      if (intersecta(elementos[i], elementos[j], pad)) unir(i, j);
    }
  }

  const grupos = new Map();
  elementos.forEach((el, i) => {
    const r = raiz(i);
    if (!grupos.has(r)) grupos.set(r, []);
    grupos.get(r).push(el);
  });
  return [...grupos.values()];
}

/* ------------------------------------------------------------------ *
 * Leitura de um card
 * ------------------------------------------------------------------ */

function juntarLinhas(textos) {
  // Agrupa por linha (mesma altura aproximada) e ordena da esquerda pra direita.
  const linhas = [];
  const ordenados = [...textos].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const t of ordenados) {
    const l = linhas.find((li) => Math.abs(li.y - t.y) < Math.max(3, t.altura * 0.5));
    if (l) { l.itens.push(t); l.y = (l.y + t.y) / 2; }
    else linhas.push({ y: t.y, itens: [t] });
  }
  return linhas.map((l) => ({
    y: l.y,
    tamanho: Math.max(...l.itens.map((i) => i.tamanho)),
    texto: l.itens.sort((a, b) => a.x - b.x).map((i) => i.texto).join(' ').replace(/\s+/g, ' ').trim(),
  }));
}

function lerCard(grupo, pagina) {
  const textos = grupo.filter((g) => g.tipo === 'texto');
  const imagens = grupo.filter((g) => g.tipo === 'imagem');
  if (!textos.length) return null;

  const linhas = juntarLinhas(textos);
  const textoCheio = linhas.map((l) => l.texto).join('\n');

  // Códigos: aceita os três formatos e descarta o que é medida ou quantidade.
  const codigos = [];
  const reCodigos = /\b(\d{3}-\d{6}|\d{2}\s\d{3,4}|\d{5,9})\b/g;
  let m;
  while ((m = reCodigos.exec(textoCheio)) !== null) {
    const bruto = m[1];
    // "QTD.: 144" e "46,7 x 25,8 x 46,3 cm" não são código.
    const antes = textoCheio.slice(Math.max(0, m.index - 14), m.index).toUpperCase();
    if (/QTD|X\s*$|,\s*$/.test(antes)) continue;
    const c = normalizarCodigo(bruto);
    if (codigoPlausivel(c) && !codigos.includes(c)) codigos.push(c);
  }

  // Nome: a linha de maior corpo de letra, tirando rótulos fixos do layout.
  const candidatasNome = linhas.filter(
    (l) => l.texto.length > 3 &&
      !/^(COD\.?:|CORES? DISPON|CAIXA (MASTER|INNER)|QTD|TIPO DE EMBALAGEM|SEM CAIXA)/i.test(l.texto) &&
      !/^[•·‣]/.test(l.texto) &&   // linha de especificação não é nome
      !/^\d/.test(l.texto)
  );
  const maiorCorpo = candidatasNome.length ? Math.max(...candidatasNome.map((l) => l.tamanho)) : 0;
  const nome = candidatasNome
    .filter((l) => l.tamanho >= maiorCorpo - 0.4)
    .sort((a, b) => a.y - b.y)
    .map((l) => l.texto)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!nome) return null;

  // Sem código e sem modelo, o card não serve para nada.
  const modelos = acharModelos(nome);
  if (!codigos.length && !modelos.length) return null;

  // Especificações: as linhas de bullet.
  const specs = linhas
    .filter((l) => /^[•·‣]/.test(l.texto))
    .map((l) => l.texto.replace(/^[•·‣]\s*/, '').trim())
    .filter(Boolean);

  // Só é variação de cor quando o próprio catálogo diz que é. Sem essa amarra,
  // um card que lista uma tabela de códigos (etiqueta, toner, refil) faz
  // produtos DIFERENTES virarem "cores" do mesmo item — e aí o cliente vê o
  // mesmo card mudando de preço ao clicar na bolinha, que foi o erro relatado.
  const temCores = /CORES?\s+DISPON[IÍ]VE/i.test(textoCheio);

  const emb = textoCheio.match(RE_EMBALAGEM);
  const master = textoCheio.match(/CAIXA MASTER:?\s*([\s\S]{0,60}?)QTD\.?:?\s*(\d+)/i);
  const inner = textoCheio.match(/CAIXA INNER:?\s*([\s\S]{0,60}?)QTD\.?:?\s*(\d+)/i);

  // Foto: a maior imagem do card. Selo INMETRO e etiqueta de curva A são
  // pequenos e ficam de fora por área.
  const foto = imagens
    .filter((i) => i.largura > 40 && i.altura > 40)
    .sort((a, b) => b.largura * b.altura - a.largura * a.altura)[0] || null;

  const caixa = grupo.reduce(
    (acc, g) => ({
      x: Math.min(acc.x, g.x),
      y: Math.min(acc.y, g.y),
      x1: Math.max(acc.x1, g.x + g.largura),
      y1: Math.max(acc.y1, g.y + g.altura),
    }),
    { x: Infinity, y: Infinity, x1: -Infinity, y1: -Infinity }
  );

  return {
    nome,
    codigos,
    temCores,
    modelos,
    especificacoes: specs,
    embalagem: emb ? emb[0].replace(/\s+/g, ' ').toUpperCase() : '',
    caixaMaster: master ? { medida: master[1].trim(), quantidade: Number(master[2]) } : null,
    caixaInner: inner ? { medida: inner[1].trim(), quantidade: Number(inner[2]) } : null,
    inmetro: /INMETRO/i.test(textoCheio),
    curvaA: /PRODUTO CURVA/i.test(textoCheio),
    pagina,
    foto,
    caixa,
    textoCheio,
  };
}

/* ------------------------------------------------------------------ *
 * Rasterização e recorte
 * ------------------------------------------------------------------ */

async function rasterizarPagina(caminhoPdf, numero, destino) {
  const prefixo = path.join(destino, `pg`);
  await execFileAsync('pdftoppm', [
    '-f', String(numero), '-l', String(numero),
    '-r', String(DPI_RASTER),
    '-png', '-singlefile',
    caminhoPdf, prefixo,
  ], { maxBuffer: 1024 * 1024 * 64 });
  return `${prefixo}.png`;
}

async function recortarFoto(pngPagina, foto, destinoArquivo, sharp) {
  const escala = DPI_RASTER / 72;
  const folga = 3; // um respiro para não cortar a sombra da foto
  const meta = await sharp(pngPagina).metadata();

  const left = Math.max(0, Math.round(foto.x * escala) - folga);
  const top = Math.max(0, Math.round(foto.y * escala) - folga);
  const width = Math.min(meta.width - left, Math.round(foto.largura * escala) + folga * 2);
  const height = Math.min(meta.height - top, Math.round(foto.altura * escala) + folga * 2);
  if (width < 10 || height < 10) return false;

  await sharp(pngPagina)
    .extract({ left, top, width, height })
    .resize({ width: 700, height: 700, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(destinoArquivo);
  return true;
}

/* ------------------------------------------------------------------ *
 * Entrada principal
 * ------------------------------------------------------------------ */

/**
 * @param {string} caminhoPdf
 * @param {object} opcoes
 *   pastaImagens  - onde gravar as fotos (uma por código)
 *   prefixo       - prefixo do nome do arquivo de imagem
 *   comFotos      - false para varredura rápida, sem rasterizar
 *   aoProgredir   - callback(paginaAtual, totalPaginas)
 */
async function importarCatalogo(caminhoPdf, opcoes = {}) {
  const {
    pastaImagens = null,
    prefixo = 'p',
    comFotos = true,
    aoProgredir = null,
  } = opcoes;

  const sharp = comFotos ? require('sharp') : null;
  const doc = await abrirPdf(caminhoPdf);
  const produtos = [];
  const avisos = [];
  let paginasComFalha = 0;
  let fotoSecao = ''; // foto ilustrativa da linha corrente

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
  if (pastaImagens) fs.mkdirSync(pastaImagens, { recursive: true });

  try {
    for (let n = 1; n <= doc.numPages; n++) {
      if (aoProgredir) aoProgredir(n, doc.numPages);
      let layout;
      try {
        const page = await doc.getPage(n);
        layout = await lerPagina(page);
      } catch (e) {
        paginasComFalha++;
        avisos.push(`Página ${n}: falhou na leitura (${e.message}).`);
        continue;
      }

      const limiteRodape = layout.altura - MARGEM_RODAPE;
      const elementos = [
        ...layout.textos
          .filter((t) => t.y > MARGEM_TOPO && t.y < limiteRodape)
          .map((t) => ({ ...t, tipo: 'texto' })),
        ...layout.imagens
          .filter((i) => i.y > MARGEM_TOPO && i.y < limiteRodape)
          .map((i) => ({ ...i, tipo: 'imagem' })),
      ];
      if (!elementos.length) continue;

      const grupos = agrupar(elementos, PAD_CLUSTER);
      const cards = grupos.map((g) => lerCard(g, n)).filter(Boolean);

      // Abertura de seção: página com título grande ("LINHA DE ETIQUETAS",
      // "REFIS DE TINTA"). A maior foto dessa página vira a foto da linha, e
      // serve de ilustração para os itens que aparecem só em tabela adiante —
      // etiqueta, toner, refil e papel fotográfico não têm foto individual no
      // catálogo. A imagem fica marcada como ilustrativa, nunca como a foto
      // exata do item.
      const tituloGrande = layout.textos.some((t) => t.tamanho >= 14 && t.y > MARGEM_TOPO && t.y < 300);
      const maiorImagem = elementos
        .filter((e) => e.tipo === 'imagem' && e.largura > 60 && e.altura > 60)
        .sort((a, b) => b.largura * b.altura - a.largura * a.altura)[0] || null;

      if (!cards.length && !(tituloGrande && maiorImagem)) continue;

      let png = null;
      if (comFotos && (cards.some((c) => c.foto) || (tituloGrande && maiorImagem))) {
        try {
          png = await rasterizarPagina(caminhoPdf, n, tmp);
        } catch (e) {
          avisos.push(`Página ${n}: não consegui rasterizar para recortar as fotos (${e.message}).`);
        }
      }

      if (png && tituloGrande && maiorImagem && pastaImagens) {
        const nomeArq = `${prefixo}-secao-${n}.png`;
        try {
          const ok = await recortarFoto(png, maiorImagem, path.join(pastaImagens, nomeArq), sharp);
          if (ok) fotoSecao = nomeArq;
        } catch (_) { /* seção sem foto não é problema */ }
      }

      for (const [idxCard, card] of cards.entries()) {
        const etiqueta = card.codigos[0] || card.modelos[0] || `c${idxCard}`;
        let arquivoImagem = '';
        if (png && card.foto && pastaImagens) {
          const nomeArq = `${prefixo}-${n}-${etiqueta}.png`;
          try {
            const ok = await recortarFoto(png, card.foto, path.join(pastaImagens, nomeArq), sharp);
            if (ok) arquivoImagem = nomeArq;
          } catch (e) {
            avisos.push(`Página ${n}, item ${etiqueta}: falha ao recortar a foto (${e.message}).`);
          }
        }
        produtos.push({
          nome: card.nome,
          codigos: card.codigos,
          temCores: card.temCores,
          modelos: card.modelos,
          imagemSecao: arquivoImagem ? '' : fotoSecao,
          especificacoes: card.especificacoes,
          embalagem: card.embalagem,
          caixaMaster: card.caixaMaster,
          caixaInner: card.caixaInner,
          inmetro: card.inmetro,
          curvaA: card.curvaA,
          pagina: n,
          imagem: arquivoImagem,
        });
      }

      if (png) { try { fs.unlinkSync(png); } catch (_) {} }
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  // Um card pode listar vários códigos (um por cor). Cada código vira uma
  // entrada, todos apontando para a mesma foto e a mesma ficha — é assim que
  // o catálogo do cliente consegue agrupar as cores num card só.
  const porCodigo = new Map();
  for (const p of produtos) {
    p.codigos.forEach((cod, i) => {
      if (!porCodigo.has(cod)) {
        porCodigo.set(cod, {
          codigo: cod,
          nome: p.nome,
          modelos: p.modelos,
          especificacoes: p.especificacoes,
          embalagem: p.embalagem,
          caixaMaster: p.caixaMaster,
          caixaInner: p.caixaInner,
          inmetro: p.inmetro,
          curvaA: p.curvaA,
          pagina: p.pagina,
          imagem: p.imagem,
          imagemSecao: p.imagemSecao || '',
          // Grupo de cores só existe quando o card declarou "Cores disponíveis"
          // E tem mais de um código. Fora isso, cada código anda sozinho.
          grupoCores: p.temCores && p.codigos.length > 1 ? p.codigos : [],
          indiceCor: i,
        });
      }
    });
  }

  // Cards sem código nenhum (o caso do catálogo Logitech, cuja camada de texto
  // veio incompleta) viram fichas "por modelo". O cruzamento tenta casar essas
  // fichas com a descrição do produto na planilha.
  const porModelo = produtos
    .filter((p) => !p.codigos.length && p.modelos.length)
    .map((p) => ({
      modelos: p.modelos,
      nome: p.nome,
      especificacoes: p.especificacoes,
      embalagem: p.embalagem,
      caixaMaster: p.caixaMaster,
      caixaInner: p.caixaInner,
      inmetro: p.inmetro,
      curvaA: p.curvaA,
      pagina: p.pagina,
      imagem: p.imagem,
      imagemSecao: p.imagemSecao || '',
    }));

  const lista = [...porCodigo.values()];
  if (!lista.length && !porModelo.length && doc.numPages > 0) {
    avisos.push(
      'Nenhum produto foi reconhecido neste PDF. Provavelmente ele não tem camada de texto (foi fechado como imagem). ' +
      'Nesse caso a foto precisa ser anexada item a item pelo painel.'
    );
  }

  return {
    produtos: lista,
    porModelo,
    cards: produtos.length,
    paginas: doc.numPages,
    paginasComFalha,
    comFoto: lista.filter((p) => p.imagem).length,
    avisos,
  };
}

module.exports = { importarCatalogo };
