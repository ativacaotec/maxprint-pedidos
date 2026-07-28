'use strict';

/**
 * Motor de cruzamento das três bases.
 *
 *   tabela de preço ...  preço com IPI, EAN, NCM, caixa master, curva A, categoria
 *   mapa de chegadas ..  saldo, status, linha de produto, previsão de chegada
 *   catálogo PDF ......  foto, descrição, especificações, embalagem, cores irmãs
 *
 * A junção é pelo código normalizado. Quando o catálogo não entrega o código
 * (caso do PDF da Logitech, de camada de texto incompleta), há um plano B:
 * casar pelo MODELO que aparece na descrição da planilha.
 *
 * Regras de negócio embutidas aqui, todas combinadas com o Marcelo:
 *  - item sem preço fica de fora do catálogo do cliente
 *  - item sem saldo não some: entra como PROGRAMADO, limitado à previsão
 *  - o status ATC não muda nada por enquanto, só fica marcado para uso interno
 */

const { normalizarCodigo } = require('./codigo');

/**
 * Escolhe o nome que o cliente vê. Regra: o nome do catálogo ganha por ser
 * comercial, mas só quando é descritivo. Título curto (que no catálogo
 * Logitech é apenas o modelo) perde para a descrição da tabela.
 */
function nomeMelhor(ficha, preco, est) {
  const doCatalogo = (ficha && ficha.nome ? String(ficha.nome) : '').trim();
  const daTabela = (preco && preco.nome ? String(preco.nome) : '').trim();
  const doEstoque = (est && est.descricao ? String(est.descricao) : '')
    .replace(/^\d[\d\s-]*-\s*/, '')
    .trim();

  const bom = doCatalogo.length >= 12 && /[a-zà-ú]/i.test(doCatalogo.slice(1));
  if (bom) return doCatalogo;
  return daTabela || doEstoque || doCatalogo;
}

const RE_MODELO_DESC = /\b(?:MK|GHE|GMO|HBT|FBT|MX-[A-Z]?|[MKCHR])[- ]?\d{2,4}[A-Z]?\b/gi;

function modelosDaDescricao(texto) {
  const achados = new Set();
  const m = String(texto || '').match(RE_MODELO_DESC);
  if (m) m.forEach((t) => achados.add(t.toUpperCase().replace(/[\s-]/g, '')));
  return [...achados];
}

/**
 * @param {object} bases
 *   precos    - saída de importarPreco().itens
 *   estoques  - saída de juntarEstoque().itens
 *   catalogo  - lista de fichas por código
 *   fichasPorModelo - lista de fichas sem código, com `modelos`
 */
