'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const { normalizarCodigo } = require('./codigo');
const { criarTravaDeFotos, aplicarAcao, MAXIMO_IRMAOS } = require('./travaDeFotos');

/**
 * Busca a foto oficial dos itens LOGITECH na loja da própria Logitech.
 *
 * POR QUE ISSO EXISTE
 * A linha Logitech entra pela base da Maxprint (é ela quem distribui), mas os
 * produtos não existem no site da Maxprint — o buscador de lá volta de mãos
 * vazias. Medido em 30/07/2026: 29 itens na categoria LOGITECH, 27 sem foto.
 * A loja oficial (logitechstore.com.br) tem todos, com o part number à mostra.
 *
 * COMO O CASAMENTO É FEITO
 * Pelo atributo `data-product-sku` da página do produto, que é o part number
 * da Logitech no formato 910-007599 / 920-004431 / 981-000014 — o mesmo código
 * que vem na base da Maxprint, só que com hífen (normalizarCodigo resolve).
 * Diferente da Maxprint, aqui o nome do arquivo da imagem NÃO serve de chave:
 * o site é Magento e publica `h390_logitech34.webp`, `g29-racing-wheel.webp`.
 * Por isso a chave é o SKU, e ele é conferido duas vezes na mesma página
 * (atributo e classe do <body>) antes de valer.
 *
 * AS TRAVAS CONTRA FOTO TROCADA
 *   0. o SKU precisa aparecer igual em `data-product-sku` e na classe
 *      `catalog_product_view_sku_...` do <body>. Discordou, a página é pulada;
 *   1. uma página de produto = um código. Nada de adivinhar por descrição;
 *   2. antes de baixar, agrupa pelo CAMINHO do arquivo (já sem o trecho de
 *      cache do Magento): se o mesmo arquivo serve a dois códigos, os dois
 *      ficam sem foto;
 *   3. depois de converter, compara byte a byte com o que já entrou nesta
 *      varredura.
 * Foto errada é pior que foto faltando: o cliente pede olhando a foto.
 *
 * O QUE O robots.txt PROÍBE (lido em 30/07/2026)
 *   /catalogsearch/, /catalog/product_compare/, /catalog/category/view/,
 *   /catalog/product/view/, e as URLs com ?dir=, ?limit=all e ?mode.
 * Nada disso é usado aqui: a varredura anda pelas páginas de categoria
 * (paginadas com ?p=N, que é liberado) e pelas páginas de produto. O site não
 * publica sitemap.
 */

const BASE = 'https://www.logitechstore.com.br';

/**
 * As raízes de categoria do menu do site. "todas-as-categorias" sozinha já
 * trazia 269 produtos, mas as outras existem porque nem tudo cai lá dentro
 * (exclusivos e lançamentos, por exemplo, vivem à parte). A lista de produtos
 * é um Set: repetir raiz não custa nada além de algumas páginas de listagem.
 */
const CATEGORIAS = [
  '/todas-as-categorias/',
  '/dia-a-dia/',
  '/gaming',
  '/paraempresas/',
  '/caixas-de-som',
  '/acessorios',
  '/exclusivos/',
  '/lancamentos/',
  '/ergo-series',
];

const PAUSA_PADRAO_MS = 1200;
const TIMEOUT_MS = 20000;
const MAX_PAGINAS_LISTA = 20;

const AGENTE_BOT = 'AtivacaoPedidosBot/1.0 (catalogo interno de representante; contato: ia.ativacao@gmail.com)';
const AGENTE_NAVEGADOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Alguns firewalls de loja respondem 403 para qualquer coisa que não pareça
 * navegador. A varredura começa se apresentando como robô, que é o certo, e só
 * troca de identidade se o site fechar a porta — sem isso o trabalho não sai.
 */
let agenteAtual = AGENTE_BOT;

