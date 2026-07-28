'use strict';

const Produto = require('../models/Produto');
const Usuario = require('../models/Usuario');
const Config = require('../models/Config');
const { precoUnitario, fatorPrazo, CONDICOES } = require('./prazo');

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
    imagem: p.imagemManual || p.imagem || '',
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
    // Quanto ele pode digitar: o saldo de hoje, ou a previsão quando não há saldo.
    limite: disponivel ? p.estoque : previsto,
    natureza: disponivel ? 'pronta' : 'programado',
  };
}

async function carregarCliente(usuarioSessao) {
  if (!usuarioSessao) return null;
  return Usuario.findById(usuarioSessao.id).lean();
}

/**
 * Catálogo completo já precificado para um cliente e uma condição de pagamento.
 */
async function montarCatalogo(usuarioSessao, condicao) {
  const config = await Config.carregar();
  const cliente = await carregarCliente(usuarioSessao);
  const ehCliente = usuarioSessao.perfil === 'cliente';

  const desconto = ehCliente ? (cliente?.desconto || 0) : 0;
  const verOutlet = ehCliente ? cliente?.verOutlet !== false : true;
  const permitirProgramado = ehCliente ? cliente?.permitirProgramado !== false : true;

  const filtro = { ativo: true, precoBase: { $gt: 0 } };
  if (!verOutlet) filtro.outlet = { $ne: true };
  if (Array.isArray(config.statusBloqueados) && config.statusBloqueados.length) {
    filtro.status = { $nin: config.statusBloqueados };
  }

  const produtos = await Produto.find(filtro).lean();
  const info = fatorPrazo(condicao);

  const lista = [];
  for (const p of produtos) {
    const disponivel = p.estoque > 0;
    const previsto = p.previstoTotal || 0;
    // Item sem saldo e sem previsão não tem o que oferecer.
    if (!disponivel && previsto <= 0) continue;
    if (!disponivel && !permitirProgramado) continue;

    const calc = precoUnitario(p.precoBase, desconto, condicao);
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
    produtos: lista,
    categorias,
    linhas,
    ranking,
    condicoes: CONDICOES.map((c) => ({ id: c.id, rotulo: c.rotulo })),
    condicaoAtual: condicao,
    acrescimoPrazo: info.acrescimo,
    prazoMedio: info.prazoMedio,
    negociar: info.negociar,
    pedidoMinimo: config.pedidoMinimo,
    valorFreteCif: config.valorFreteCif,
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