function cruzar({ precos = [], estoques = [], catalogo = [], fichasPorModelo = [] }) {
  const mapaPreco = new Map(precos.map((p) => [normalizarCodigo(p.codigo), p]));
  const mapaEstoque = new Map(estoques.map((e) => [normalizarCodigo(e.codigo), e]));
  const mapaCatalogo = new Map(catalogo.map((c) => [normalizarCodigo(c.codigo), c]));

  // Índice de modelo -> ficha, para o plano B.
  const mapaModelo = new Map();
  for (const f of fichasPorModelo) {
    for (const mod of f.modelos || []) {
      if (!mapaModelo.has(mod)) mapaModelo.set(mod, f);
    }
  }
  for (const c of catalogo) {
    for (const mod of c.modelos || []) {
      if (!mapaModelo.has(mod)) mapaModelo.set(mod, c);
    }
  }

  const produtos = [];
  const relatorio = {
    precoTotal: mapaPreco.size,
    estoqueTotal: mapaEstoque.size,
    catalogoTotal: mapaCatalogo.size,
    comPrecoESaldo: 0,
    semPreco: [],
    semFoto: [],
    fotoPorModelo: 0,
    somenteNoPreco: 0,
    programados: 0,
    disponiveis: 0,
  };

  // A base do catálogo do cliente é o ESTOQUE: só entra o que a Maxprint tem
  // cadastrado como item corrente. Item que só existe na tabela de preço, sem
  // linha no mapa de chegadas, fica de fora.
  for (const [codigo, est] of mapaEstoque) {
    const preco = mapaPreco.get(codigo);
    if (!preco) {
      relatorio.semPreco.push({ codigo, descricao: est.descricao, estoque: est.estoque });
      continue;
    }

    let ficha = mapaCatalogo.get(codigo) || null;
    let fotoPorModelo = false;
    let fotoIlustrativa = false;

    if (!ficha || !ficha.imagem) {
      // Plano B: procurar por modelo, primeiro na descrição do estoque,
      // depois no nome da tabela de preço.
      const candidatos = [
        ...modelosDaDescricao(est.descricao),
        ...modelosDaDescricao(preco.nome),
      ];
      for (const mod of candidatos) {
        const f = mapaModelo.get(mod);
        if (f && f.imagem) {
          ficha = { ...(ficha || {}), ...f, codigo };
          fotoPorModelo = true;
          break;
        }
      }
    }

    // Última tentativa: a foto ilustrativa da linha, capturada na página de
    // abertura de seção do catálogo. Vale para etiqueta, toner, refil e papel
    // fotográfico, que aparecem só em tabela e não têm foto individual.
    let imagemFinal = ficha && ficha.imagem ? ficha.imagem : '';
    if (!imagemFinal && ficha && ficha.imagemSecao) {
      imagemFinal = ficha.imagemSecao;
      fotoIlustrativa = true;
    }

    const temImagem = !!imagemFinal;
    if (!temImagem) relatorio.semFoto.push({ codigo, descricao: est.descricao });
    if (fotoIlustrativa) relatorio.fotoIlustrativa = (relatorio.fotoIlustrativa || 0) + 1;
    if (fotoPorModelo) relatorio.fotoPorModelo++;

    const disponivel = est.estoque > 0;
    if (disponivel) relatorio.disponiveis++;
    else if (est.previstoTotal > 0) relatorio.programados++;

    produtos.push({
      codigo,
      codigoOriginal: est.codigoOriginal || preco.codigoOriginal || codigo,

      // Nome: prefiro o do catálogo, que é o comercial ("Caneta para CD e DVD
      // Mark+ Duo"), e caio para o da tabela, que é o do sistema da indústria.
      // Só que no catálogo Logitech o título do card é só o modelo ("M170",
      // "H111"), o que não diz nada para quem está comprando. Então o nome do
      // catálogo só vence quando é descritivo de verdade.
      nome: nomeMelhor(ficha, preco, est),
      descricaoEstoque: est.descricao,
      nomeTabela: preco.nome,

      categoria: preco.categoria,
      linhaProduto: est.linhaProduto || '',
      marca: est.marca || '',

      precoBase: preco.precoComIpi,
      precoSemIpi: preco.precoSemIpi,
      ipi: preco.ipi,
      st: preco.st,
      ean: preco.ean,
      ncm: preco.ncm,
      cxMaster: preco.cxMaster,
      outlet: !!preco.outlet,
      curvaA: !!preco.curvaA || !!(ficha && ficha.curvaA),

      estoque: est.estoque,
      status: est.status,
      chegadas: est.chegadas || [],
      previstoTotal: est.previstoTotal || 0,
      observacaoEstoque: est.observacao || '',

      imagem: imagemFinal,
      imagemPorModelo: fotoPorModelo,
      imagemIlustrativa: fotoIlustrativa,
      especificacoes: (ficha && ficha.especificacoes) || [],
      embalagem: (ficha && ficha.embalagem) || '',
      caixaMaster: (ficha && ficha.caixaMaster) || null,
      caixaInner: (ficha && ficha.caixaInner) || null,
      inmetro: !!(ficha && ficha.inmetro),
      paginaCatalogo: (ficha && ficha.pagina) || null,
      grupoCores: (ficha && ficha.grupoCores) || [],
    });
  }

  relatorio.comPrecoESaldo = produtos.filter((p) => p.estoque > 0).length;
  relatorio.somenteNoPreco = [...mapaPreco.keys()].filter((c) => !mapaEstoque.has(c)).length;
  relatorio.total = produtos.length;
  relatorio.comFoto = produtos.filter((p) => p.imagem).length;

  return { produtos, relatorio };
}

/**
 * Agrupa os códigos irmãos (cores do mesmo produto) num card só.
 * Cada cor continua sendo um código próprio, com preço e saldo próprios —
 * é assim que a Maxprint precisa receber o pedido.
 */
function agruparCores(produtos) {
  const porCodigo = new Map(produtos.map((p) => [p.codigo, p]));
  const usados = new Set();
  const cards = [];

  for (const p of produtos) {
    if (usados.has(p.codigo)) continue;

    const irmaos = (p.grupoCores || [])
      .map((c) => porCodigo.get(normalizarCodigo(c)))
      .filter(Boolean)
      .filter((x) => !usados.has(x.codigo));

    const cores = irmaos.length ? irmaos : [p];
    cores.forEach((c) => usados.add(c.codigo));

    cards.push({
      chave: cores[0].codigo,
      nome: cores[0].nome,
      categoria: cores[0].categoria,
      linhaProduto: cores[0].linhaProduto,
      curvaA: cores.some((c) => c.curvaA),
      outlet: cores.some((c) => c.outlet),
      cores: cores.map((c) => ({ ...c })),
    });
  }

  return cards;
}

module.exports = { cruzar, agruparCores, modelosDaDescricao };
