'use strict';

/**
 * Dados de exemplo das duas marcas, usados pelos testes.
 *
 * Fica separado do servidor_de_teste.js porque mais de um teste precisa da
 * mesma base: o que abre as telas no navegador e o que fecha pedidos pela
 * API. Duas cópias divergiriam na primeira vez que eu mexesse em uma só.
 *
 * Precisa do mongo_falso já instalado ANTES de ser carregado.
 */

const bcrypt = require('bcryptjs');

const Usuario = require('../models/Usuario');
const Produto = require('../models/Produto');
const Marca = require('../models/Marca');
const Config = require('../models/Config');
const Pedido = require('../models/Pedido');
const { MARCAS } = require('./seed_marcas');

async function semear() {
  for (const m of MARCAS) await Marca.create(m);
  await Config.create({ chave: 'geral' });

  await Usuario.create({
    nome: 'Marcelo', usuario: 'marcelo', senhaHash: bcrypt.hashSync('teste123', 10),
    perfil: 'admin', catalogoStatus: 'live', marcasPermitidas: ['maxprint', 'samsonite'],
  });
  await Usuario.create({
    nome: 'Cliente de Teste', usuario: 'cliente', senhaHash: bcrypt.hashSync('teste123', 10),
    perfil: 'cliente', catalogoStatus: 'live', desconto: 0.12,
    marcasPermitidas: ['maxprint', 'samsonite'],
    razaoSocial: 'Papelaria Teste LTDA', cnpj: '12.345.678/0001-90',
    endereco: 'Rua de Teste, 100', telefone: '(11) 90000-0000',
    vendedor: 'Marcelo', transportadora: 'Transportadora Teste',
  });
  await Usuario.create({
    nome: 'Cliente Só Maxprint', usuario: 'sominha', senhaHash: bcrypt.hashSync('teste123', 10),
    perfil: 'cliente', catalogoStatus: 'live', desconto: 0.1, marcasPermitidas: ['maxprint'],
  });
  // Existe só para o teste de troca de senha ter em quem mexer. Sem ele, o
  // teste trocava a senha de um cliente que os testes seguintes usam para
  // entrar — e derrubava a si mesmo.
  await Usuario.create({
    nome: 'ZZ Cliente Descartavel', usuario: 'descartavel', senhaHash: bcrypt.hashSync('teste123', 10),
    perfil: 'cliente', catalogoStatus: 'live', desconto: 0, marcasPermitidas: ['maxprint'],
  });

  /* ---- produtos Maxprint ---- */
  const maxprint = [
    ['70000119', 'MOUSE SEM FIO M110 PRETO', 'Periféricos', 44.06, 120, ['70000119', '70000120']],
    ['70000120', 'MOUSE SEM FIO M110 CINZA', 'Periféricos', 44.06, 80, ['70000119', '70000120']],
    ['65000006', 'FONE TWS BLUETOOTH COM ANC FBT PRETO', 'Áudio', 251.09, 30, []],
    ['74000009', 'TECLADO MULTIMÍDIA SLIM', 'Periféricos', 89.9, 0, []],
  ];
  for (const [codigo, nome, categoria, preco, estoque, grupo] of maxprint) {
    await Produto.create({
      marcaSlug: 'maxprint', codigo, codigoOriginal: codigo, nome, categoria,
      linhaProduto: categoria, precoBase: preco, estoque,
      previstoTotal: estoque === 0 ? 50 : 0,
      chegadas: estoque === 0 ? [{ mes: '2026-09', rotulo: 'set/26', quantidade: 50 }] : [],
      status: 'ATIVO', grupoCores: grupo, ativo: true, imagem: '', curvaA: estoque > 100,
    });
  }

  /* ---- produtos Samsonite: uma linha com 3 cores, para testar o card ---- */
  // O saldo do preto é alto de propósito: é com ele que o teste confere a
  // liberação dos prazos longos acima de R$ 15.000 — com saldo baixo o
  // pedido seria recusado por estoque antes de chegar nesse valor.
  const bahia = [
    ['146203D1101', 'BAHIA LITE SPINNER 55 EXP', 'BLACK', 1099.9, 40],
    ['146203D1102', 'BAHIA LITE SPINNER 55 EXP', 'NAVY BLUE', 1099.9, 3],
    ['146203D1103', 'BAHIA LITE SPINNER 55 EXP', 'WINE RED', 1099.9, 0],
  ];
  const codigosBahia = bahia.map((b) => b[0]);
  for (const [codigo, nome, cor, preco, estoque] of bahia) {
    await Produto.create({
      marcaSlug: 'samsonite', codigo, codigoOriginal: `${codigo}  U`, nome: `${nome}`,
      categoria: 'Samsonite', subMarca: 'Samsonite', grupo: 'BAHIA LITE',
      tipoProduto: 'SPINNER 55 EXP', cor, precoBase: preco, precoCheio: preco,
      estoque, previstoTotal: estoque === 0 ? 12 : 0,
      status: estoque > 0 ? 'DISPONIVEL' : 'SEM SALDO',
      grupoCores: codigosBahia, ativo: true, imagem: '',
    });
  }

  // Item zerado E sem previsão: é o caso que a regra antiga apagava do
  // catálogo. Serve para o teste conferir que ele aparece marcado.
  await Produto.create({
    marcaSlug: 'samsonite', codigo: '99999900001', codigoOriginal: '99999900001  U',
    nome: 'ZERADO SPINNER 55', categoria: 'Samsonite', subMarca: 'Samsonite',
    grupo: 'ZERADO', tipoProduto: 'SPINNER 55', cor: 'BLACK',
    precoBase: 500, precoCheio: 500, estoque: 0, previstoTotal: 0,
    status: 'SEM SALDO', grupoCores: [], ativo: true, imagem: '',
  });

  const outros = [
    ['15507810411', 'XTREM CONVERTIBLE BACKPACK', 'Xtrem', 'Xtrem', 'GREY MELANGE', 349.9, 25, true, 30],
    ['15512905771', 'ASPEN SPINNER 57 EXP', 'American Tourister', 'American Tourister', 'DEEP BLACK', 799.9, 14, false, 0],
    ['15512910411', 'ASPEN SPINNER 77 EXP', 'American Tourister', 'American Tourister', 'RACING RED', 949.9, 6, true, 40],
  ];
  for (const [codigo, nome, cat, sub, cor, preco, estoque, promo, desc] of outros) {
    await Produto.create({
      marcaSlug: 'samsonite', codigo, codigoOriginal: `${codigo}  U`, nome,
      categoria: cat, subMarca: sub, grupo: nome.split(' ')[0], tipoProduto: nome,
      cor, precoBase: preco, precoCheio: promo ? Math.round(preco / (1 - desc / 100)) : preco,
      emPromocao: promo, descontoPromo: desc, estoque, status: 'DISPONIVEL',
      grupoCores: [], ativo: true, imagem: '',
    });
  }

  await Pedido.create({
    marcaSlug: 'maxprint', numero: 1001, clienteUsuario: 'cliente',
    razaoSocial: 'Papelaria Teste LTDA', cnpj: '12.345.678/0001-90',
    condicao: '30', condicaoRotulo: '30 dias', frete: 'CIF', status: 'novo',
    itens: [{ codigo: '70000119', nome: 'MOUSE SEM FIO M110 PRETO', quantidade: 100,
              natureza: 'pronta', precoTabela: 44.06, precoUnitario: 38.77, total: 3877 }],
    totalPronta: 3877, total: 3877, pecas: 100, avisoEnviado: true,
  });

  console.log('Dados de exemplo criados.');
}


module.exports = semear;
