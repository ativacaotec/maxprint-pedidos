'use strict';

const mongoose = require('mongoose');

/**
 * Uma marca do sistema = uma aba no catálogo do cliente, com identidade
 * visual e regras de prazo/preço próprias.
 *
 * Samsonite, Xtrem, American Tourister etc. NÃO são marcas separadas aqui —
 * são `subMarca` dentro de UMA marca ('samsonite'), com uma aba, um carrinho
 * e um pedido só, conforme combinado com o Marcelo. Yins entra depois como
 * um novo documento, sem precisar mexer no resto do sistema.
 *
 * A logo segue a regra dada pelo Marcelo: fundo escuro usa a clara, fundo
 * claro usa a escura (cabeçalho do sistema é escuro; PDF/Excel do pedido são
 * fundo branco).
 */
const CondicaoSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    rotulo: { type: String, required: true },
    parcelas: { type: [Number], default: [] }, // dias de cada parcela; [30,60,90] = 30/60/90
  },
  { _id: false }
);

const MarcaSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    nome: { type: String, required: true },

    ativa: { type: Boolean, default: true },
    ordem: { type: Number, default: 0 }, // ordem das abas na tela do cliente

    /* ------------------------- identidade visual -------------------------- */
    corPrimaria: { type: String, default: '#0a1f44' },
    corSecundaria: { type: String, default: '#c9a24b' },
    logoClara: { type: String, default: '' },  // usar sobre fundo escuro
    logoEscura: { type: String, default: '' }, // usar sobre fundo claro

    /**
     * Cor de destaque por sub-marca (a Samsonite tem várias dentro da mesma
     * aba: Samsonite, American Tourister, Xtrem...). Marcas sem sub-marca
     * (Maxprint) deixam isto vazio.
     */
    subMarcas: {
      type: [{ nome: { type: String, required: true }, cor: { type: String, required: true } }],
      default: [],
      _id: false,
    },

    /* --------------------------- regras de pedido -------------------------- */
    // null de propósito (não 0): "não configurado nesta marca, use o Config
    // global". Só vira um número quando alguém realmente decide o valor
    // dessa marca — 0 gravado explicitamente significa "sem mínimo".
    pedidoMinimo: { type: Number, default: null },
    valorFreteCif: { type: Number, default: null },

    /** Condições sempre oferecidas ao cliente, independente do valor do pedido. */
    condicoesPagamento: { type: [CondicaoSchema], default: [] },

    /**
     * Condições extras liberadas só quando o pedido bate um valor mínimo
     * (regra da Samsonite: 60/90, 90, 60/90/120 só acima de R$ 15.000). Fica
     * null/vazio nas marcas que não têm patamar — ex. Maxprint.
     */
    condicoesAcimaDeValor: {
      valorMinimo: { type: Number, default: 0 },
      condicoes: { type: [CondicaoSchema], default: [] },
    },

    /**
     * Se o prazo escolhido pesa no preço final (regra da Maxprint: prazo
     * médio acima de 30 dias soma até 2% no teto de 60 dias). A Samsonite não
     * tem essa regra — o preço não muda com o prazo, só a condição varia.
     */
    aplicarAcrescimoPrazo: { type: Boolean, default: false },
    prazoMaximoDias: { type: Number, default: 60 },
    acrescimoNoTeto: { type: Number, default: 0.02 },

    /**
     * Item sem saldo continua aparecendo no catálogo, marcado como "sem
     * estoque"?
     *
     * Na Maxprint fica `false`: lá, item sem saldo tem previsão de chegada e
     * vira pedido programado; o que não tem saldo NEM previsão é descontinuado
     * e some mesmo.
     *
     * Na Samsonite fica `true`: a Samsonite não informa previsão de chegada,
     * então a regra da Maxprint apagaria do catálogo quase mil itens que
     * existem e voltam a ter saldo. O cliente precisa ver que o produto
     * existe, mesmo que hoje não dê para comprar.
     */
    mostrarSemEstoque: { type: Boolean, default: false },

    /**
     * O saldo desta marca é uma TARJA, não um número.
     *
     * A Yin's publica REGULAR, REDUZIDO, ZERADO ou PRÉ-VENDA em vez de
     * quantidade. Com isto ligado, o catálogo para de tentar mostrar "40
     * disponíveis" e de limitar a quantidade pelo saldo — quem decide se o
     * item pode ser pedido é a tarja, e ZERADO fica só para consulta.
     */
    saldoPorSituacao: { type: Boolean, default: false },

    /**
     * O preço do catálogo é CUSTO, com o imposto informado à parte.
     *
     * Na Yin's o valor impresso é o custo do item e, logo abaixo, se ele tem
     * IPI (com percentual) e ST (sem, porque o percentual varia por estado). A
     * tela precisa saber disso para escrever o imposto embaixo do preço, em
     * vez de fingir que aquele é o valor final.
     */
    precoEhCusto: { type: Boolean, default: false },

    /** Sobrepõe Config.emailsAviso quando precisar avisar gente diferente por marca. Vazio = usa o global. */
    emailsAviso: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Marca', MarcaSchema);
