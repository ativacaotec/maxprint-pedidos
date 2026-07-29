'use strict';

const Marca = require('../models/Marca');
const { CONDICOES, PRAZO_MAXIMO_DIAS, ACRESCIMO_NO_TETO } = require('./prazo');

/**
 * Marca 'maxprint' virtual, só usada quando o banco ainda não tem o
 * documento correspondente (ambiente novo, antes do `seed_marcas.js` rodar).
 * Garante que a Maxprint nunca fica fora do ar por faltar um registro —
 * reflete exatamente a regra hardcoded que o sistema tinha antes do
 * multimarca.
 */
const MARCA_PADRAO_MAXPRINT = {
  slug: 'maxprint',
  nome: 'Maxprint',
  ativa: true,
  ordem: 1,
  corPrimaria: '#EB8704',
  corSecundaria: '#000000',
  condicoesPagamento: CONDICOES,
  condicoesAcimaDeValor: null,
  aplicarAcrescimoPrazo: true,
  prazoMaximoDias: PRAZO_MAXIMO_DIAS,
  acrescimoNoTeto: ACRESCIMO_NO_TETO,
  pedidoMinimo: null, // null = "usa o Config global", ver routes/pedidos.js
  valorFreteCif: null,
  emailsAviso: [],
  subMarcas: [],
};

/** Carrega uma marca pelo slug. Devolve null quando não existe (nem no banco, nem como padrão). */
async function carregarMarca(slug) {
  const s = String(slug || '').toLowerCase().trim();
  if (!s) return null;
  const doc = await Marca.findOne({ slug: s }).lean();
  if (doc) return doc;
  if (s === 'maxprint') return MARCA_PADRAO_MAXPRINT;
  return null;
}

/** Todas as marcas ativas, na ordem de exibição das abas. */
async function listarMarcasAtivas() {
  const todas = await Marca.find({ ativa: true }).sort({ ordem: 1, nome: 1 }).lean();
  return todas.length ? todas : [MARCA_PADRAO_MAXPRINT];
}

/**
 * As marcas que o usuário da sessão pode ver: equipe (admin/interno) vê
 * todas as ativas; cliente vê só as que estão na lista `marcasPermitidas`
 * da própria ficha (default `['maxprint']`, ver models/Usuario.js).
 */
async function listarMarcasVisiveis(usuarioSessao) {
  const ativas = await listarMarcasAtivas();
  if (!usuarioSessao || usuarioSessao.perfil !== 'cliente') return ativas;
  const permitidas = new Set(
    Array.isArray(usuarioSessao.marcasPermitidas) && usuarioSessao.marcasPermitidas.length
      ? usuarioSessao.marcasPermitidas
      : ['maxprint']
  );
  return ativas.filter((m) => permitidas.has(m.slug));
}

/** true se o usuário da sessão pode acessar essa marca (catálogo/pedido). */
function podeAcessarMarca(usuarioSessao, marcaSlug) {
  if (!usuarioSessao) return false;
  if (usuarioSessao.perfil !== 'cliente') return true; // equipe do escritório vê tudo
  const permitidas = Array.isArray(usuarioSessao.marcasPermitidas) && usuarioSessao.marcasPermitidas.length
    ? usuarioSessao.marcasPermitidas
    : ['maxprint'];
  return permitidas.includes(marcaSlug);
}

module.exports = { carregarMarca, listarMarcasAtivas, listarMarcasVisiveis, podeAcessarMarca, MARCA_PADRAO_MAXPRINT };
