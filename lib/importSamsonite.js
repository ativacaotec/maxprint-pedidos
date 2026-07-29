'use strict';

const fs = require('fs');
const path = require('path');
const { normalizarCodigo } = require('./codigo');

/**
 * Importador da base Samsonite.
 *
 * A Samsonite não manda planilha: o que existe hoje é uma aplicação HTML de
 * arquivo único, que o cliente já usava para consultar preço e saldo. Toda a
 * base vive dentro dela numa linha só, `const DB = {...};`, com:
 *
 *   DB.products ..  a lista de itens (sku, marca, grupo, cor, desc, preços...)
 *   DB.pageimg ..   imagem grande da PÁGINA do catálogo, por número de página
 *   DB.thumb ....   a mesma página em miniatura
 *   DB.bg .......   cor de fundo da página (hexadecimal, não é imagem)
 *
 * Diferenças em relação à Maxprint que mudam o desenho do importador:
 *
 *  - não há três bases para cruzar: preço, saldo e descrição vêm juntos, então
 *    aqui não existe cruzamento, só normalização;
 *  - o `marca` do arquivo NÃO é a marca do sistema. Samsonite, Xtrem, American
 *    Tourister etc. são todas da mesma representação e vivem na mesma ABA do
 *    sistema (`marcaSlug: 'samsonite'`), viram filtro dentro dela (`subMarca`);
 *  - o mesmo produto se repete em várias cores, uma linha por cor, e o que
 *    identifica o produto é a trinca subMarca + grupo + desc. É daí que sai o
 *    grupo de cores, sem depender de leitura de PDF como na Maxprint;
 *  - não existe previsão de chegada: a Samsonite não informa. Item sem saldo
 *    entra assim mesmo, com previsão zero, para o vendedor poder programar.
 *
 * Regra de negócio herdada do resto do sistema (ver lib/cruzamento.js):
 * item sem preço fica de fora do catálogo do cliente.
 */

const MARCA_SLUG = 'samsonite';

