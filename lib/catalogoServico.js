'use strict';

const Produto = require('../models/Produto');
const Usuario = require('../models/Usuario');
const Config = require('../models/Config');
const { precoUnitario, fatorPrazo, condicoesDisponiveis, regrasDaMarca, CONDICOES } = require('./prazo');
const { fabricanteDoProduto } = require('./fabricante');

/**
 * Monta o catálogo do jeito que o CLIENTE pode ver.
 *
 * Regra de ouro: o desconto do cliente e a conta de formação de preço não saem
 * daqui. O navegador recebe o preço final e mais nada. É o mesmo cuidado que o
 * catálogo PUMA já toma com markup e desconto adicional.
 */

/**
 * Limite de quantidade de uma marca que trabalha por tarja, e não por saldo.
 *
 * Sem número não dá para dizer "máximo 40 peças". O que existe é a tarja, e
 * ela responde outra pergunta: dá para pedir? ZERADO não; o resto sim, sem
 * teto. O REDUZIDO passa, mas sai marcado na tela e no PDF do pedido — o
 * cliente precisa saber que pode não vir tudo.
 */
const TETO_SEM_SALDO = 999999;

function porSituacao(p) {
  const s = String(p.situacaoEstoque || '').toUpperCase();
  const zerado = s === 'ZERADO' || s === '';
  return {
    disponivel: !zerado,
    limite: zerado ? 0 : TETO_SEM_SALDO,
    semEstoque: zerado,
    natureza: s === 'PRE-VENDA' ? 'programado' : 'pronta',
  };
}

function limparParaCliente(p, precoCalculado, config, marca, nomeDaMarca) {
  const porTarja = marca && marca.saldoPorSituacao;
  const situacao = porTarja ? porSituacao(p) : null;
  const disponivel = porTarja ? situacao.disponivel : p.estoque > 0;
  const previsto = p.previstoTotal || 0;

  return {
    codigo: p.codigo,
    codigoOriginal: p.codigoOriginal,
    nome: p.nome,
    categoria: p.categoria,
    linhaProduto: p.linhaProduto,
    marca: p.marca,
    // Campos que só existem em marcas com sub-marca (Samsonite) — ficam
    // vazios/omitidos na prática para a Maxprint, sem custo para ela.
    subMarca: p.subMarca || '',
    // De quem é o produto de fato. A base da Maxprint carrega a linha Logitech
    // junto, e quem vende precisa poder olhar uma, a outra ou as duas.
    fabricante: fabricanteDoProduto(p, nomeDaMarca),
    grupo: p.grupo || '',
    tipoProduto: p.tipoProduto || '',
    cor: p.cor || '',
    precoCheio: p.precoCheio || 0,
    emPromocao: !!p.emPromocao,
    imagem: p.imagemManual || p.imagem || p.imagemPagina || '',
    imagemIlustrativa: !!p.imagemIlustrativa && !p.imagemManual,
    especificacoes: p.especificacoes || [],
    embalagem: p.embalagem || '',
    cxMaster: p.cxMaster || null,
    caixaInner: p.caixaInner || null,
    ean: p.ean || '',
    inmetro: !!p.inmetro,
    curvaA: !!p.curvaA,
    outlet: !!p.outlet,
    grupoCores: p.grupoCores || [],

    /* ---- campos da Yin's: custo, imposto, tarja e unidade de venda ---- */
    situacaoEstoque: p.situacaoEstoque || '',
    unidadeVenda: p.unidadeVenda || '',
    pedidoMinimo: p.pedidoMinimo || 0,
    precoCaixa: p.precoCaixa || null,
    condicaoCaixa: p.condicaoCaixa || '',
    caixaMasterTexto: p.caixaMasterTexto || '',
    ipi: p.ipi === null || p.ipi === undefined ? null : p.ipi,
    temST: !!p.temST,
    lancamento: !!p.lancamento,
    catalogoNome: p.catalogoNome || '',
    segmento: p.segmento || '',
    ncm: p.ncm || '',

    preco: precoCalculado.preco,
    estoque: p.estoque,
    disponivel,
    chegadas: p.chegadas || [],
    previsto,
    // Quanto ele pode digitar: o saldo de hoje, ou a previsão quando não há
    // saldo. Zero nos dois casos = item visível só para consulta. Na marca que
    // trabalha por tarja, quem responde é a tarja.
    limite: porTarja ? situacao.limite : (disponivel ? p.estoque : previsto),
    natureza: porTarja ? situacao.natureza : (disponivel ? 'pronta' : 'programado'),
    // Sem saldo e sem previsão: aparece no catálogo, mas não dá para pedir.
    // É diferente de "programado", que dá para reservar contra a chegada.
    semEstoque: porTarja ? situacao.semEstoque : (!disponivel && previsto <= 0),
  };
}

