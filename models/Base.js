'use strict';

const mongoose = require('mongoose');

/**
 * Guarda o resultado bruto de cada importação, para que o cruzamento possa ser
 * refeito quando qualquer uma das três bases mudar.
 *
 * Por que guardar o bruto: as três importações são independentes. Se o Marcelo
 * sobe só a tabela de preço nova, o sistema precisa recruzar com o estoque e o
 * catálogo que já estavam lá, sem exigir que ele suba tudo de novo.
 */
const BaseSchema = new mongoose.Schema(
  {
    tipo: { type: String, enum: ['catalogo', 'estoque', 'preco', 'catalogoModelos'], required: true, unique: true },
    itens: { type: Array, default: [] },
    origem: { type: Array, default: [] },
    atualizadoEm: { type: Date, default: Date.now },
  },
  { minimize: false }
);

module.exports = mongoose.model('Base', BaseSchema);
