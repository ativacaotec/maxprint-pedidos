'use strict';

/**
 * Teste de ponta a ponta, com banco de verdade.
 *
 * Sobe o servidor num banco separado (…_teste), cria um admin e um cliente,
 * faz login como cliente, monta um carrinho, testa a trava de estoque, a trava
 * de pedido mínimo, o aviso de frete CIF, o recálculo por prazo, o envio do
 * pedido e o download do Excel e do PDF. No fim, apaga o banco de teste.
 *
 *   npm run teste
 *
 * Precisa de MongoDB rodando na máquina. É o teste para rodar no VPS depois de
 * instalar, antes de liberar o primeiro cliente.
 */

process.env.MONGO_URL = process.env.MONGO_TESTE || 'mongodb://127.0.0.1:27017/maxprint_pedidos_teste';
process.env.SESSION_SECRET = 'teste-teste-teste';
process.env.PORT = process.env.PORT_TESTE || '3999';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const Usuario = require('../models/Usuario');
const Produto = require('../models/Produto');
const Pedido = require('../models/Pedido');
const Config = require('../models/Config');
const { app } = require('../server');

let falhas = 0;
const base = `http://127.0.0.1:${process.env.PORT}`;
let cookie = '';

function conferir(descricao, condicao, detalhe = '') {
  const ok = Boolean(condicao);
  if (!ok) falhas++;
  console.log(`  ${ok ? '✓' : '✗'} ${descricao}${detalhe ? '  ' + detalhe : ''}`);
}

