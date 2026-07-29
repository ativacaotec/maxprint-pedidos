'use strict';

const Produto = require('../models/Produto');
const Usuario = require('../models/Usuario');
const Config = require('../models/Config');
const { precoUnitario, fatorPrazo, condicoesDisponiveis, regrasDaMarca, CONDICOES } = require('./prazo');

/**
 * Monta o catálogo do jeito que o CLIENTE pode ver.
 *
 * Regra de ouro: o desconto do cliente e a conta de formação de preço não saem
 * daqui. O navegador recebe o preço final e mais nada. É o mesmo cuidado que o
 * catálogo PUMA já toma com markup e desconto adicional.
 */

function limparParaCliente(p, precoCalculado, config) {
  const disponivel = p.estoque > 0;
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

    preco: precoCalculado.preco,
    estoque: p.estoque,
    disponivel,
    chegadas: p.chegadas || [],
    previsto,
    // Quanto ele pode digitar: o saldo de hoje, ou a previsão quando não há
    // saldo. Zero nos dois casos = item visível só para consulta.
    limite: disponivel ? p.estoque : previsto,
    natureza: disponivel ? 'pronta' : 'programado',
    // Sem saldo e sem previsão: aparece no catálogo, mas não dá para pedir.
    // É diferente de "programado", que dá para reservar contra a chegada.
    semEstoque: !disponivel && previsto <= 0,
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

  const lista = [];
  for (const p of produtos) {
    const disponivel = p.estoque > 0;
    const previsto = p.previstoTotal || 0;
    // Item sem saldo e sem previsão não tem o que oferecer — a não ser que a
    // marca peça para mostrar assim mesmo.
    if (!disponivel && previsto <= 0 && !mostrarSemEstoque) continue;
    if (!disponivel && previsto > 0 && !permitirProgramado) continue;

    const calc = precoUnitario(p.precoBase, desconto, condicao, regras);
    lista.push(limparParaCliente(p, calc, config));
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
  for (const [cat, itens] of Object.entries(porCategoria)) {
    ranking[cat] = itens
      .filter((i) => i.disponivel)
      .sort((a, b) => b.estoque - a.estoque)
      .slice(0, config.itensRanking)
      .map((i) => i.codigo);
  }

  const categorias = Object.keys(porCategoria).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const linhas = {};
  for (const [cat, itens] of Object.entries(porCategoria)) {
    linhas[cat] = [...new Set(itens.map((i) => i.linhaProduto).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  return {
    marca: marcaSlug,
    produtos: lista,
    categorias,
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