async function baixar(url, { comoTexto = true } = {}) {
  const controle = new AbortController();
  const t = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: controle.signal,
      headers: {
        'user-agent': agenteAtual,
        accept: comoTexto ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' : '*/*',
        'accept-language': 'pt-BR,pt;q=0.9',
      },
      redirect: 'follow',
    });
    if (!r.ok) return { erro: r.status };
    if (comoTexto) return { corpo: await r.text() };
    return { corpo: Buffer.from(await r.arrayBuffer()) };
  } catch (e) {
    // "fetch failed" sozinho não diz nada — a causa de verdade fica em
    // `e.cause`, e é ela que separa DNS do VPS (ENOTFOUND, EAI_AGAIN) de
    // conexão recusada (ECONNREFUSED, ECONNRESET), de firewall que engole o
    // pacote (ETIMEDOUT) e de certificado (UNABLE_TO_VERIFY...). Sem esse
    // detalhe, a loja "não abriu" e ninguém sabe por onde começar.
    if (e.name === 'AbortError') return { erro: 'tempo esgotado' };
    const causa = e.cause || {};
    const detalhe = [causa.code, causa.errno, causa.syscall, causa.message]
      .filter(Boolean).join(' ');
    return { erro: detalhe ? `${e.message} (${detalhe})` : e.message };
  } finally {
    clearTimeout(t);
  }
}

/** Uma tentativa com cada identidade, para descobrir se o site aceita o robô. */
async function escolherAgente(aviso) {
  agenteAtual = AGENTE_BOT;
  const r1 = await baixar(`${BASE}/`);
  if (r1.corpo) return true;
  agenteAtual = AGENTE_NAVEGADOR;
  const r2 = await baixar(`${BASE}/`);
  if (r2.corpo) {
    aviso(`A loja recusou o robô (${r1.erro}); a varredura seguiu com identidade de navegador.`);
    return true;
  }

  aviso(`Não consegui abrir a loja da Logitech. Como robô: ${r1.erro}. Como navegador: ${r2.erro}.`);
  // Uma pista a mais para quem for consertar: o mesmo endereço, sem TLS e sem
  // seguir redirecionamento, separa "a rede do servidor não chega lá" de
  // "chega, mas a loja fecha a porta".
  try {
    const seco = await fetch(BASE.replace(/^https:/, 'http:'), { redirect: 'manual' });
    aviso(`Em http puro a loja respondeu ${seco.status} — então a rede do servidor CHEGA lá, e o bloqueio é do site.`);
  } catch (e) {
    const causa = (e.cause && (e.cause.code || e.cause.message)) || e.message;
    aviso(`Em http puro também falhou (${causa}) — o problema é a saída de rede do servidor, não o site.`);
  }
  return false;
}

/** Links de produto de uma página de listagem. */
function produtosDaLista(html) {
  const urls = [];
  for (const m of String(html || '').matchAll(/<a\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/product-item-link/i.test(tag)) continue;
    const h = /href="([^"]+)"/i.exec(tag);
    if (h) urls.push(h[1].trim());
  }
  return urls;
}

/**
 * Endereço de uma página da listagem.
 *
 * Não dá para confiar no paginador desenhado na tela: ele mostra só cinco
 * números e um "próxima". Medido em 30/07/2026, ler o paginador parava a
 * categoria "todas as categorias" na página 5 e deixava 89 dos 269 produtos de
 * fora. Por isso a varredura anda de página em página até uma vir sem produto.
 */
function enderecoDaLista(cat, pagina) {
  const emenda = cat.includes('?') ? '&' : '?';
  return `${BASE}${cat}${emenda}p=${pagina}`;
}

/**
 * O código e a foto principal de uma página de produto.
 *
 * A foto vem do og:image, que é a imagem-base do produto (a mesma que abre a
 * galeria). O endereço do og:image passa pelo redimensionador do Magento
 * (.../cache/<hash>/...); tirando esse trecho chega-se ao arquivo original,
 * que é maior e é o mesmo para qualquer tamanho pedido — por isso ele também
 * serve de identidade do arquivo na trava 2.
 */
