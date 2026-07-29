'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');

const { normalizarCodigo } = require('./codigo');

/**
 * Busca a foto oficial de cada produto Samsonite nas lojas da própria marca e
 * guarda no nosso servidor.
 *
 * POR QUE ISSO EXISTE
 * Os catálogos em PDF só cobrem uma parte da linha (283 de 1.558 itens). O
 * resto ficaria sem foto para sempre, ou dependeria de alguém anexar imagem a
 * imagem. As lojas oficiais têm a foto de tudo, em alta resolução.
 *
 * COMO O CASAMENTO É FEITO
 * Exato, por código. A página de produto da loja mostra o SKU no MESMO formato
 * da planilha da Samsonite ("9320010411 U"), então não há adivinhação por
 * descrição — ou o código bate, ou o item fica sem foto e aparece no relatório.
 * Foto errada num pedido é pior que foto faltando.
 *
 * O QUE ESTE CÓDIGO NÃO FAZ, DE PROPÓSITO
 * O robots.txt da samsonite.com.br proíbe `/search`. Então isto NÃO usa a
 * busca do site. Os produtos são descobertos pelo `sitemap`, que é justamente
 * o mecanismo que o site publica para esse fim, e só páginas `/products/` são
 * visitadas. Ignorar o robots.txt seria, além de errado, o caminho mais curto
 * para o IP do servidor ser bloqueado e o buscador parar de funcionar.
 *
 * Também há uma pausa entre as visitas. Uma varredura educada demora mais e
 * continua funcionando amanhã; uma varredura apressada funciona uma vez.
 */

/** Lojas oficiais. A ordem importa: a primeira que tiver a foto vence. */
const LOJAS = [
  { nome: 'Samsonite Brasil', base: 'https://samsonite.com.br' },
  { nome: 'American Tourister Brasil', base: 'https://americantourister.com.br' },
];

const PAUSA_PADRAO_MS = 1200;   // entre uma página e outra
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
    if (comoTexto) {
      // Sitemap costuma vir comprimido; o fetch não descomprime .gz sozinho.
      if (url.endsWith('.gz')) {
        const buf = Buffer.from(await r.arrayBuffer());
        return zlib.gunzipSync(buf).toString('utf8');
      }
      return await r.text();
    }
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ *
 * Descoberta dos produtos, pelo sitemap
 * ------------------------------------------------------------------ */

function extrairLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

/**
 * Devolve as URLs de produto da loja. Passa pelo índice de sitemaps, entra
 * só nos sitemaps de produto e recolhe as páginas `/products/`.
 */
async function listarProdutos(base, aviso) {
  const candidatos = [
    `${base}/sitemap-index.xml`,
    `${base}/sitemap.xml`,
    `${base}/sitemap_index.xml`,
  ];

  let indice = null;
  for (const url of candidatos) {
    indice = await baixar(url);
    if (indice && /<loc>/i.test(indice)) break;
    indice = null;
  }
  if (!indice) {
    aviso(`${base}: não achei o sitemap. Nenhuma foto virá desta loja.`);
    return [];
  }

  const dentro = extrairLocs(indice);
  // Um índice aponta para outros sitemaps; um sitemap simples já traz páginas.
  const sitemapsDeProduto = dentro.filter((u) => /sitemap.*product/i.test(u));
  const alvos = sitemapsDeProduto.length ? sitemapsDeProduto
    : dentro.filter((u) => /\.xml(\.gz)?$/i.test(u));

  const urls = new Set();
  // O índice já pode ser a própria lista de páginas.
  dentro.filter((u) => u.includes('/products/')).forEach((u) => urls.add(u));

  for (const sm of alvos) {
    const xml = await baixar(sm);
    if (!xml) continue;
    extrairLocs(xml).filter((u) => u.includes('/products/')).forEach((u) => urls.add(u));
    await dormir(300);
  }

  return [...urls];
}

/* ------------------------------------------------------------------ *
 * Leitura de uma página de produto
 * ------------------------------------------------------------------ */

/**
 * Tira da página os SKUs e a foto principal.
 *
 * Tenta o JSON-LD primeiro (é dado estruturado, feito para ser lido) e só
 * depois cai para o HTML cru. Assim, se a loja mudar o layout visual, o
 * buscador continua funcionando enquanto o dado estruturado existir.
 */
function lerPaginaDeProduto(html) {
  const skus = new Set();
  const imagens = [];

  // 1. JSON-LD
  const blocos = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const bloco of blocos) {
    const cru = bloco.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    let dado;
    try { dado = JSON.parse(cru); } catch (_) { continue; }

    const visitar = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(visitar);
      const tipo = String(n['@type'] || '');
      if (/product/i.test(tipo)) {
        if (n.sku) skus.add(String(n.sku));
        if (n.mpn) skus.add(String(n.mpn));
        const img = n.image;
        if (typeof img === 'string') imagens.push(img);
        else if (Array.isArray(img)) img.forEach((x) => typeof x === 'string' && imagens.push(x));
        else if (img && img.url) imagens.push(img.url);
      }
      if (n.hasVariant) visitar(n.hasVariant);
      if (n.offers) visitar(n.offers);
      Object.values(n).forEach((v) => { if (v && typeof v === 'object') visitar(v); });
    };
    visitar(dado);
  }

  // 2. HTML cru: o SKU aparece escrito na página ("SKU: 9320010411 U").
  //    Aceito o formato com a letra de unidade no fim, que é como a planilha
  //    da Samsonite grava.
  const reSku = /SKU[^0-9A-Za-z]{0,12}([0-9][0-9A-Za-z]{6,15}(?:\s+[A-Z])?)/gi;
  let m;
  while ((m = reSku.exec(html))) skus.add(m[1].trim());

  // 3. Foto: og:image é a que a própria loja elege como principal.
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (og) imagens.unshift(og[1]);

  return { skus: [...skus], imagens: imagens.filter(Boolean) };
}