async function chamar(caminho, opcoes = {}) {
  const r = await fetch(base + caminho, {
    ...opcoes,
    headers: { 'content-type': 'application/json', ...(opcoes.headers || {}), ...(cookie ? { cookie } : {}) },
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const tipo = r.headers.get('content-type') || '';
  const corpo = tipo.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, corpo };
}

(async () => {
  await mongoose.connect(process.env.MONGO_URL);
  await mongoose.connection.dropDatabase();

  const servidor = app.listen(Number(process.env.PORT));
  await new Promise((r) => servidor.once('listening', r));

  try {
    console.log('\n== preparação ==');
    await Config.carregar();

    await Usuario.create({
      nome: 'Admin Teste', usuario: 'admin', perfil: 'admin',
      senhaHash: bcrypt.hashSync('teste123', 10),
    });
    const cliente = await Usuario.create({
      nome: 'Cliente Teste', usuario: 'cliente', perfil: 'cliente',
      senhaHash: bcrypt.hashSync('teste123', 10),
      desconto: 0.1, catalogoStatus: 'travado',
      razaoSocial: 'Cliente Teste Ltda', cnpj: '00.000.000/0001-00',
      endereco: 'Rua Teste, 1', transportadora: 'Transp Teste', vendedor: 'Marcelo',
    });

    await Produto.create([
      {
        codigo: 'T100', codigoOriginal: 'T 100', nome: 'Produto com saldo',
        categoria: 'PAPELARIA', linhaProduto: 'CANETA', precoBase: 100,
        estoque: 50, status: 'ATIVO', imagem: '',
      },
      {
        codigo: 'T200', codigoOriginal: 'T 200', nome: 'Produto caro',
        categoria: 'PAPELARIA', linhaProduto: 'CANETA', precoBase: 1000,
        estoque: 20, status: 'ATIVO',
      },
      {
        codigo: 'T300', codigoOriginal: 'T 300', nome: 'Produto só programado',
        categoria: 'INFORMÁTICA', linhaProduto: 'MOUSE', precoBase: 200,
        estoque: 0, previstoTotal: 30, status: 'ATIVO',
        chegadas: [{ mes: 8, rotulo: 'AGO', quantidade: 30 }],
      },
    ]);
    console.log('  · banco de teste preparado');

    console.log('\n== login e parede do cliente ==');
    let r = await chamar('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ usuario: 'cliente', senha: 'errada' }),
    });
    conferir('senha errada é recusada', r.status === 401);

    r = await chamar('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ usuario: 'cliente', senha: 'teste123' }),
    });
    conferir('cliente entra', r.status === 200 && r.corpo.destino === '/catalogo');

    r = await chamar('/api/catalogo');
    conferir('catálogo travado barra o cliente', r.status === 423);

    r = await chamar('/api/admin/usuarios');
    conferir('cliente não alcança o painel', r.status === 403);

    await Usuario.updateOne({ _id: cliente._id }, { catalogoStatus: 'live' });
    r = await chamar('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ usuario: 'cliente', senha: 'teste123' }),
    });
    r = await chamar('/api/catalogo?condicao=30');
    conferir('catálogo liberado responde', r.status === 200 && r.corpo.produtos.length === 3);

    console.log('\n== preço, desconto e prazo ==');
    const t100 = r.corpo.produtos.find((p) => p.codigo === 'T100');
    conferir('preço sai com o desconto do cliente aplicado', t100.preco === 90, `(deu ${t100.preco})`);
    conferir('o desconto do cliente NÃO vaza para o navegador',
      !JSON.stringify(r.corpo).includes('"desconto"'));

    const r60 = await chamar('/api/catalogo?condicao=60');
    const t100_60 = r60.corpo.produtos.find((p) => p.codigo === 'T100');
    conferir('em 60 dias o preço sobe 2%', t100_60.preco === 91.8, `(deu ${t100_60.preco})`);

    const r45 = await chamar('/api/catalogo?condicao=30_60');
    const t100_45 = r45.corpo.produtos.find((p) => p.codigo === 'T100');
    conferir('em 30/60 o preço sobe 1%', t100_45.preco === 90.9, `(deu ${t100_45.preco})`);

    console.log('\n== carrinho, trava de estoque e mínimo ==');
    r = await chamar('/api/pedidos/previa', {
      method: 'POST',
      body: JSON.stringify({ itens: [{ codigo: 'T100', quantidade: 999 }], condicao: '30' }),
    });
    conferir('quantidade acima do saldo é recusada',
      r.corpo.recusados && r.corpo.recusados.length === 1,
      r.corpo.recusados?.[0] ? `(limite ${r.corpo.recusados[0].limite})` : '');

    r = await chamar('/api/pedidos/previa', {
      method: 'POST',
      body: JSON.stringify({ itens: [{ codigo: 'T300', quantidade: 40 }], condicao: '30' }),
    });
    conferir('programado é limitado à previsão de chegada',
      r.corpo.recusados?.length === 1 && r.corpo.recusados[0].limite === 30);

    r = await chamar('/api/pedidos/previa', {
      method: 'POST',
      body: JSON.stringify({ itens: [{ codigo: 'T100', quantidade: 10 }], condicao: '30' }),
    });
    conferir('abaixo do mínimo o pedido não libera',
      r.corpo.atingiuMinimo === false && r.corpo.freteCif === false,
      `(total ${r.corpo.total})`);

    r = await chamar('/api/pedidos', {
      method: 'POST',
      body: JSON.stringify({ itens: [{ codigo: 'T100', quantidade: 10 }], condicao: '30', cabecalho: {} }),
    });
    conferir('envio abaixo do mínimo é bloqueado no servidor', r.status === 422);

    const carrinho = [{ codigo: 'T100', quantidade: 20 }, { codigo: 'T200', quantidade: 3 }, { codigo: 'T300', quantidade: 5 }];
    r = await chamar('/api/pedidos/previa', {
      method: 'POST', body: JSON.stringify({ itens: carrinho, condicao: '30' }),
    });
    conferir('acima de R$ 3.000 aciona o frete CIF', r.corpo.freteCif === true, `(total ${r.corpo.total})`);
    conferir('pronta entrega e programado somam separados',
      r.corpo.totalPronta > 0 && r.corpo.totalProgramado > 0,
      `(pronta ${r.corpo.totalPronta} · programado ${r.corpo.totalProgramado})`);

    console.log('\n== prazo fora da regra ==');
    r = await chamar('/api/pedidos/previa', {
      method: 'POST', body: JSON.stringify({ itens: carrinho, condicao: '30/60/90/120' }),
    });
    conferir('prazo médio acima de 60 dias abre negociação', r.status === 422 && r.corpo.negociar === true);

    console.log('\n== envio e saídas ==');
    r = await chamar('/api/pedidos', {
      method: 'POST',
      body: JSON.stringify({
        itens: carrinho, condicao: '30_60',
        cabecalho: {
          razaoSocial: 'Cliente Teste Ltda', cnpj: '00.000.000/0001-00',
          endereco: 'Rua Teste, 1', transportadora: 'Transp Teste', vendedor: 'Marcelo',
        },
      }),
    });
    conferir('pedido enviado', r.status === 200 && r.corpo.numero > 0, `(nº ${r.corpo.numero})`);
    const numero = r.corpo.numero;

    const gravado = await Pedido.findOne({ numero }).lean();
    conferir('frete gravado como CIF', gravado.frete === 'CIF');
    conferir('acréscimo de 1% gravado no pedido', Math.abs(gravado.acrescimoPrazo - 0.01) < 1e-9);
    conferir('preço de cada linha ficou congelado no pedido',
      gravado.itens.every((i) => i.precoUnitario > 0 && i.precoTabela > 0));

    r = await chamar(`/api/pedidos/${numero}/excel`);
    conferir('Excel do pedido baixa', r.status === 200 && r.corpo.length > 3000,
      `(${Math.round(r.corpo.length / 1024)} KB)`);

    r = await chamar(`/api/pedidos/${numero}/pdf`);
    conferir('PDF do pedido baixa', r.status === 200 && r.corpo.length > 1000,
      `(${Math.round(r.corpo.length / 1024)} KB)`);

    console.log('\n== escopo: um cliente não vê o do outro ==');
    const outro = await Usuario.create({
      nome: 'Outro', usuario: 'outro', perfil: 'cliente',
      senhaHash: bcrypt.hashSync('teste123', 10), catalogoStatus: 'live',
    });
    cookie = '';
    await chamar('/api/auth/login', { method: 'POST', body: JSON.stringify({ usuario: 'outro', senha: 'teste123' }) });
    r = await chamar('/api/pedidos');
    conferir('outro cliente não enxerga o pedido alheio', Array.isArray(r.corpo) && r.corpo.length === 0);
    r = await chamar(`/api/pedidos/${numero}`);
    conferir('nem abrindo pelo número', r.status === 404);

    console.log('\n== painel ==');
    cookie = '';
    await chamar('/api/auth/login', { method: 'POST', body: JSON.stringify({ usuario: 'admin', senha: 'teste123' }) });
    r = await chamar('/api/admin/resumo');
    conferir('painel mostra o pedido novo', r.corpo.pedidos.novos === 1);

    r = await chamar(`/api/pedidos/${numero}`, {
      method: 'PATCH', body: JSON.stringify({ status: 'digitado' }),
    });
    conferir('admin muda o status', r.corpo.status === 'digitado');

    r = await chamar('/api/admin/usuarios', {
      method: 'POST',
      body: JSON.stringify({ nome: 'Novo Cliente', usuario: 'novocliente', perfil: 'cliente', desconto: 0.15 }),
    });
    conferir('admin cria cliente e recebe a senha uma vez',
      r.status === 200 && typeof r.corpo.senha === 'string' && r.corpo.senha.length >= 6);

    await Usuario.deleteOne({ _id: outro._id });
  } catch (e) {
    console.error('\nERRO NO TESTE:', e);
    falhas++;
  } finally {
    servidor.close();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }

  console.log(`\n${falhas === 0 ? 'Tudo passou.' : falhas + ' verificação(ões) falharam.'}\n`);
  process.exit(falhas === 0 ? 0 : 1);
})();
