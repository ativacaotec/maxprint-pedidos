'use strict';

const mongoose = require('mongoose');

/**
 * Histórico das importações, com o relatório de conferência de cada uma.
 *
 * Existe para responder a pergunta que sempre aparece depois: "por que esse
 * item sumiu do catálogo?". O relatório guarda quantos itens entraram, quantos
 * cruzaram com as outras bases e quais ficaram órfãos.
 */
const ImportacaoSchema = new mongoose.Schema(
  {
    tipo: { type: String, enum: ['catalogo', 'estoque', 'preco'], required: true, index: true },
    arquivos: { type: Array, default: [] },
    usuario: { type: String, default: '' },
    duracaoSegundos: { type: Number, default: 0 },
    relatorio: { type: Object, default: {} },
    avisos: { type: Array, default: [] },
    erro: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Importacao', ImportacaoSchema);
