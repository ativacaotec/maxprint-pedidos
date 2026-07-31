'use strict';

const mongoose = require('mongoose');

/**
 * Pedido enviado pelo cliente.
 *
 * O preço de cada linha é gravado no momento do envio. Isso é de propósito: a
 * tabela da Maxprint muda todo mês, e um pedido de julho precisa continuar
 * valendo o que valia em julho, mesmo depois de a tabela de agosto entrar.
 *
 * As linhas têm duas naturezas:
 *  - 'pronta'      sai do estoque de hoje
 *  - 'programado'  reserva contra a previsão de chegada
 * As duas convivem no mesmo pedido, com totais separados.
 */
const ItemSchema = new mongoose.Schema(
  {
    codigo: { type: String, required: true },
    codigoOriginal: { type: String, default: '' },
    nome: { type: String, default: '' },
    categoria: { type: String, default: '' },
    imagem: { type: String, default: '' },

    quantidade: { type: Number, required: true, min: 1 },
    natureza: { type: String, enum: ['pronta', 'programado'], default: 'pronta' },
    mesChegada: { type: String, default: '' },

    precoTabela: { type: Number, default: 0 },   // Preço c/ IPI, sem desconto
    precoUnitario: { type: Number, default: 0 }, // já com desconto e acréscimo de prazo
    total: { type: Number, default: 0 },

    estoqueNoMomento: { type: Number, default: 0 },

    /**
     * Como este item é vendido e como estava o estoque na hora do pedido.
     *
     * Os dois nascem da Yin's e vão para o PDF de propósito. `models/Produto`
     * já avisa por que a unidade importa: "a unidade de venda muda de catálogo
     * para catálogo (peça, embalagem, kit, par, jogo). Quem digita 24 achando
     * que são peças, num item vendido em embalagem de 12, está pedindo 288".
     * A tela mostra isso; o pedido não mostrava, e quem digita na fábrica lia
     * só o número.
     *
     * A tarja é a outra metade: `lib/catalogoServico.js` promete que o item
     * REDUZIDO "sai marcado na tela e no PDF do pedido — o cliente precisa
     * saber que pode não vir tudo". No PDF isso não existia.
     */
    unidadeVenda: { type: String, default: '' },
    situacaoEstoque: { type: String, default: '' },
  },
  { _id: false }
);

const PedidoSchema = new mongoose.Schema(
  {
    numero: { type: Number, unique: true, index: true },

    /**
     * Marca a que esse pedido pertence ('maxprint', 'samsonite'...). A
     * numeração continua uma sequência só, compartilhada entre marcas — é
     * mais simples para o Marcelo acompanhar um único fluxo de números, e
     * nada no pedido depende de a numeração ser por marca.
     */
    marcaSlug: { type: String, default: 'maxprint', index: true },

    clienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', index: true },
    clienteUsuario: { type: String, default: '' },

    /* --------------------- cabeçalho do pedido --------------------------- */
    razaoSocial: { type: String, default: '' },
    cnpj: { type: String, default: '' },
    endereco: { type: String, default: '' },
    telefone: { type: String, default: '' },
    email: { type: String, default: '' },
    vendedor: { type: String, default: '' },
    transportadora: { type: String, default: '' },
    frete: { type: String, default: '' },       // CIF ou FOB
    condicao: { type: String, default: '' },    // id da condição
    condicaoRotulo: { type: String, default: '' },
    prazoMedio: { type: Number, default: 0 },
    acrescimoPrazo: { type: Number, default: 0 },
    descontoCliente: { type: Number, default: 0 },
    observacoes: { type: String, default: '' },

    itens: { type: [ItemSchema], default: [] },

    totalPronta: { type: Number, default: 0 },
    totalProgramado: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    pecas: { type: Number, default: 0 },

    /**
     * novo      -> acabou de chegar, ainda não foi olhado
     * digitado  -> já foi lançado no portal da Maxprint
     * faturado  -> virou nota
     * cancelado -> não vai acontecer
     */
    status: { type: String, enum: ['novo', 'digitado', 'faturado', 'cancelado'], default: 'novo', index: true },
    observacaoInterna: { type: String, default: '' },
    avisoEnviado: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/**
 * Numeração sequencial, feita na hora de salvar o primeiro registro.
 *
 * O número sai do maior que existe no banco E do maior que JÁ EXISTIU, que
 * fica guardado na configuração. A segunda parte é o que impede o número de um
 * pedido excluído de voltar: apagando o pedido 1042, o banco passaria a achar
 * que o maior é 1041 e o próximo cliente ganharia um 1042 novo — com o PDF do
 * 1042 antigo já circulando por aí.
 */
PedidoSchema.pre('validate', async function numerar(next) {
  if (this.numero) return next();
  try {
    const Config = require('./Config');
    const [ultimo, config] = await Promise.all([
      this.constructor.findOne().sort({ numero: -1 }).select('numero').lean(),
      Config.carregar(),
    ]);
    const noBanco = (ultimo && ultimo.numero) || 0;
    const jaUsado = (config && config.ultimoNumeroPedido) || 0;
    this.numero = Math.max(noBanco, jaUsado, 1000) + 1;
    next();
  } catch (e) {
    next(e);
  }
});

module.exports = mongoose.model('Pedido', PedidoSchema);