/** Deixa a URL da imagem em tamanho bom e absoluta. */
function normalizarUrlImagem(url, base) {
  if (!url) return null;
  let u = String(url).trim();
  if (u.startsWith('//')) u = 'https:' + u;
  else if (u.startsWith('/')) u = base + u;
  if (!/^https?:/i.test(u)) return null;
  // Shopify aceita ?width=; peço um tamanho que sirva para o card e para o PDF.
  if (/cdn\.shopify\.com/i.test(u)) {
    u = u.replace(/([?&])width=\d+/i, '$1width=1200');
    if (!/[?&]width=/i.test(u)) u += (u.includes('?') ? '&' : '?') + 'width=1200';
  }
  return u;
}

/* ------------------------------------------------------------------ *
 * Varredura
 * ------------------------------------------------------------------ */

/**
 * @param {object[]} produtos  itens do catálogo que precisam de foto,
 *   com { codigo, codigoOriginal }
 * @param {object} opcoes
 *   pastaImagens  onde gravar
 *   prefixo       prefixo do nome do arquivo
 *   pausaMs       intervalo entre páginas
 *   maxPaginas    teto de páginas visitadas (segurança)
 *   aoAndar       callback(progresso) para a barra do painel
 */
async function buscarFotosSamsonite(produtos, opcoes = {}) {
  const {
    pastaImagens,
    prefixo = 'samweb',
    pausaMs = PAUSA_PADRAO_MS,
    maxPaginas = 4000,
    aoAndar = () => {},
    lojas = LOJAS,
  } = opcoes;

  const avisos = [];
  const aviso = (t) => { if (avisos.length < 200) avisos.push(t); };

  fs.mkdirSync(pastaImagens, { recursive: true });

  // Quem estou procurando, indexado pelo código normalizado.
  const procurados = new Map();
  for (const p of produtos) {
    procurados.set(normalizarCodigo(p.codigo), p);
    if (p.codigoOriginal) procurados.set(normalizarCodigo(p.codigoOriginal), p);
  }

  const achados = new Map();   // codigo -> { url, loja }
  let visitadas = 0;
  let paginasComSku = 0;

  for (const loja of lojas) {
    aoAndar({ etapa: `procurando os produtos de ${loja.nome}`, visitadas, achados: achados.size });

    const urls = await listarProdutos(loja.base, aviso);
    if (!urls.length) continue;
    aviso(`${loja.nome}: ${urls.length} páginas de produto no sitemap.`);

    for (const url of urls) {
      if (visitadas >= maxPaginas) { aviso(`Parei em ${maxPaginas} páginas (teto de segurança).`); break; }
      // Nada de perder tempo com o que já foi resolvido.
      if (achados.size >= procurados.size) break;

      const html = await baixar(url);
      visitadas++;

      if (html) {
        const { skus, imagens } = lerPaginaDeProduto(html);
        if (skus.length) paginasComSku++;
        const foto = normalizarUrlImagem(imagens[0], loja.base);
        if (foto) {
          for (const sku of skus) {
            const chave = normalizarCodigo(sku);
            if (procurados.has(chave) && !achados.has(chave)) {
              achados.set(chave, { url: foto, loja: loja.nome, pagina: url });
            }
          }
        }
      }

      if (visitadas % 10 === 0) {
        aoAndar({
          etapa: `${loja.nome}: ${visitadas} páginas lidas, ${achados.size} fotos encontradas`,
          visitadas, achados: achados.size,
        });
      }
      await dormir(pausaMs);
    }
  }

  if (visitadas && !paginasComSku) {
    aviso('Nenhuma página trouxe SKU. A loja provavelmente mudou de layout — o leitor precisa de ajuste.');
  }

  /* ---- baixar as imagens encontradas ---- */
  aoAndar({ etapa: `baixando ${achados.size} fotos`, visitadas, achados: achados.size });

  const resultados = [];
  let baixadas = 0, falhas = 0;
  for (const [chave, info] of achados) {
    const p = procurados.get(chave);
    if (!p) continue;

    const bin = await baixar(info.url, { comoTexto: false });
    if (!bin || bin.length < 1024) { falhas++; continue; }

    const nome = `${prefixo}-${chave}.jpg`;
    try {
      // Padronizo em JPEG com fundo branco e tamanho de tela: o card, o PDF e
      // o Excel do pedido esperam a mesma coisa, e a loja manda de tudo.
      await sharp(bin)
        .flatten({ background: '#ffffff' })
        .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 86 })
        .toFile(path.join(pastaImagens, nome));
      resultados.push({ codigo: p.codigo, arquivo: nome, origem: `${info.loja} · ${info.pagina}` });
      baixadas++;
    } catch (e) {
      falhas++;
      aviso(`Falhou ao converter a foto de ${p.codigo}: ${e.message}`);
    }
    await dormir(200);
  }

  return {
    resultados,
    avisos,
    relatorio: {
      procurados: produtos.length,
      paginasVisitadas: visitadas,
      paginasComSku,
      fotosEncontradas: achados.size,
      fotosBaixadas: baixadas,
      falhasAoBaixar: falhas,
      continuamSemFoto: produtos.length - baixadas,
      lojas: lojas.map((l) => l.nome),
    },
  };
}

module.exports = { buscarFotosSamsonite, lerPaginaDeProduto, normalizarUrlImagem, LOJAS };
