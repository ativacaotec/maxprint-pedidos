'use strict';

/**
 * Fecha um pedido de VERDADE de cada marca, pela API, e confere o que
 * importa: valor certo, marca certa, regra de prazo respeitada e aviso por
 * e-mail disparado — que foi o pedido explícito do Marcelo para a Samsonite.
 *
 * O envio de e-mail é interceptado (não sai e-mail nenhum); o que se confere
 * é que o sistema TENTOU enviar, para quem, e com qual assunto.
 */

require('./mongo_falso').instalar();

const Module = require('module');
const requireOriginal = Module.prototype.require;

// Guardo o que o sistema tentou enviar, em vez de deixar sair de verdade.
const enviados = [];
Module.prototype.require = function interceptar(nome) {
  if (nome === 'connect-mongo') return { create: () => undefined };
  return requireOriginal.apply(this, arguments);
};

const email = requireOriginal.call(module, '../lib/email');
const enviarDeVerdade = email.enviarAvisoPedido;
email.enviarAvisoPedido = async (pedido, destinatarios, url, nomeMarca) => {
  enviados.push({ numero: pedido.numero, total: pedido.total, destinatarios, nomeMarca });
  return { enviado: true };
};

process.env.PORT = '3998';
process.env.HOST = '127.0.0.1';

const BASE = 'http://127.0.0.1:3998';
const resultados = [];

function conferir(oQue, passou, detalhe) {
  resultados.push({ oQue, passou, detalhe });
  console.log(`  ${passou ? '✓' : '✗'} ${oQue}${!passou && detalhe ? '  → ' + detalhe : ''}`);
}

