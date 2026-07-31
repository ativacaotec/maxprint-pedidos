'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const { normalizarCodigo } = require('./codigo');
const { criarTravaDeFotos, aplicarAcao, MAXIMO_IRMAOS } = require('./travaDeFotos');

/**
 * Busca a foto oficial de cada produto Maxprint no site da própria fábrica.
 *
 * POR QUE ISSO EXISTE
 * As fotos da Maxprint vinham do recorte dos catálogos em PDF, e o recorte
 * errou feio: medido em 30/07/2026, 236 dos 422 produtos dividiam foto com
 * outro, e havia recortes de SEÇÃO inteira servindo de foto para 77 e 72
 * produtos ao mesmo tempo. Quem abre o catálogo vê o mesmo bloco de imagem em
 * dezenas de itens diferentes.
 *
 * COMO O CASAMENTO É FEITO
 * Pelo NOME DO ARQUIVO da imagem, e não pelo texto da página. O site é
 * WooCommerce e publica as fotos como `60000046.jpg`, `60000046-2.jpg`,
 * `603579-4.jpg` — o código do produto é o próprio nome. Isso é mais forte que
 * ler "SKU: ..." do HTML: numa página o texto do SKU apareceu como "1000",
 * pego de um "1000 DPI" da descrição, enquanto o arquivo dizia 603579 sem
 * ambiguidade.
 *
 * Como a chave é o nome do arquivo, qualquer página serve para qualquer
 * código: a foto de um produto que aparece na vitrine lateral de outra página
 * é aproveitada do mesmo jeito, e continua sendo a foto certa daquele código.
 *
 * AS TRÊS TRAVAS CONTRA FOTO TROCADA
 * Aprendidas no buscador da Samsonite, no mesmo dia:
 *   1. o código vem do nome do arquivo — nada de adivinhar por descrição;
 *   2. antes de baixar, agrupa pelo CAMINHO da URL (sem o que vem depois do
 *      "?"): se um mesmo arquivo serve a mais de um código, ninguém fica com
 *      ele;
 *   3. depois de converter, compara byte a byte com o que já entrou nesta
 *      varredura. Endereço diferente pode devolver o mesmo arquivo.
 * Foto errada é pior que foto faltando: o cliente pede olhando a foto.
 *
 * O robots.txt do site proíbe só /wp-admin e uploads internos do WooCommerce.
 * As páginas de produto são descobertas pelo sitemap que o próprio site
 * publica, e há pausa entre as visitas.
 */

const BASE = 'https://www.maxprint.com.br';
const SITEMAP = `${BASE}/wp-sitemap.xml`;
const PAUSA_PADRAO_MS = 1200;
const TIMEOUT_MS = 20000;
const AGENTE = 'AtivacaoPedidosBot/1.0 (catalogo interno de representante; contato: ia.ativacao@gmail.com)';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function baixar(url, { comoTexto = true } = {}) {
  const controle = new AbortController();
  const t = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: controle.signal,
      headers: { 'user-agent': AGENTE, accept: comoTexto ? 'text/html,application/xml' : '*/*' },
      redirect: 'follow',
    });
    if (!r.ok) return null;
    if (comoTexto) return await r.text();
    return Buffer.from(await r.arrayBuffer());
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function extrairLocs(xml) {
  return [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

/** Páginas de produto do site, pelo sitemap. */
async function listarProdutos(aviso) {
  const indice = await baixar(SITEMAP);
  if (!indice) { aviso('Não achei o sitemap do site da Maxprint.'); return []; }

  const subs = extrairLocs(indice).filter((u) => /posts-product/i.test(u));
  const urls = new Set();
  for (const s of subs) {
    const xml = await baixar(s);
    if (xml) extrairLocs(xml).filter((u) => u.includes('/produto/')).forEach((u) => urls.add(u));
    await dormir(300);
  }
  return [...urls];
}

/** Tira o tamanho que o WordPress cola no fim do arquivo: `-700x700`. */
function semTamanho(url) {
  return String(url || '').replace(/-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|webp))(\?.*)?$/i, '$1$2');
}

/**
 * As cores de um produto de variação, do jeito que o próprio WooCommerce
 * publica: um bloco JSON no atributo `data-product_variations`, com o SKU e a
 * imagem de CADA cor.
 *
 * Este é o casamento mais forte que o site oferece — melhor até que o nome do
 * arquivo, porque quem diz de que código é a foto é a própria loja. A caneta
 * marca-texto Needs é uma página só com seis cores dentro: 70000132 laranja,
 * 70000134 rosa, 70000137 vermelho... Sem ler este bloco, os seis códigos
 * ficavam sem foto, e era esse o caso que apareceu no catálogo com "sem foto"
 * enquanto o site mostrava a caneta rosa.
 *
 * Quando a página tem variação demais, o WooCommerce escreve `false` aqui e
 * carrega as cores por AJAX. Nesse caso sobra o nome do arquivo.
 */
