'use strict';

/**
 * Garante que as marcas do sistema existem no banco, com as regras já
 * combinadas com o Marcelo. Idempotente: roda quantas vezes precisar, só
 * cria o que ainda não existe (upsert por slug) — não sobrescreve um ajuste
 * manual feito depois pela aba Marcas do painel.
 *
 * Uso:
 *   node scripts/seed_marcas.js
 */

// Sem isto o script ignora o MONGO_URL do .env e escreve no banco padrão.
// Hoje os dois coincidem, então não daria erro — daria coisa pior: as marcas
// criadas num banco e o sistema lendo de outro, sem ninguém entender por quê.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Marca = require('../models/Marca');

const MONGO = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/maxprint_pedidos';

const MARCAS = [
  {
    slug: 'maxprint',
    nome: 'Maxprint',
    ativa: true,
    ordem: 1,
    corPrimaria: '#EB8704', // laranja Ativação, já em produção
    corSecundaria: '#000000',
    // pedidoMinimo/valorFreteCif ficam de fora de propósito (null): a Maxprint
    // continua usando o valor editável em Config (aba Configurações do
    // painel), do jeito que já funciona hoje. Gravar um número aqui faria
    // essa tela parar de valer para a Maxprint.
    // Mesma tabela hardcoded que lib/prazo.js já usava antes do multimarca —
    // gravada aqui só para a aba Marcas do painel poder mostrar/editar; o
    // motor de preço cai nas constantes do próprio lib/prazo.js quando não
    // encontra a marca, então isto não é obrigatório para a Maxprint seguir
    // funcionando.
    condicoesPagamento: [
      { id: 'a_vista', rotulo: 'À vista', parcelas: [0] },
      { id: '30', rotulo: '30 dias', parcelas: [30] },
      { id: '30_60', rotulo: '30/60', parcelas: [30, 60] },
      { id: '60', rotulo: '60 dias', parcelas: [60] },
      { id: '30_60_90', rotulo: '30/60/90', parcelas: [30, 60, 90] },
    ],
    condicoesAcimaDeValor: { valorMinimo: 0, condicoes: [] },
    aplicarAcrescimoPrazo: true,
    prazoMaximoDias: 60,
    acrescimoNoTeto: 0.02,
  },
  {
    slug: 'samsonite',
    nome: 'Samsonite',
    ativa: true,
    ordem: 2,
    corPrimaria: '#0B6BB3', // azul Samsonite
    corSecundaria: '#F5891F', // laranja usado no material da marca
    // Marcelo, 29/07/2026, em duas mensagens:
    //   "o mínimo é 5.000,00 para frete cif"  → patamar do FRETE CIF
    //   "o pedido mínimo da Samsonite é 3.500,00"
    // São dois números diferentes de propósito: o pedido fecha a partir de
    // R$ 3.500 e o frete passa a ser por conta da casa a partir de R$ 5.000.
    pedidoMinimo: 3500,
    valorFreteCif: 5000,
    // Tabela dada pelo Marcelo em 29/07/2026: "30, 30/60, 60, 30/60/90. Para
    // pedidos acima de 15.000: 60/90, 90, 60/90/120".
    condicoesPagamento: [
      { id: '30', rotulo: '30 dias', parcelas: [30] },
      { id: '30_60', rotulo: '30/60', parcelas: [30, 60] },
      { id: '60', rotulo: '60 dias', parcelas: [60] },
      { id: '30_60_90', rotulo: '30/60/90', parcelas: [30, 60, 90] },
    ],
    condicoesAcimaDeValor: {
      valorMinimo: 15000,
      condicoes: [
        { id: '60_90', rotulo: '60/90', parcelas: [60, 90] },
        { id: '90', rotulo: '90 dias', parcelas: [90] },
        { id: '60_90_120', rotulo: '60/90/120', parcelas: [60, 90, 120] },
      ],
    },
    // Sem acréscimo de preço por prazo — diferente da Maxprint, o prazo aqui
    // só muda a condição, não o valor.
    aplicarAcrescimoPrazo: false,
    // A Samsonite não manda previsão de chegada, então item zerado precisa
    // continuar visível e marcado — senão some do catálogo (ver models/Marca.js).
    mostrarSemEstoque: true,
    subMarcas: [
      { nome: 'Samsonite', cor: '#0B6BB3' },
      { nome: 'American Tourister', cor: '#F5891F' },
      { nome: 'Xtrem', cor: '#7A3EA8' },
      { nome: 'Sammies by Samsonite', cor: '#0B6BB3' },
      { nome: 'Samsonite Red', cor: '#C8102E' },
    ],
  },
];

async function seedMarcas() {
  const conectouAqui = mongoose.connection.readyState === 0;
  if (conectouAqui) await mongoose.connect(MONGO);

  const resultado = [];
  for (const dados of MARCAS) {
    const existente = await Marca.findOne({ slug: dados.slug });
    if (existente) {
      resultado.push({ slug: dados.slug, acao: 'já existia, não mexi' });
      continue;
    }
    await Marca.create(dados);
    resultado.push({ slug: dados.slug, acao: 'criada' });
  }

  if (conectouAqui) await mongoose.disconnect();
  return resultado;
}

if (require.main === module) {
  seedMarcas()
    .then((r) => {
      console.log('== Marcas ==');
      r.forEach((x) => console.log(` ${x.slug}: ${x.acao}`));
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { seedMarcas, MARCAS };
