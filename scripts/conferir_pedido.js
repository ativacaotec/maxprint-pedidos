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

  /* ---------------- 4b. Buracos do envio de pedido --------------------- */
  // Cada checagem aqui guarda um jeito de furar a validação do servidor que
  // existia de verdade. A tela nunca produz nenhum destes casos — todos entram
  // por POST direto, que é justamente o que a trava do servidor existe para
  // barrar ("o navegador pode ser contornado", diz o comentário da rota).
  console.log('\nO que o servidor precisa recusar:');

  const enviar = (corpo) => cliente('/api/pedidos', { method: 'POST', body: JSON.stringify(corpo) });
  const base = { marca: 'maxprint', condicao: '30', cabecalho };

  // 70000119 tem 120 em estoque. Duas linhas de 100 somam 200.
  const repetido = await enviar({ ...base, itens: [
    { codigo: '70000119', quantidade: 100 }, { codigo: '70000119', quantidade: 100 },
  ] });
  conferir('duas linhas do mesmo código somam antes de conferir o saldo',
    repetido.status === 422, `${repetido.status} ${JSON.stringify(repetido.corpo.recusados || repetido.corpo.erro || '').slice(0, 90)}`);

  const inexistente = await enviar({ ...base, itens: [
    { codigo: '70000119', quantidade: 100 }, { codigo: 'NAO-EXISTE-99', quantidade: 5 },
  ] });
  conferir('item que sumiu do catálogo é recusado, não descartado calado',
    inexistente.status === 422
      && JSON.stringify(inexistente.corpo.recusados || []).includes('NAO-EXISTE-99'),
    `${inexistente.status} ${JSON.stringify(inexistente.corpo).slice(0, 110)}`);

  const quantidadeTorta = await enviar({ ...base, itens: [{ codigo: '70000119', quantidade: '12,5' }] });
  conferir('quantidade que não é número não vira pedido com total NaN',
    quantidadeTorta.status !== 200, `${quantidadeTorta.status} total=${quantidadeTorta.corpo.total}`);

  const condicaoTorta = await enviar({ ...base, condicao: 'parcelado', itens: [{ codigo: '70000119', quantidade: 100 }] });
  conferir('condição de pagamento inventada dá recado, não erro 500',
    condicaoTorta.status === 400, `${condicaoTorta.status} ${condicaoTorta.corpo.erro || ''}`);

  // Samsonite: mínimo R$ 3.500, CIF só a partir de R$ 5.000.
  const freteForjado = await cliente('/api/pedidos', {
    method: 'POST',
    body: JSON.stringify({
      marca: 'samsonite', condicao: '30',
      cabecalho: { ...cabecalho, frete: 'CIF' },
      itens: [{ codigo: '146203D1101', quantidade: 4 }],
    }),
  });
  conferir('cliente não consegue escrever CIF num pedido abaixo do valor',
    freteForjado.status === 200 && freteForjado.corpo.frete !== 'CIF',
    `${freteForjado.status} frete=${freteForjado.corpo.frete} total=${freteForjado.corpo.total}`);

  // Endereço com letra onde devia ter número derrubava o processo inteiro.
  const enderecoTorto = await cliente('/api/pedidos/abc');
  conferir('endereço inválido responde 400 em vez de derrubar o servidor',
    enderecoTorto.status === 400, String(enderecoTorto.status));
  const aindaDePe = await cliente('/api/pedidos?limite=200');
  conferir('e o servidor continua de pé depois disso', aindaDePe.status === 200, String(aindaDePe.status));

  // Operador do Mongo entrando por query string.
  const operador = await cliente('/api/pedidos?status[$ne]=x');
  conferir('operador do Mongo na query string não passa',
    operador.status === 200 && Array.isArray(operador.corpo),
    `${operador.status} ${typeof operador.corpo}`);

  // O desconto do cliente é o que o sistema mais promete esconder dele.
  const previa = await cliente('/api/pedidos/previa', {
    method: 'POST',
    body: JSON.stringify({ ...base, itens: [{ codigo: '70000119', quantidade: 100 }] }),
  });
  conferir('a prévia não devolve o desconto do cliente',
    previa.status === 200 && previa.corpo.descontoCliente === undefined,
    JSON.stringify(previa.corpo.descontoCliente));
  conferir('nem o preço de tabela, de onde a margem sai por subtração',
    previa.status === 200 && (previa.corpo.itens || []).every((i) => i.precoTabela === undefined),
    JSON.stringify((previa.corpo.itens || [])[0] || {}).slice(0, 120));

  /* ---------------- 4c. Yin's: tarja e unidade de venda ---------------- */
  // Nenhum arranjo de teste fechava pedido da Yin's, que é a marca onde o
  // número sozinho engana: item vendido em embalagem de 12, quem digita 24 e
  // é atendido em peça recebe 24 no lugar de 288.
  console.log("\nYin's · tarja e unidade de venda:");
  const yin = criarCliente();
  await yin('/api/auth/login', { method: 'POST', body: JSON.stringify({ usuario: 'yinsteste', senha: 'teste123' }) });

  const zerado = await yin('/api/pedidos', {
    method: 'POST',
    body: JSON.stringify({ marca: 'yins', condicao: '30', cabecalho, itens: [{ codigo: 'Y-1003', quantidade: 5 }] }),
  });
  conferir('item ZERADO da Yin\'s não vira pedido', zerado.status === 422, String(zerado.status));

  const abaixoDoMinimoItem = await yin('/api/pedidos', {
    method: 'POST',
    body: JSON.stringify({ marca: 'yins', condicao: '30', cabecalho, itens: [{ codigo: 'Y-1001', quantidade: 12 }] }),
  });
  conferir('o mínimo por item do catálogo é respeitado (pediu 12, mínimo 24)',
    abaixoDoMinimoItem.status === 422, `${abaixoDoMinimoItem.status} ${JSON.stringify(abaixoDoMinimoItem.corpo.recusados || '').slice(0, 80)}`);

  const pedidoYins = await yin('/api/pedidos', {
    method: 'POST',
    body: JSON.stringify({
      marca: 'yins', condicao: '30', cabecalho,
      itens: [{ codigo: 'Y-1001', quantidade: 2400 }, { codigo: 'Y-1002', quantidade: 100 }],
    }),
  });
  conferir('pedido Yin\'s com item REGULAR e REDUZIDO é aceito',
    pedidoYins.status === 200, `${pedidoYins.status} ${pedidoYins.corpo.erro || JSON.stringify(pedidoYins.corpo.recusados || '')}`);

  if (pedidoYins.status === 200) {
    const gravado = await yin('/api/pedidos/' + pedidoYins.corpo.numero);
    const linhaRegular = (gravado.corpo.itens || []).find((i) => i.codigo === 'Y-1001');
    const linhaReduzida = (gravado.corpo.itens || []).find((i) => i.codigo === 'Y-1002');
    conferir('a unidade de venda vai gravada no item do pedido',
      linhaRegular && linhaRegular.unidadeVenda === 'embalagem de 12 peças',
      JSON.stringify(linhaRegular && linhaRegular.unidadeVenda));
    conferir('a tarja do estoque também',
      linhaReduzida && linhaReduzida.situacaoEstoque === 'REDUZIDO',
      JSON.stringify(linhaReduzida && linhaReduzida.situacaoEstoque));

    const somaItens = (gravado.corpo.itens || []).reduce((a, i) => a + Number(i.total || 0), 0);
    conferir('a soma das linhas bate com o total do pedido',
      Math.abs(somaItens - gravado.corpo.total) < 0.01,
      `soma=${somaItens} total=${gravado.corpo.total}`);

    const pdf = await yin('/api/pedidos/' + pedidoYins.corpo.numero + '/pdf');
    conferir('o PDF do pedido Yin\'s sai sem erro', pdf.status === 200, String(pdf.status));
    const excel = await yin('/api/pedidos/' + pedidoYins.corpo.numero + '/excel');
    conferir('e o Excel também', excel.status === 200, String(excel.status));
  }

  /* ---------------- 4d. A sessão precisa envelhecer -------------------- */
  // Antes, a sessão era um retrato do login e valia 12 horas: desligar alguém
  // não fechava a aba que ele já tinha aberta, e tirar uma marca de um cliente
  // não tirava o catálogo dela da tela.
  console.log('\nA sessão acompanha o cadastro:');
  const admin = criarCliente();
  await admin('/api/auth/login', { method: 'POST', body: JSON.stringify({ usuario: 'marcelo', senha: 'teste123' }) });

  const cobaia = criarCliente();
  await cobaia('/api/auth/login', { method: 'POST', body: JSON.stringify({ usuario: 'descartavel', senha: 'teste123' }) });
  const antesDeMexer = await cobaia('/api/catalogo?marca=maxprint');
  conferir('o cliente entra e vê o catálogo dele', antesDeMexer.status === 200, String(antesDeMexer.status));

  const listaUsuarios = await admin('/api/admin/usuarios?perfil=cliente');
  const oDescartavel = (listaUsuarios.corpo || []).find((u) => u.usuario === 'descartavel');
  conferir('o admin acha o cliente na lista', !!oDescartavel, JSON.stringify(listaUsuarios.corpo || '').slice(0, 80));

  if (oDescartavel) {
    await admin('/api/admin/usuarios/' + oDescartavel._id, {
      method: 'PATCH', body: JSON.stringify({ catalogoStatus: 'travado' }),
    });
    const depois = await cobaia('/api/catalogo?marca=maxprint');
    conferir('travar o catálogo vale na sessão que já estava aberta',
      depois.status === 423, String(depois.status));
    const pedidoBloqueado = await cobaia('/api/pedidos/previa', {
      method: 'POST',
      body: JSON.stringify({ marca: 'maxprint', condicao: '30', cabecalho, itens: [{ codigo: '70000119', quantidade: 100 }] }),
    });
    conferir('e a prévia de preço também fica fechada',
      pedidoBloqueado.status === 423, String(pedidoBloqueado.status));

    await admin('/api/admin/usuarios/' + oDescartavel._id, {
      method: 'PATCH', body: JSON.stringify({ ativo: false }),
    });
    const desligado = await cobaia('/api/pedidos');
    conferir('desativar o usuário encerra a sessão dele na hora',
      desligado.status === 401, String(desligado.status));
  }

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
