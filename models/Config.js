'use strict';

const mongoose = require('mongoose');

/**
 * Configurações que o Marcelo pode mudar sem mexer no código.
 * Um único documento, criado com os valores combinados em 28/07/2026.
 */
const ConfigSchema = new mongoose.Schema(
  {
    chave: { type: String, default: 'geral', unique: true },

    /** Pedido mínimo. Abaixo disso o pedido não fecha. */
    pedidoMinimo: { type: Number, default: 3000 },

    /** A partir deste valor o frete vira CIF e aparece o aviso no carrinho. */
    valorFreteCif: { type: Number, default: 3000 },

    /** Quantos itens de maior estoque aparecem no destaque de cada categoria. */
    itensRanking: { type: Number, default: 15 },

    /** Status do mapa de chegadas que NÃO entram no catálogo do cliente. */
    statusBloqueados: { type: Array, default: [] },

    /** E-mails que recebem o aviso de pedido novo. */
    emailsAviso: {
      type: Array,
      default: ['marcelocarvalho.ativacao@gmail.com', 'pedidos.ativacao@gmail.com'],
    },

    nomeEmpresa: { type: String, default: 'Ativação Group' },
    tituloSistema: { type: String, default: 'Pedidos Maxprint' },
  },
  { timestamps: true }
);

ConfigSchema.statics.carregar = async function carregar() {
  let c = await this.findOne({ chave: 'geral' });
  if (!c) c = await this.create({ chave: 'geral' });
  return c;
};

module.exports = mongoose.model('Config', ConfigSchema);