/**
 * O nome que a própria fábrica dá ao produto, do <h1> da página.
 *
 * Serve para consertar os nomes que o leitor do PDF errou: nas páginas de
 * etiqueta ele trouxe o cabeçalho da tabela, e o site publica
 * "Etiqueta INK Maxprint A4363 38.1mm x 99mm 100 Folhas Branca" — o nome do
 * item exato, com formato e quantidade.
 */
function tituloDaPagina(html) {
  const h1 = /<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i.exec(String(html || ''));
  const bruto = h1 ? h1[1] : (/<meta[^>]+property="og:title"[^>]+content="([^"]{3,200})"/i.exec(String(html || '')) || [])[1];
  if (!bruto) return '';
  return String(bruto)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "attribute_pa_color": "azul" -> "Azul" */
function corDaVariacao(v) {
  const attrs = (v && v.attributes) || {};
  const bruto = Object.values(attrs).filter(Boolean).join(' ').replace(/[-_]+/g, ' ').trim();
  if (!bruto) return '';
  return bruto.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

function coresDaPagina(html) {
  const m = /data-product_variations="([^"]+)"/i.exec(String(html || ''));
  if (!m || !m[1] || m[1] === 'false') return [];

  const cru = m[1]
    .replace(/&quot;/g, '"').replace(/&#0?34;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  let lista;
  try { lista = JSON.parse(cru); } catch (_) { return []; }
  if (!Array.isArray(lista)) return [];

  const achadas = [];
  for (const v of lista) {
    const codigo = normalizarCodigo(v && v.sku);
    if (!/^\d{5,10}$/.test(codigo)) continue;
    const img = (v && v.image) || {};
    const url = img.full_src || img.src || '';
    if (!url) continue;
    // ordem -1: a foto que a loja amarrou na cor ganha da achada pelo nome.
    achadas.push({ url: semTamanho(url), codigo, ordem: -1, cor: corDaVariacao(v) });
  }
  return achadas;
}

/**
 * Fotos de produto de uma página, com o código que cada uma carrega no nome.
 *
 * Descarta o que não é produto: as versões redimensionadas do WordPress
 * (`-300x300`), banner, logo e fundo de seção — tudo isso ou tem tamanho no
 * nome, ou não começa com dígito.
 */
