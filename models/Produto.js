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
    /**
     * Marca do sistema (aba do cliente): 'maxprint', 'samsonite', e no futuro
     * 'yins'. Um único produto pertence a uma marca só — Samsonite, Xtrem e
     * American Tourister não são marcas separadas aqui, são `subMarca` dentro
     * da marca 'samsonite' (ver lib/importSamsonite.js).
     *
     * O código deixou de ser único sozinho (ver índice composto abaixo) porque
     * duas marcas diferentes podem, em tese, usar o mesmo código por
     * coincidência — melhor não depender disso nunca acontecer.
     */
    marcaSlug: { type: String, default: 'maxprint', index: true },

    codigo: { type: String, required: true, index: true },
    codigoOriginal: { type: String, default: '' },

    nome: { type: String, default: '' },
    descricaoEstoque: { type: String, default: '' },
    nomeTabela: { type: String, default: '' },

    categoria: { type: String, default: '', index: true },   // aba da tabela de preço / sub-marca
    linhaProduto: { type: String, default: '', index: true }, // linha do mapa de chegadas
    marca: { type: String, default: '' },

    /* ---------------- campos específicos da Samsonite -------------------- */
    // Ficam vazios/zerados para produtos Maxprint; existem só para não perder
    // informação do importador da Samsonite (lib/importSamsonite.js) na hora
    // de gravar no banco.
    subMarca: { type: String, default: '', index: true },   // Xtrem / Samsonite / American Tourister...
    grupo: { type: String, default: '' },                    // linha/coleção (ex. "BAHIA LITE")
    tipoProduto: { type: String, default: '' },               // ex. "SPINNER 55 EXP"
    descricaoArquivo: { type: String, default: '' },
    cor: { type: String, default: '' },                       // nome da cor em inglês
    modelo: { type: String, default: '' },
    precoCheio: { type: Number, default: 0 },
    emPromocao: { type: Boolean, default: false },
    descontoPromo: { type: Number, default: 0 },              // percentual, ex. 40 = 40%
    precoVarejo: { type: Number, default: 0 },
    imagemPagina: { type: String, default: '' },              // página inteira do catálogo, ilustrativa
    fotoOrigem: { type: String, default: '' },                 // de onde veio a foto, para conferência

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

// Único por marca + código, não por código sozinho: a mesma string de
// código não pode se repetir DENTRO da mesma marca, mas nada impede que
// Maxprint e Samsonite usem, por coincidência, o mesmo número um dia.
ProdutoSchema.index({ marcaSlug: 1, codigo: 1 }, { unique: true });
ProdutoSchema.index({ nome: 'text', descricaoEstoque: 'text', nomeTabela: 'text' });

/** A imagem que vale: a que o admin subiu vence a que veio do PDF. */
ProdutoSchema.virtual('foto').get(function foto() {
  return this.imagemManual || this.imagem || '';
});

ProdutoSchema.set('toJSON', { virtuals: true });
ProdutoSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Produto', ProdutoSchema);
