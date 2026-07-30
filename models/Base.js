'use strict';

const mongoose = require('mongoose');

/**
 * Guarda o resultado bruto de cada importação, para que o cruzamento possa ser
 * refeito quando qualquer uma das bases mudar.
 *
 * Por que guardar o bruto: as importações são independentes. Se o Marcelo sobe
 * só a tabela de preço nova, o sistema precisa recruzar com o estoque e o
 * catálogo que já estavam lá, sem exigir que ele suba tudo de novo. E a base
 * que ele subiu por último continua valendo até ele mesmo mandar substituir —
 * nada aqui se apaga sozinho.
 *
 * POR MARCA, e isso é recente.
 * Até 30/07/2026 a chave era só o `tipo`, com índice único. Funcionava porque
 * só a Maxprint tinha base guardada. Com a Samsonite passando a guardar a dela
 * e a Yins a caminho, a base da marca nova gravaria por cima da base da
 * Maxprint — mesmo `tipo`, mesmo documento. Agora a chave é (marcaSlug, tipo).
 *
 * Tipos por marca:
 *   maxprint  → preco, estoque, catalogo, catalogoModelos
 *   samsonite → base (o HTML da aplicação antiga), catalogo (fichas dos PDFs)
 */
const BaseSchema = new mongoose.Schema(
  {
    marcaSlug: { type: String, default: 'maxprint', index: true },
    tipo: {
      type: String,
      enum: ['catalogo', 'estoque', 'preco', 'catalogoModelos', 'base'],
      required: true,
    },
    itens: { type: Array, default: [] },
    origem: { type: Array, default: [] },
    atualizadoEm: { type: Date, default: Date.now },
  },
  { minimize: false }
);

BaseSchema.index({ marcaSlug: 1, tipo: 1 }, { unique: true });

module.exports = mongoose.model('Base', BaseSchema);