function fotosDaPagina(html) {
  const achadas = coresDaPagina(html);
  const re = /https:\/\/[^"' ]*\/wp-content\/uploads\/[^"' ]+\.(?:jpe?g|png|webp)/gi;
  for (const m of String(html || '').matchAll(re)) {
    const url = m[0];
    const arquivo = decodeURIComponent(url.split('/').pop());
    if (/-\d{2,4}x\d{2,4}\.(?:jpe?g|png|webp)$/i.test(arquivo)) continue;   // miniatura
    const nome = arquivo.replace(/\.(?:jpe?g|png|webp)$/i, '');
    // "60000046", "60000046-2", "603579-4" e também "70000134-2-1": quando o
    // mesmo arquivo é enviado de novo, o WordPress vai empilhando sufixo. A
    // regra antiga aceitava UM sufixo só e jogava fora justamente as fotos
    // reenviadas.
    const m2 = /^(\d{5,10})((?:[-_]\d{1,3})*)$/.exec(nome);
    if (!m2) continue;
    const primeiro = /^[-_](\d{1,3})/.exec(m2[2] || '');
    achadas.push({ url, codigo: normalizarCodigo(m2[1]), ordem: primeiro ? Number(primeiro[1]) : 0 });
  }
  return achadas;
}

/**
 * @param {object[]} produtos  itens que precisam de foto: { codigo, codigoOriginal }
 * @param {object} opcoes
 *   pastaImagens, prefixo, pausaMs, maxPaginas
 *   aoAndar(progresso), aoBaixar(resultado), aoDescartar(codigo)
 */
async function buscarFotosMaxprint(produtos, opcoes = {}) {
  const {
    pastaImagens,
    prefixo = 'maxweb',
    pausaMs = PAUSA_PADRAO_MS,
    maxPaginas = 3000,
    aoAndar = () => {},
    aoBaixar = null,
    aoDescartar = null,
  } = opcoes;

  const avisos = [];
  const aviso = (t) => { if (avisos.length < 200) avisos.push(t); };
  fs.mkdirSync(pastaImagens, { recursive: true });

  const procurados = new Map();
  for (const p of produtos) {
    procurados.set(normalizarCodigo(p.codigo), p);
    if (p.codigoOriginal) procurados.set(normalizarCodigo(p.codigoOriginal), p);
  }

  aoAndar({ etapa: 'lendo o sitemap do site da Maxprint', visitadas: 0, achados: 0 });
  const urls = await listarProdutos(aviso);
  if (!urls.length) {
    return { resultados: [], avisos, relatorio: { procurados: produtos.length, paginasVisitadas: 0, fotosBaixadas: 0 } };
  }
  aviso(`${urls.length} páginas de produto no sitemap.`);

  const achados = new Map();   // codigo -> { url }
  const nomesDoSite = new Map();   // codigo -> nome publicado pela fábrica
  let visitadas = 0;
  let paginasComFoto = 0;

  for (const url of urls) {
    if (visitadas >= maxPaginas) { aviso(`Parei em ${maxPaginas} páginas (teto de segurança).`); break; }
    if (achados.size >= procurados.size) break;

    const html = await baixar(url);
    visitadas++;
    if (html) {
      const fotos = fotosDaPagina(html);
      if (fotos.length) paginasComFoto++;

      // O nome que a fábrica publica, para consertar o que o leitor do PDF
      // errou. Na variação, o título é da família e a cor vem do atributo:
      // "Caneta Marca-Texto Needs" + "Rosa". Só junta a cor quando ela ainda
      // não está no título, senão sai "... Rosa Rosa".
      const titulo = tituloDaPagina(html);
      if (titulo) {
        for (const f of fotos) {
          if (!procurados.has(f.codigo) || nomesDoSite.has(f.codigo)) continue;
          const cor = f.cor || '';
          const jaTem = cor && new RegExp(`\\b${cor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(titulo);
          nomesDoSite.set(f.codigo, cor && !jaTem ? `${titulo} ${cor}` : titulo);
        }
      }

      // A foto principal é a sem sufixo; "-2", "-3" são ângulos e embalagem.
      fotos.sort((a, b) => a.ordem - b.ordem);
      for (const f of fotos) {
        if (!procurados.has(f.codigo) || achados.has(f.codigo)) continue;
        achados.set(f.codigo, { url: f.url, pagina: url });
      }
    }

    if (visitadas % 10 === 0) {
      aoAndar({
        etapa: `${visitadas} de ${urls.length} páginas lidas, ${achados.size} fotos encontradas`,
        visitadas, achados: achados.size,
      });
    }
    await dormir(pausaMs);
  }

  if (visitadas && !paginasComFoto) {
    aviso('Nenhuma página trouxe foto com código no nome. O site provavelmente mudou — o leitor precisa de ajuste.');
  }

  /* ---- trava 2: o mesmo ARQUIVO servindo a códigos demais ---- */
  // Dois códigos irmãos apontando para o mesmo arquivo é comum e legítimo
  // (etiqueta do mesmo modelo em dois formatos). Três já é imagem genérica.
  const semParametros = (u) => String(u || '').split('?')[0];
  const porUrl = new Map();
  for (const [codigo, info] of achados) {
    const k = semParametros(info.url);
    if (!porUrl.has(k)) porUrl.set(k, []);
    porUrl.get(k).push(codigo);
  }
  let ambiguas = 0;
  for (const [, codigos] of porUrl) {
    if (codigos.length <= MAXIMO_IRMAOS) continue;
    codigos.forEach((c) => achados.delete(c));
    ambiguas += codigos.length;
    aviso(`Mesmo arquivo apontado para ${codigos.length} códigos (${codigos.slice(0, 4).join(', ')}) — descartado.`);
  }

  /* ---- baixa, converte e grava ---- */
  aoAndar({ etapa: `baixando ${achados.size} fotos`, visitadas, achados: achados.size });

  const resultados = [];
  const trava = criarTravaDeFotos({ pastaImagens, aviso });
  const origemDe = new Map();
  let falhas = 0;

  for (const [codigo, info] of achados) {
    const p = procurados.get(codigo);
    if (!p) continue;

    const bin = await baixar(info.url, { comoTexto: false });
    if (!bin || bin.length < 1024) { falhas++; continue; }

    const nome = `${prefixo}-${codigo}.jpg`;
    origemDe.set(p.codigo, `site Maxprint · ${info.pagina}`);
    try {
      const pronto = await sharp(bin)
        .flatten({ background: '#ffffff' })
        .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 86 })
        .toBuffer();

      /* ---- trava 3: byte a byte, com espaço para o irmão ---- */
      for (const acao of trava.oferecer({ codigo: p.codigo, arquivo: nome, buffer: pronto })) {
        await aplicarAcao(acao, { resultados, origemDe, aoBaixar, aoDescartar, aviso });
      }
    } catch (e) {
      falhas++;
      aviso(`Falhou ao converter a foto de ${p.codigo}: ${e.message}`);
    }
    await dormir(150);
  }

  const contas = trava.contas();
  return {
    resultados,
    // codigo -> nome publicado pela fábrica. Quem decide trocar é a rota, e só
    // troca o nome que está claramente quebrado.
    nomesDoSite,
    avisos,
    relatorio: {
      procurados: produtos.length,
      paginasVisitadas: visitadas,
      paginasComFoto,
      fotosEncontradas: achados.size,
      fotosAmbiguasDescartadas: ambiguas,
      ...contas,
      fotosBaixadas: resultados.length,
      falhasAoBaixar: falhas,
      continuamSemFoto: produtos.length - resultados.length,
    },
  };
}

module.exports = { buscarFotosMaxprint, fotosDaPagina, coresDaPagina, listarProdutos };