function lerPaginaDeProduto(html) {
  const texto = String(html || '');

  const a = /data-product-sku="([^"]{3,40})"/i.exec(texto);
  if (!a) return null;
  const sku = a[1].trim();

  // Conferência: o Magento repete o SKU na classe do <body>.
  const naClasse = new RegExp(`catalog_product_view_sku_${sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const temClasse = /catalog_product_view_sku_/i.test(texto);
  if (temClasse && !naClasse.test(texto)) return { sku, conflito: true };

  const og = /<meta[^>]+property="og:image"[^>]*content="([^"]+)"/i.exec(texto)
    || /<meta[^>]+content="([^"]+)"[^>]*property="og:image"/i.exec(texto);
  if (!og) return { sku, imagem: '' };

  const daCache = og[1].trim();
  const original = daCache.replace(/\/media\/catalog\/product\/cache\/[0-9a-f]{8,}\//i, '/media/catalog/product/');
  return { sku, imagem: original, imagemCache: daCache };
}

/**
 * @param {object[]} produtos  itens que precisam de foto: { codigo, codigoOriginal }
 * @param {object} opcoes
 *   pastaImagens, prefixo, pausaMs, maxPaginas
 *   aoAndar(progresso), aoBaixar(resultado), aoDescartar(codigo)
 */
async function buscarFotosLogitech(produtos, opcoes = {}) {
  const {
    pastaImagens,
    prefixo = 'logiweb',
    pausaMs = PAUSA_PADRAO_MS,
    maxPaginas = 1500,
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

  const vazio = { resultados: [], avisos, relatorio: { procurados: produtos.length, paginasVisitadas: 0, fotosBaixadas: 0 } };
  aoAndar({ etapa: 'abrindo a loja da Logitech', visitadas: 0, achados: 0 });
  if (!(await escolherAgente(aviso))) return vazio;

  /* ---- 1) as páginas de produto, pelas listagens de categoria ---- */
  aoAndar({ etapa: 'lendo as categorias da loja', visitadas: 0, achados: 0 });

  const paginasDeProduto = new Set();
  for (const cat of CATEGORIAS) {
    for (let p = 1; p <= MAX_PAGINAS_LISTA; p++) {
      const r = await baixar(enderecoDaLista(cat, p));
      if (!r.corpo) {
        if (p === 1) aviso(`Categoria ${cat} não abriu (${r.erro}).`);
        break;
      }
      const achados = produtosDaLista(r.corpo);
      if (!achados.length) break;          // acabou a categoria
      achados.forEach((u) => paginasDeProduto.add(u.split('?')[0]));
      await dormir(pausaMs);
    }
    aoAndar({ etapa: `${paginasDeProduto.size} produtos localizados na loja`, visitadas: 0, achados: 0 });
  }

  if (!paginasDeProduto.size) {
    aviso('Nenhuma página de produto foi encontrada nas categorias — o site provavelmente mudou de layout.');
    return vazio;
  }
  aviso(`${paginasDeProduto.size} páginas de produto na loja da Logitech.`);

  /* ---- 2) o código e a foto de cada página ---- */
  const achados = new Map();   // codigo -> { url, pagina }
  let visitadas = 0;
  let paginasComSku = 0;
  let conflitos = 0;

  for (const url of paginasDeProduto) {
    if (visitadas >= maxPaginas) { aviso(`Parei em ${maxPaginas} páginas (teto de segurança).`); break; }
    if (achados.size >= procurados.size) break;

    const r = await baixar(url);
    visitadas++;
    if (r.corpo) {
      const lido = lerPaginaDeProduto(r.corpo);
      if (lido && lido.conflito) {
        conflitos++;
        aviso(`Em ${url} o código apareceu de dois jeitos diferentes — página pulada.`);
      } else if (lido && lido.sku) {
        paginasComSku++;
        const codigo = normalizarCodigo(lido.sku);
        if (lido.imagem && procurados.has(codigo) && !achados.has(codigo)) {
          achados.set(codigo, { url: lido.imagem, reserva: lido.imagemCache, pagina: url });
        }
      }
    }

    if (visitadas % 10 === 0) {
      aoAndar({
        etapa: `${visitadas} de ${paginasDeProduto.size} produtos lidos, ${achados.size} fotos encontradas`,
        visitadas, achados: achados.size,
      });
    }
    await dormir(pausaMs);
  }

  if (visitadas && !paginasComSku) {
    aviso('Nenhuma página trouxe o código do produto. O site mudou — o leitor precisa de ajuste.');
  }

  /* ---- trava 2: um arquivo, um código ---- */
  const porUrl = new Map();
  for (const [codigo, info] of achados) {
    const k = info.url.split('?')[0];
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

  /* ---- 3) baixa, converte e grava ---- */
  aoAndar({ etapa: `baixando ${achados.size} fotos`, visitadas, achados: achados.size });

  const resultados = [];
  const trava = criarTravaDeFotos({ pastaImagens, aviso });
  const origemDe = new Map();
  let falhas = 0;

  for (const [codigo, info] of achados) {
    const p = procurados.get(codigo);
    if (!p) continue;

    let bin = await baixar(info.url, { comoTexto: false });
    // O arquivo original nem sempre está publicado; aí vale o do redimensionador.
    if ((!bin.corpo || bin.corpo.length < 1024) && info.reserva && info.reserva !== info.url) {
      bin = await baixar(info.reserva, { comoTexto: false });
    }
    if (!bin.corpo || bin.corpo.length < 1024) { falhas++; continue; }

    const nome = `${prefixo}-${codigo}.jpg`;
    origemDe.set(p.codigo, `loja Logitech · ${info.pagina}`);
    try {
      const pronto = await sharp(bin.corpo)
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
    avisos,
    relatorio: {
      procurados: produtos.length,
      paginasNaLoja: paginasDeProduto.size,
      paginasVisitadas: visitadas,
      paginasComCodigo: paginasComSku,
      paginasComCodigoConflitante: conflitos,
      fotosEncontradas: achados.size,
      fotosAmbiguasDescartadas: ambiguas,
      ...contas,
      fotosBaixadas: resultados.length,
      falhasAoBaixar: falhas,
      continuamSemFoto: produtos.length - resultados.length,
    },
  };
}

module.exports = { buscarFotosLogitech, lerPaginaDeProduto, produtosDaLista, CATEGORIAS };
