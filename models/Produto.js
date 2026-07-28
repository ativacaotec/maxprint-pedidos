'use strict';

const mongoose = require('mongoose');

/**
 * Produto do catálogo de pronto entrega.
 *
 * Um documento por CÓDIGO. Cor é código próprio na Maxprint, então cada cor é
 * um produto — é assim que a indústria precisa receber o pedido. O agrupamento
 * visual das cores num card só acontece na tela, usando `grupoCores`.
 *
 * Este documento é sempre resultado das três importações. Não existe cadastro
 * manual de produto: a fonte da verdade são os arquivos que a Maxprint manda.
 * A única exceção é o campo `imagemManual`, que o admin pode preencher para
 * cobrir os itens que o catálogo não ilustra.
 */
const ProdutoSchema = new mongoose.Schema(
  {
    codigo: { type: String, required: true, unique: true, index: true },
    codigoOriginal: { type: String, default: '' },

    nome: { type: String, default: '' },
    descricaoEstoque: { type: String, default: '' },
    nomeTabela: { type: String, default: '' },

    categoria: { type: String, default: '', index: true },   // aba da tabela de preço
    linhaProduto: { type: String, default: '', index: true }, // linha do mapa de chegadas
    marca: { type: String, default: '' },

    /* ---------------------------- preço ---------------------------------- */
    precoBase: { type: Number, default: 0 },  // Preço c/ IPI da tabela
    precoSemIpi: { type: Number, default: null },
    ipi: { type: Number, default: null },
    st: { type: Number, default: null },      // guardado só como informação
    ean: { type: String, default: '' },
    ncm: { type: String, default: '' },
    cxMaster: { type: Number, default: null },
    outlet: { type: Boolean, default: false },
    curvaA: { type: Boolean, default: false },

    /* --------------------------- estoque --------------------------------- */
    estoque: { type: Number, default: 0 },
    status: { type: String, default: '' },    // ATIVO / ATC / LANCAMENTO / NOVO
    chegadas: { type: Array, default: [] },   // [{ mes, rotulo, quantidade }]
    previstoTotal: { type: Number, default: 0 },
    observacaoEstoque: { type: String, default: '' },

    /* --------------------------- catálogo -------------------------------- */
    imagem: { type: String, default: '' },
    imagemManual: { type: String, default: '' },      // subida pelo admin, tem prioridade
    imagemPorModelo: { type: Boolean, default: false },
    imagemIlustrativa: { type: Boolean, default: false }, // foto da linha, não do item
    especificacoes: { type: Array, default: [] },
    embalagem: { type: String, default: '' },
    caixaMaster: { type: Object, default: null },
    caixaInner: { type: Object, default: null },
    inmetro: { type: Boolean, default: false },
    paginaCatalogo: { type: Number, default: null },
    grupoCores: { type: Array, default: [] },

    ativo: { type: Boolean, default: true },
  },
  { timestamps: true }
);

ProdutoSchema.index({ nome: 'text', descricaoEstoque: 'text', nomeTabela: 'text' });

/** A imagem que vale: a que o admin subiu vence a que veio do PDF. */
ProdutoSchema.virtual('foto').get(function foto() {
  return this.imagemManual || this.imagem || '';
});

ProdutoSchema.set('toJSON', { virtuals: true });
ProdutoSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Produto', ProdutoSchema);