/** Cliente HTTP que guarda o cookie de sessão entre as chamadas. */
function criarCliente() {
  let cookie = '';
  return async function chamar(caminho, opcoes = {}) {
    const r = await fetch(BASE + caminho, {
      ...opcoes,
      headers: { 'content-type': 'application/json', ...(opcoes.headers || {}), ...(cookie ? { cookie } : {}) },
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const corpo = await r.json().catch(() => ({}));
    return { status: r.status, corpo };
  };
}

(async () => {
  // O servidor_de_teste já semeia as marcas, clientes e produtos.
  const semear = requireOriginal.call(module, './semente_de_teste');
  await semear();

  const { iniciar } = requireOriginal.call(module, '../server');
  require('./mongo_falso').fingirConectado();
  await iniciar();

  const cliente = criarCliente();
  await cliente('/api/auth/login', { method: 'POST', body: JSON.stringify({ usuario: 'cliente', senha: 'teste123' }) });

  const cabecalho = {
    razaoSocial: 'Papelaria Teste LTDA', cnpj: '12.345.678/0001-90',
    endereco: 'Rua de Teste, 100', transportadora: 'Transportadora Teste',
    vendedor: 'Marcelo', telefone: '(11) 90000-0000', email: 'teste@teste.com',
  };

  /* ---------------- 1. Samsonite: prazo longo bloqueado ---------------- */
  console.log('\nSamsonite · prazo longo em pedido pequeno:');
  const pequeno = await cliente('/api/pedidos', {
    method: 'POST',
    body: JSON.stringify({
      marca: 'samsonite', condicao: '60_90', cabecalho,
      itens: [{ codigo: '146203D1101', quantidade: 2 }],
    }),
  });
  conferir('o servidor recusa 60/90 abaixo de R$ 15.000',
    pequeno.status === 422 && /15\.000/.test(pequeno.corpo.erro || ''),
    `${pequeno.status} ${pequeno.corpo.erro}`);

  /* ------------- 1b. Samsonite: pedido mínimo de R$ 3.500 -------------- */
  // Dois patamares diferentes e fáceis de confundir: o pedido FECHA a partir
  // de R$ 3.500, e o frete vira CIF a partir de R$ 5.000. Um pedido entre os
  // dois valores tem que passar, e sair como FOB.
  console.log('\nSamsonite · pedido mínimo de R$ 3.500:');
  const abaixoDoMinimo = await cliente('/api/pedidos', {
    method: 'POST',
    body: JSON.stringify({
      marca: 'samsonite', condicao: '30', cabecalho,
      itens: [{ codigo: '146203D1101', quantidade: 3 }],   // 3 × 967,91 = 2.903,73
    }),
  });
  conferir('abaixo de R$ 3.500 o pedido não fecha',
    abaixoDoMinimo.status === 422 && /3\.500/.test(abaixoDoMinimo.corpo.erro || ''),
    `${abaixoDoMinimo.status} ${abaixoDoMinimo.corpo.erro}`);

  const entreOsDois = await cliente('/api/pedidos', {
    method: 'POST',
    body: JSON.stringify({
      marca: 'samsonite', condicao: '30', cabecalho,
      itens: [{ codigo: '146203D1101', quantidade: 4 }],   // 4 × 967,91 = 3.871,64
    }),
  });
  conferir('acima de R$ 3.500 o pedido fecha', entreOsDois.status === 200,
    `${entreOsDois.status} ${entreOsDois.corpo.erro || ''}`);

  if (entreOsDois.status === 200) {
    const meio = await cliente('/api/pedidos/' + entreOsDois.corpo.numero);
    conferir('e entre R$ 3.500 e R$ 5.000 o frete ainda é FOB',
      meio.corpo.frete === 'FOB', 'frete=' + meio.corpo.frete);
  }

  /* ---------------- 2. Samsonite: pedido válido ------------------------ */
  console.log('\nSamsonite · pedido de verdade:');
  const antes = enviados.length;
  const grande = await cliente('/api/pedidos', {
    method: 'POST',
    body: JSON.stringify({
      marca: 'samsonite', condicao: '60_90', cabecalho,
      itens: [{ codigo: '146203D1101', quantidade: 20 }],
    }),
  });
  conferir('o pedido é aceito acima de R$ 15.000', grande.status === 200,
    `${grande.status} ${grande.corpo.erro || ''}`);

  // O sistema arredonda o preço UNITÁRIO e só então multiplica pela
  // quantidade — de propósito: é o número que o cliente lê no card
  // (R$ 967,91) vezes o que ele digitou. Somar com centavos "escondidos" e
  // arredondar no fim daria um total que não fecha com a conta de cabeça
  // dele, e é justamente esse tipo de diferença que gera ligação.
  //   1.099,90 − 12% = 967,912 → 967,91 · × 20 = 19.358,20
  const pedidoSam = await cliente('/api/pedidos/' + grande.corpo.numero);
  conferir('o total sai com o desconto do cliente aplicado',
    Math.abs(pedidoSam.corpo.total - 19358.20) < 0.02, 'total=' + pedidoSam.corpo.total);
  conferir('o pedido fica gravado na marca certa',
    pedidoSam.corpo.marcaSlug === 'samsonite', pedidoSam.corpo.marcaSlug);
  conferir('a Samsonite NÃO cobra acréscimo por prazo',
    pedidoSam.corpo.acrescimoPrazo === 0, 'acrescimo=' + pedidoSam.corpo.acrescimoPrazo);
  conferir('o frete vira CIF acima de R$ 5.000',
    pedidoSam.corpo.frete === 'CIF', pedidoSam.corpo.frete);

  await new Promise((r) => setTimeout(r, 400)); // o aviso sai fora da resposta
  const avisoSam = enviados[antes];
  conferir('o aviso por e-mail do pedido Samsonite foi disparado', !!avisoSam);
  if (avisoSam) {
    conferir('e diz que é da Samsonite', avisoSam.nomeMarca === 'Samsonite', avisoSam.nomeMarca);
    conferir('e vai para os e-mails cadastrados',
      (avisoSam.destinatarios || []).length > 0, JSON.stringify(avisoSam.destinatarios));
  }

  /* ---------------- 3. Maxprint continua como era ---------------------- */
  console.log('\nMaxprint · nada mudou:');
  const max = await cliente('/api/pedidos', {
    method: 'POST',
    body: JSON.stringify({
      marca: 'maxprint', condicao: '30_60_90', cabecalho,
      itens: [{ codigo: '70000119', quantidade: 100 }],
    }),
  });
  conferir('o pedido Maxprint é aceito', max.status === 200, `${max.status} ${max.corpo.erro || ''}`);

  if (max.status === 200) {
    const pedidoMax = await cliente('/api/pedidos/' + max.corpo.numero);
    // 44,06 − 12% = 38,7728 · +2% do 30/60/90 = 39,548 → 39,55 · × 100 = 3.955,00
    conferir('a Maxprint AINDA cobra os 2% do prazo 30/60/90',
      Math.abs(pedidoMax.corpo.acrescimoPrazo - 0.02) < 0.0001,
      'acrescimo=' + pedidoMax.corpo.acrescimoPrazo);
    conferir('e o total bate com a conta antiga',
      Math.abs(pedidoMax.corpo.total - 3955.00) < 0.02, 'total=' + pedidoMax.corpo.total);
    conferir('o pedido fica na marca maxprint',
      pedidoMax.corpo.marcaSlug === 'maxprint', pedidoMax.corpo.marcaSlug);
  }

  /* ---------------- 4. Permissão de marca ------------------------------ */
  console.log('\nPermissão de marca:');
  const so = criarCliente();
  await so('/api/auth/login', { method: 'POST', body: JSON.stringify({ usuario: 'sominha', senha: 'teste123' }) });
  const invadir = await so('/api/catalogo?marca=samsonite');
  conferir('cliente sem a marca liberada não vê o catálogo dela',
    invadir.status === 403, String(invadir.status));
  const invadirPedido = await so('/api/pedidos', {
    method: 'POST',
    body: JSON.stringify({ marca: 'samsonite', condicao: '30', cabecalho, itens: [{ codigo: '146203D1101', quantidade: 1 }] }),
  });
  conferir('e também não consegue mandar pedido dela',
    invadirPedido.status === 403, String(invadirPedido.status));

  /* ---------------- 5. Excluir pedido ---------------------------------- */
  // O botão apaga de vez. O que estes testes guardam é o efeito colateral que
  // ninguém vê na hora: se o número do pedido apagado voltasse, dois pedidos
  // diferentes teriam o mesmo número — e o PDF do primeiro já saiu por e-mail.
  console.log('\nExcluir pedido:');
  const equipe = criarCliente();
  await equipe('/api/auth/login', { method: 'POST', body: JSON.stringify({ usuario: 'marcelo', senha: 'teste123' }) });

  const paraApagar = await cliente('/api/pedidos', {
    method: 'POST',
    body: JSON.stringify({
      marca: 'maxprint', condicao: '30', cabecalho,
      itens: [{ codigo: '70000119', quantidade: 100 }],
    }),
  });
  conferir('o pedido de teste foi criado', paraApagar.status === 200,
    `${paraApagar.status} ${paraApagar.corpo.erro || ''}`);
  const numeroApagado = paraApagar.corpo.numero;

  const semPermissao = await cliente('/api/pedidos/' + numeroApagado, { method: 'DELETE' });
  conferir('o cliente NÃO consegue excluir pedido',
    semPermissao.status === 403, String(semPermissao.status));

  const apagou = await equipe('/api/pedidos/' + numeroApagado, { method: 'DELETE' });
  conferir('a equipe exclui o pedido', apagou.status === 200,
    `${apagou.status} ${apagou.corpo.erro || ''}`);

  const sumiu = await equipe('/api/pedidos/' + numeroApagado);
  conferir('e ele some mesmo do banco', sumiu.status === 404, String(sumiu.status));

  const deNovo = await equipe('/api/pedidos/' + numeroApagado, { method: 'DELETE' });
  conferir('excluir o mesmo pedido duas vezes dá "não encontrado"',
    deNovo.status === 404, String(deNovo.status));

  const seguinte = await cliente('/api/pedidos', {
    method: 'POST',
    body: JSON.stringify({
      marca: 'maxprint', condicao: '30', cabecalho,
      itens: [{ codigo: '70000119', quantidade: 100 }],
    }),
  });
  conferir('o número do pedido excluído NÃO volta para o próximo',
    seguinte.status === 200 && seguinte.corpo.numero > numeroApagado,
    `apagado=${numeroApagado} proximo=${seguinte.corpo.numero}`);

  /* ------------------------------ fim ---------------------------------- */
  const falharam = resultados.filter((r) => !r.passou);
  console.log('\n===================== resultado =====================');
  console.log(`${resultados.length - falharam.length}/${resultados.length} checagens passaram`);
  falharam.forEach((r) => console.log(`  ✗ ${r.oQue}  → ${r.detalhe || ''}`));
  process.exit(falharam.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