function numero(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[R$\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function texto(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function arredondar(v) {
  return Math.round(v * 100) / 100;
}

function escaparRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/**
 * Recorta o objeto que começa em `inicio` contando chaves, respeitando aspas e
 * escapes. Só é usado quando o `const DB = ...;` não termina na própria linha —
 * hoje termina, mas o arquivo é gerado por outra ferramenta e pode mudar de
 * formatação sem aviso.
 */
function recortarObjeto(txt, inicio) {
  let nivel = 0;
  let dentroDeAspas = false;
  let escapado = false;

  for (let i = inicio; i < txt.length; i++) {
    const c = txt[i];
    if (escapado) { escapado = false; continue; }
    if (c === '\\') { escapado = true; continue; }
    if (c === '"') { dentroDeAspas = !dentroDeAspas; continue; }
    if (dentroDeAspas) continue;
    if (c === '{') nivel++;
    else if (c === '}') {
      nivel--;
      if (nivel === 0) return txt.slice(inicio, i + 1);
    }
  }
  return null;
}

/** Tira o DB de dentro do HTML. Aceita const/let/var e espaçamento variado. */
function extrairDB(conteudo) {
  const m = /(?:const|let|var)\s+DB\s*=\s*\{/.exec(conteudo);
  if (!m) return null;

  const inicio = conteudo.indexOf('{', m.index);

  // Caminho rápido: o gerador atual grava tudo numa linha só, terminada em ";".
  const fimLinha = conteudo.indexOf('\n', inicio);
  const umaLinha = (fimLinha < 0 ? conteudo.slice(inicio) : conteudo.slice(inicio, fimLinha))
    .trim()
    .replace(/;\s*$/, '');
  try {
    return JSON.parse(umaLinha);
  } catch (e) {
    const bruto = recortarObjeto(conteudo, inicio);
    if (!bruto) return null;
    return JSON.parse(bruto);
  }
}

/** Lê o arquivo, seja ele o HTML original ou um .json já extraído. */
function lerBase(caminhoArquivo) {
  const conteudo = fs.readFileSync(caminhoArquivo, 'utf8');
  const ehJson = path.extname(caminhoArquivo).toLowerCase() === '.json';

  if (ehJson) {
    const dados = JSON.parse(conteudo);
    // Aceito tanto o DB inteiro quanto só a lista de produtos.
    if (Array.isArray(dados)) return { products: dados };
    return dados;
  }

  const db = extrairDB(conteudo);
  if (!db) throw new Error(`Não achei a linha "const DB = {...}" em ${path.basename(caminhoArquivo)}.`);
  return db;
}

/**
 * Limpa o `desc` do arquivo para sobrar só o tipo da peça.
 *
 * A maior parte das linhas já vem limpa ("SPINNER 55/20 EXP"), mas 71 delas
 * trazem a linha e a cor grudadas na descrição:
 *
 *   grupo "AVALANCHE SS22" + desc "BACKPACK AVALANCHE SS22 BLACK/ORANGE"
 *
 * Isso estragava duas coisas ao mesmo tempo: o nome ficava repetindo linha e
 * cor, e — pior — o grupo de cores não se formava, porque a cor dentro do
 * `desc` fazia cada cor virar um produto diferente. Depois da limpeza, casos
 * como o CROSS-BODY BAG da linha IZZIE 3XT voltam a reunir as nove cores.
 *
 * A limpeza é de propósito conservadora: só tira o nome exato do grupo e a cor
 * exata do próprio item, e a cor só quando está no fim do texto — sempre com
 * fronteira de palavra, para não mutilar descrição como "FOLD BP COVER M
 * ANMICBLACK", em que o "BLACK" é parte de outra palavra.
 *
 * O grupo sai primeiro porque em algumas linhas ele vem DEPOIS da cor
 * ("SPORT BAG SAFARI GREEN QUEST 3XT"); tirando o grupo antes, a cor fica no
 * fim e cai na segunda regra.
 */
function limparTipoProduto(desc, grupo, cor) {
  let d = texto(desc);
  if (!d) return '';

  if (grupo) {
    const semGrupo = d.replace(new RegExp(`\\s*\\b${escaparRegex(grupo)}\\b\\s*`, 'i'), ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (semGrupo) d = semGrupo;
  }
  if (cor) {
    const semCor = d.replace(new RegExp(`\\s*\\b${escaparRegex(cor)}\\s*$`, 'i'), '').trim();
    if (semCor) d = semCor;
  }

  return d;
}

/**
 * Nome que o cliente lê no card. Sai de grupo + desc ("ACURA SPINNER 55/20 EXP")
 * porque é assim que a linha é conhecida na loja. A cor fica de fora de
 * propósito: ela aparece em campo próprio e como seletor no grupo de cores;
 * repetir no nome só faria o card ficar comprido e a busca ficar pior.
 */
function montarNome(grupo, tipoProduto) {
  const partes = [texto(grupo), texto(tipoProduto)].filter(Boolean);
  if (!partes.length) return '';
  // Alguns grupos já trazem o tipo no fim; evito "CURIO SPINNER SPINNER 80/30".
  if (partes.length === 2 && partes[1].startsWith(partes[0])) return partes[1];
  return partes.join(' ');
}

/** Extensão do arquivo a partir do cabeçalho do data URL. */
function extensaoDoDataUrl(dataUrl) {
  const m = /^data:image\/([a-z0-9+.-]+);base64,/i.exec(dataUrl || '');
  if (!m) return null;
  const tipo = m[1].toLowerCase();
  return tipo === 'jpeg' ? 'jpg' : tipo;
}

/**
 * Grava as imagens de página, uma vez por página.
 *
 * Atenção: essas imagens são da PÁGINA INTEIRA do catálogo, com vários produtos
 * e texto de marketing — não servem como foto do produto. Elas ficam só como
 * apoio visual até o extrator dos PDFs entregar a foto por cor. Por isso são
 * gravadas separadas (`imagemPagina`) e marcadas como ilustrativas, em vez de
 * ir para o campo `imagem`.
 */
function gravarImagensDePagina(db, paginasUsadas, pastaImagens, prefixo, avisos) {
  const nomePorPagina = new Map();
  if (!pastaImagens || !paginasUsadas.size) return nomePorPagina;

  fs.mkdirSync(pastaImagens, { recursive: true });

  for (const pagina of [...paginasUsadas].sort((a, b) => Number(a) - Number(b))) {
    const chave = String(pagina);
    // A imagem grande vem primeiro; a miniatura é o plano B quando falta.
    const dataUrl = (db.pageimg && db.pageimg[chave]) || (db.thumb && db.thumb[chave]) || '';
    if (!dataUrl) {
      avisos.push(`Página ${chave}: sem imagem no arquivo, produtos dessa página ficam sem ilustração.`);
      continue;
    }

    const ext = extensaoDoDataUrl(dataUrl);
    if (!ext) {
      avisos.push(`Página ${chave}: imagem em formato não reconhecido, ignorada.`);
      continue;
    }

    const nomeArq = `${prefixo}-pagina-${chave}.${ext}`;
    try {
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      fs.writeFileSync(path.join(pastaImagens, nomeArq), Buffer.from(base64, 'base64'));
      nomePorPagina.set(chave, nomeArq);
    } catch (e) {
      avisos.push(`Página ${chave}: falha ao gravar a imagem (${e.message}).`);
    }
  }

  return nomePorPagina;
}

/**
 * @param {string} caminhoArquivo  o samsonite.html ou um .json com o mesmo DB
 * @param {object} opcoes
 *   pastaImagens - onde gravar as imagens de página (uma por página, não por item)
 *   prefixo      - prefixo do nome do arquivo de imagem
 */
async function importarSamsonite(caminhoArquivo, { pastaImagens = null, prefixo = 'sams' } = {}) {
  const avisos = [];
  const db = lerBase(caminhoArquivo);
  const brutos = Array.isArray(db.products) ? db.products : [];

  const relatorio = {
    arquivo: path.basename(caminhoArquivo),
    totalLido: brutos.length,
    totalValido: 0,
    porSubMarca: {},
    comSaldo: 0,
    semSaldo: 0,
    emPromocao: 0,
    gruposDeCor: 0,
    itensEmGrupoDeCor: 0,
    comImagemPagina: 0,
    paginasComImagem: 0,
    foraPorFaltaDePreco: 0,
    semPreco: [],
    duplicados: 0,
  };

  // 1. Leitura, normalização e filtro de preço.
  const validos = [];
  const vistos = new Set();

  for (const bruto of brutos) {
    const skuOriginal = texto(bruto.sku);
    const codigo = normalizarCodigo(skuOriginal);
    if (!codigo) {
      avisos.push('Item sem SKU no arquivo, ignorado.');
      continue;
    }

    // SKU repetido: fico com o primeiro. Sobrescrever seria pior — não há como
    // saber qual linha é a boa, e o segundo registro costuma ser resíduo.
    if (vistos.has(codigo)) {
      relatorio.duplicados++;
      avisos.push(`SKU ${skuOriginal} (código ${codigo}) aparece mais de uma vez; ficou valendo a primeira ocorrência.`);
      continue;
    }
    vistos.add(codigo);

    const whole = numero(bruto.whole) || 0;

    // ATENÇÃO ao campo `promo`: ele NÃO é preço, é o PERCENTUAL de desconto.
    // Os valores no arquivo são 30, 40 e 50, e conferem em todas as 314 linhas
    // promocionais com pfinal = whole x (1 - promo/100) — uma mala de R$ 382,30
    // com `promo` 40 sai por R$ 229,38, não por R$ 40. Tratar esse campo como
    // preço colocaria o catálogo inteiro à venda por trinta e poucos reais.
    const percentualPromo = numero(bruto.promo) || 0;
    const emPromocao = percentualPromo > 0;

    // O preço final da promoção já vem calculado em `pfinal` (e repetido em
    // `unit`); é o número que a aplicação antiga mostrava ao cliente, então ele
    // manda. O cálculo próprio fica como conferência e como plano B.
    const calculado = emPromocao ? arredondar(whole * (1 - percentualPromo / 100)) : whole;
    const pfinal = numero(bruto.pfinal) || 0;
    let precoBase = emPromocao && pfinal > 0 ? pfinal : calculado;

    if (emPromocao && pfinal > 0 && Math.abs(pfinal - calculado) > 0.02) {
      avisos.push(`Código ${codigo}: preço promocional do arquivo (${pfinal}) não bate com ${whole} menos ${percentualPromo}% (${calculado}); vale o do arquivo.`);
    }

    // Trava de sanidade: promoção que sai mais cara que o preço cheio é erro de
    // cadastro. Nesse caso o preço cheio vale, para não vender caro achando que
    // está dando desconto.
    if (emPromocao && precoBase > whole && whole > 0) {
      avisos.push(`Código ${codigo}: promoção (${precoBase}) acima do preço cheio (${whole}); mantive o preço cheio.`);
      precoBase = whole;
    }

    // Regra do dono do sistema: sem preço, fora do catálogo do cliente.
    if (!(precoBase > 0)) {
      relatorio.foraPorFaltaDePreco++;
      relatorio.semPreco.push({
        codigo,
        codigoOriginal: skuOriginal,
        nome: montarNome(bruto.grupo, limparTipoProduto(bruto.desc, bruto.grupo, bruto.cor)),
        subMarca: texto(bruto.marca),
        motivo: 'preço de atacado zerado ou ausente',
      });
      continue;
    }

    // `unit` é o preço que a aplicação HTML já exibia. Divergência aqui quase
    // sempre é promoção cadastrada pela metade, e é melhor o Marcelo saber.
    const unit = numero(bruto.unit);
    if (unit !== null && unit > 0 && Math.abs(unit - precoBase) > 0.02) {
      avisos.push(`Código ${codigo}: preço vigente do arquivo (${unit}) diverge do apurado (${precoBase}); vale o apurado.`);
    }

    const tipoProduto = limparTipoProduto(bruto.desc, bruto.grupo, bruto.cor);

    const estoque = Math.max(0, Math.round(numero(bruto.estoque) || 0));
    const pagina = bruto.page === null || bruto.page === undefined || bruto.page === ''
      ? null
      : Number(bruto.page);

    validos.push({
      codigo,
      codigoOriginal: skuOriginal,

      nome: montarNome(bruto.grupo, tipoProduto),
      marcaSlug: MARCA_SLUG,
      subMarca: texto(bruto.marca),
      // A navegação do cliente é por sub-marca: quem entra na aba procura
      // "Xtrem" ou "American Tourister", não a linha nem o tipo de peça.
      categoria: texto(bruto.marca),
      grupo: texto(bruto.grupo),
      tipoProduto,
      // Guardo a descrição crua para conferência com a Samsonite, já que a
      // limpeza acima mexe no texto original em 71 linhas.
      descricaoArquivo: texto(bruto.desc),
      cor: texto(bruto.cor),
      modelo: texto(bruto.modelo),

      precoBase,
      precoCheio: whole,
      emPromocao,
      descontoPromo: percentualPromo,
      precoVarejo: numero(bruto.retail) || 0,
      ean: texto(bruto.ean),

      estoque,
      // A Samsonite não manda previsão de chegada. Fica zero de propósito: o
      // item sem saldo continua no catálogo, mas o sistema não promete data.
      previstoTotal: 0,
      chegadas: [],
      status: estoque > 0 ? 'DISPONIVEL' : 'SEM SALDO',

      // A foto por cor virá do extrator dos PDFs. Até lá o campo fica vazio de
      // propósito, para o front não exibir a página do catálogo como se fosse
      // a foto do produto.
      imagem: '',
      imagemPagina: '',
      imagemIlustrativa: false,
      paginaCatalogo: Number.isFinite(pagina) ? pagina : null,

      grupoCores: [],
      ativo: true,
    });
  }

  // 2. Grupos de cor: subMarca + grupo + desc identificam o produto; a cor é a
  // variação. Monto só com os itens válidos — apontar para um irmão que ficou
  // de fora por falta de preço quebraria o card no front.
  const porChave = new Map();
  for (const p of validos) {
    const chave = [p.subMarca, p.grupo, p.tipoProduto].join('|').toUpperCase();
    if (!porChave.has(chave)) porChave.set(chave, []);
    porChave.get(chave).push(p);
  }

  for (const irmaos of porChave.values()) {
    if (irmaos.length < 2) continue; // item sozinho não forma grupo de cor
    const codigos = irmaos.map((p) => p.codigo);
    for (const p of irmaos) p.grupoCores = codigos.slice();
    relatorio.gruposDeCor++;
    relatorio.itensEmGrupoDeCor += irmaos.length;
  }

  // 3. Imagens de página: gravadas uma vez por página, nunca uma por item.
  const paginasUsadas = new Set(
    validos.filter((p) => p.paginaCatalogo !== null).map((p) => String(p.paginaCatalogo))
  );
  const nomePorPagina = gravarImagensDePagina(db, paginasUsadas, pastaImagens, prefixo, avisos);

  for (const p of validos) {
    if (p.paginaCatalogo === null) continue;
    const nomeArq = nomePorPagina.get(String(p.paginaCatalogo));
    if (!nomeArq) continue;
    p.imagemPagina = nomeArq;
    p.imagemIlustrativa = true;
  }

  // 4. Números do relatório.
  relatorio.totalValido = validos.length;
  relatorio.comSaldo = validos.filter((p) => p.estoque > 0).length;
  relatorio.semSaldo = validos.length - relatorio.comSaldo;
  relatorio.emPromocao = validos.filter((p) => p.emPromocao).length;
  relatorio.comImagemPagina = validos.filter((p) => p.imagemPagina).length;
  relatorio.paginasComImagem = nomePorPagina.size;
  relatorio.comPagina = validos.filter((p) => p.paginaCatalogo !== null).length;
  for (const p of validos) {
    relatorio.porSubMarca[p.subMarca] = (relatorio.porSubMarca[p.subMarca] || 0) + 1;
  }

  return { produtos: validos, relatorio, avisos };
}

module.exports = { importarSamsonite };