async function carregarCliente(usuarioSessao) {
  if (!usuarioSessao) return null;
  return Usuario.findById(usuarioSessao.id).lean();
}

/**
 * Catálogo completo já precificado para um cliente e uma condição de pagamento.
 *
 * @param {object} usuarioSessao
 * @param {string} condicao
 * @param {object} [marca]  documento de lib/marcas.carregarMarca(); sem ele,
 *   cai no comportamento de antes do multimarca (Maxprint, filtro sem
 *   marcaSlug, regras de prazo hardcoded) — mantém compatibilidade.
 */
async function montarCatalogo(usuarioSessao, condicao, marca = null) {
  const config = await Config.carregar();
  const cliente = await carregarCliente(usuarioSessao);
  const ehCliente = usuarioSessao.perfil === 'cliente';

  const desconto = ehCliente ? (cliente?.desconto || 0) : 0;
  const verOutlet = ehCliente ? cliente?.verOutlet !== false : true;
  const permitirProgramado = ehCliente ? cliente?.permitirProgramado !== false : true;

  const marcaSlug = marca ? marca.slug : 'maxprint';
  // Nome de vitrine da marca: é ele que aparece no filtro de fabricante como a
  // opção "de casa", ao lado das linhas de terceiros que a base carrega.
  const nomeDaMarca = (marca && marca.nome) || (marcaSlug.charAt(0).toUpperCase() + marcaSlug.slice(1));
  const filtro = { marcaSlug, ativo: true, precoBase: { $gt: 0 } };
  if (!verOutlet) filtro.outlet = { $ne: true };
  if (Array.isArray(config.statusBloqueados) && config.statusBloqueados.length) {
    filtro.status = { $nin: config.statusBloqueados };
  }

  const regras = regrasDaMarca(marca);
  const produtos = await Produto.find(filtro).lean();
  const info = fatorPrazo(condicao, regras);

  // Marca que não trabalha com previsão de chegada (Samsonite) mostra o item
  // zerado marcado como "sem estoque". Sem isso a regra abaixo apagaria do
  // catálogo quase mil produtos que existem e voltam a ter saldo.
  const mostrarSemEstoque = !!(marca && marca.mostrarSemEstoque);

  // Marca que trabalha por tarja (Yin's) não passa pelo corte de saldo: lá o
  // item ZERADO precisa continuar na tela, marcado, porque o catálogo é o
  // material de venda inteiro da fábrica e o cliente pergunta pelo item que
  // não tem hoje.
  const porTarja = !!(marca && marca.saldoPorSituacao);

  const lista = [];
  for (const p of produtos) {
    if (!porTarja) {
      const disponivel = p.estoque > 0;
      const previsto = p.previstoTotal || 0;
      // Item sem saldo e sem previsão não tem o que oferecer — a não ser que a
      // marca peça para mostrar assim mesmo.
      if (!disponivel && previsto <= 0 && !mostrarSemEstoque) continue;
      if (!disponivel && previsto > 0 && !permitirProgramado) continue;
    }

    const calc = precoUnitario(p.precoBase, desconto, condicao, regras);
    lista.push(limparParaCliente(p, calc, config, marca, nomeDaMarca));
  }

  lista.sort((a, b) => {
    if (a.disponivel !== b.disponivel) return a.disponivel ? -1 : 1;
    if (a.curvaA !== b.curvaA) return a.curvaA ? -1 : 1;
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });

  // Ranking: os N itens de maior estoque de cada categoria, como combinado.
  const ranking = {};
  const porCategoria = {};
  for (const p of lista) {
    (porCategoria[p.categoria] = porCategoria[p.categoria] || []).push(p);
  }
  // Marca por tarja não tem ranking: a faixa de destaque promete "os itens com
  // mais estoque disponível agora", e sem número isso seria invenção.
  if (!porTarja) {
    for (const [cat, itens] of Object.entries(porCategoria)) {
      ranking[cat] = itens
        .filter((i) => i.disponivel)
        .sort((a, b) => b.estoque - a.estoque)
        .slice(0, config.itensRanking)
        .map((i) => i.codigo);
    }
  }

  const categorias = Object.keys(porCategoria).sort((a, b) => a.localeCompare(b, 'pt-BR'));

  // Os fabricantes que a base desta marca realmente carrega, com quantos itens
  // cada um tem. A tela só desenha o filtro quando há mais de um — numa marca
  // que não distribui ninguém, ele não aparece.
  const contagemFabricante = new Map();
  for (const p of lista) contagemFabricante.set(p.fabricante, (contagemFabricante.get(p.fabricante) || 0) + 1);
  const fabricantes = [...contagemFabricante.entries()]
    .map(([nome, quantos]) => ({ nome, quantos }))
    .sort((a, b) => (a.nome === nomeDaMarca ? -1 : b.nome === nomeDaMarca ? 1 : b.quantos - a.quantos));

  const linhas = {};
  for (const [cat, itens] of Object.entries(porCategoria)) {
    linhas[cat] = [...new Set(itens.map((i) => i.linhaProduto).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  return {
    marca: marcaSlug,
    // Como esta marca trabalha: saldo em número ou em tarja, preço final ou
    // custo com imposto à parte. A tela muda de cara com isso.
    saldoPorSituacao: porTarja,
    precoEhCusto: !!(marca && marca.precoEhCusto),
    // A tela precisa saber se quem olha é da casa: só o admin vê o botão de
    // anexar foto, e é ele quem conserta a foto errada na hora em que percebe,
    // sem ter que anotar o código e ir até o painel.
    interno: !ehCliente,
    admin: usuarioSessao.perfil === 'admin',
    produtos: lista,
    categorias,
    fabricantes,
    linhas,
    ranking,
    condicoes: regras.condicoes.map((c) => ({ id: c.id, rotulo: c.rotulo })),
    // Condições extras (ex.: 60/90, 90, 60/90/120 da Samsonite) que só ficam
    // disponíveis quando o pedido bate um valor mínimo — a tela do carrinho
    // é quem sabe o total corrente e decide quando liberar.
    condicoesAcimaDeValor: regras.condicoesAcimaDeValor
      ? {
          valorMinimo: regras.condicoesAcimaDeValor.valorMinimo,
          condicoes: regras.condicoesAcimaDeValor.condicoes.map((c) => ({ id: c.id, rotulo: c.rotulo })),
        }
      : null,
    condicaoAtual: condicao,
    acrescimoPrazo: info.acrescimo,
    prazoMedio: info.prazoMedio,
    negociar: info.negociar,
    pedidoMinimo: marca && marca.pedidoMinimo !== null && marca.pedidoMinimo !== undefined ? marca.pedidoMinimo : config.pedidoMinimo,
    valorFreteCif: marca && marca.valorFreteCif !== null && marca.valorFreteCif !== undefined ? marca.valorFreteCif : config.valorFreteCif,
    itensRanking: config.itensRanking,
    permitirProgramado,
    cliente: ehCliente
      ? {
          nome: cliente.nome,
          razaoSocial: cliente.razaoSocial,
          cnpj: cliente.cnpj,
          endereco: cliente.endereco,
          telefone: cliente.telefone,
          email: cliente.email,
          vendedor: cliente.vendedor,
          transportadora: cliente.transportadora,
        }
      : { nome: usuarioSessao.nome, razaoSocial: '', cnpj: '', endereco: '', telefone: '', email: '', vendedor: usuarioSessao.nome, transportadora: '' },
  };
}

module.exports = { montarCatalogo };
