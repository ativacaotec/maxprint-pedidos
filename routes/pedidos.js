'use strict';

const express = require('express');
const Pedido = require('../models/Pedido');
const Produto = require('../models/Produto');
const Usuario = require('../models/Usuario');
const Config = require('../models/Config');
const { requireLogin, requireInterno, requireCliente } = require('../middleware/auth');
const { precoUnitario, fatorPrazo, interpretarCondicao, condicoesDisponiveis, regrasDaMarca } = require('../lib/prazo');
const { carregarMarca, podeAcessarMarca } = require('../lib/marcas');
const { gerarExcel } = require('../lib/gerarExcel');
const { gerarPdf } = require('../lib/gerarPdf');
const { enviarAvisoPedido } = require('../lib/email');

const router = express.Router();
router.use(requireLogin);
// A trava de catálogo travado valia só em /api/catalogo. Um cliente recém
// cadastrado — que nasce travado, "enquanto a base e o desconto estão sendo
// preparados" — recebia 423 no catálogo mas conseguia varrer a tabela de preço
// item a item pela prévia, e até mandar pedido de verdade, precificado com
// desconto zero porque o desconto ainda nem tinha sido configurado.
router.use(requireCliente);

/* ------------------------------------------------------------------ *
 * Montagem do pedido (usada tanto na prévia quanto no envio)
 * ------------------------------------------------------------------ */

/**
 * Desconto que vale para este pedido.
 *
 * Do cliente, vem da ficha dele e ponto. Da equipe, pode vir digitado — mas
 * preso na mesma faixa que o cadastro aceita (0 a 95%, `models/Usuario.js`).
 * Sem esse limite, `descontoManual: 1.5` gerava preço negativo, e o total
 * negativo passava pelo teste de pedido mínimo pelo lado errado.
 */
function descontoDoPedido(sessao, cliente, corpo) {
  if (sessao.perfil === 'cliente') return cliente?.desconto || 0;
  const pedido = Number(corpo.descontoManual || 0);
  if (!Number.isFinite(pedido)) return 0;
  return Math.min(0.95, Math.max(0, pedido));
}

async function montarPedido(sessao, corpo) {
  const config = await Config.carregar();
  const cliente = await Usuario.findById(sessao.id).lean();
  const ehCliente = sessao.perfil === 'cliente';
  const desconto = descontoDoPedido(sessao, cliente, corpo);

  const marcaSlug = String(corpo.marca || 'maxprint').toLowerCase();
  if (!podeAcessarMarca(sessao, marcaSlug)) {
    const erro = new Error('Você não tem acesso a essa marca.');
    erro.status = 403;
    throw erro;
  }
  const marca = await carregarMarca(marcaSlug);
  if (!marca || !marca.ativa) {
    const erro = new Error('Marca não encontrada ou desativada.');
    erro.status = 404;
    throw erro;
  }
  const regras = regrasDaMarca(marca);

  const cond = interpretarCondicao(corpo.condicao || '30', regras.condicoes);
  // "400", "parcelado", "/" — qualquer coisa que não vire parcela devolve
  // null. Sem esta guarda a linha que confere a condição liberada estourava em
  // `cond.id` e o cliente recebia 500 com a mensagem técnica do JavaScript.
  if (!cond) {
    const erro = new Error('Condição de pagamento não reconhecida. Escolha uma das condições do catálogo.');
    erro.status = 400;
    throw erro;
  }
  const info = fatorPrazo(cond, regras);
  if (info.negociar) {
    const erro = new Error(
      `Prazo médio de ${info.prazoMedio} dias passa do limite de ${regras.prazoMaximoDias}. ` +
      'Essa condição precisa ser negociada com o representante.'
    );
    erro.status = 422;
    erro.negociar = true;
    throw erro;
  }

  const linhas = Array.isArray(corpo.itens) ? corpo.itens : [];
  if (!linhas.length) {
    const erro = new Error('O carrinho está vazio.');
    erro.status = 400;
    throw erro;
  }

  // O MESMO recorte que o catálogo usa. Sem isto, item desativado pela
  // importação da madrugada, item sem preço e item de outlet escondido do
  // cliente continuavam entrando por POST direto: some do catálogo, mas o
  // pedido aceitava. Um item Yin's sem preço lido no PDF (precoBase 0) virava
  // 300 peças a R$ 0,00 no pedido da fábrica.
  const codigos = [...new Set(linhas.map((l) => String(l.codigo)))];
  const filtroProduto = { codigo: { $in: codigos }, marcaSlug, ativo: true, precoBase: { $gt: 0 } };
  if (ehCliente && cliente?.verOutlet === false) filtroProduto.outlet = { $ne: true };
  if (Array.isArray(config.statusBloqueados) && config.statusBloqueados.length) {
    filtroProduto.status = { $nin: config.statusBloqueados };
  }
  const produtos = await Produto.find(filtroProduto).lean();
  const mapa = new Map(produtos.map((p) => [p.codigo, p]));

  // Duas linhas do mesmo código somam ANTES de conferir o saldo. O laço antigo
  // media cada linha contra o saldo cheio: num item com 8 em estoque, duas
  // linhas de 5 passavam as duas e o pedido saía com 10.
  const somadas = new Map();
  for (const l of linhas) {
    const codigo = String(l.codigo);
    const bruto = Number(l.quantidade);
    // "12,5" e "abc" viram NaN, e NaN escapa de `<= 0`, de `> limite` e de
    // `< mínimo` — passava por todas as travas e gravava total NaN. Aqui vira
    // zero, e zero é recusado com aviso na tela.
    const qtd = Number.isFinite(bruto) && bruto > 0 ? Math.floor(bruto) : 0;
    somadas.set(codigo, (somadas.get(codigo) || 0) + qtd);
  }

  const itens = [];
  const recusados = [];
  let totalPronta = 0;
  let totalProgramado = 0;
  let pecas = 0;

  for (const [codigo, qtd] of somadas) {
    const p = mapa.get(codigo);

    // Item que sumiu do catálogo, ou quantidade que não é número: antes isso
    // era descartado em silêncio e o pedido fechava com `ok: true` faltando
    // linha — nem o cliente nem o Marcelo ficavam sabendo.
    if (!p) {
      recusados.push({
        codigo, nome: '', pedido: qtd, limite: 0,
        motivo: 'este item saiu do catálogo desde que você montou o carrinho',
      });
      continue;
    }
    if (qtd <= 0) {
      recusados.push({
        codigo: p.codigo, nome: p.nome, pedido: qtd, limite: 0,
        motivo: 'quantidade inválida',
      });
      continue;
    }

    // Marca que trabalha por TARJA (Yin's) não tem número de saldo para
    // comparar. O que existe é REGULAR / REDUZIDO / ZERADO / PRÉ-VENDA, e a
    // única recusa possível é o zerado. Se esta função continuasse exigindo
    // `estoque > 0`, o carrinho da Yin's recusaria todo item, porque lá o
    // estoque é 0 por definição.
    const porTarja = !!(marca && marca.saldoPorSituacao);
    const tarja = String(p.situacaoEstoque || '').toUpperCase();

    const disponivel = porTarja ? (tarja && tarja !== 'ZERADO') : p.estoque > 0;
    const natureza = porTarja
      ? (tarja === 'PRE-VENDA' ? 'programado' : 'pronta')
      : (disponivel ? 'pronta' : 'programado');
    const limite = porTarja
      ? (disponivel ? Infinity : 0)
      : (disponivel ? p.estoque : (p.previstoTotal || 0));

    // O bloqueio por saldo é aqui, no servidor. A trava da tela é conforto;
    // esta é a que vale, porque o navegador pode ser contornado.
    if (qtd > limite) {
      recusados.push({
        codigo: p.codigo,
        nome: p.nome,
        pedido: qtd,
        limite: limite === Infinity ? 0 : limite,
        motivo: porTarja
          ? `item ${tarja ? tarja.toLowerCase() : 'sem situação'} no catálogo da fábrica`
          : (disponivel ? 'quantidade acima do saldo disponível' : 'quantidade acima da chegada prevista'),
      });
      continue;
    }

    // Mínimo por item, escrito na ficha do catálogo ("PEDIDO MÍNIMO: 12
    // PEÇAS"). Só recusa quando a fábrica escreveu o número.
    if (p.pedidoMinimo && qtd < p.pedidoMinimo) {
      recusados.push({
        codigo: p.codigo,
        nome: p.nome,
        pedido: qtd,
        limite: p.pedidoMinimo,
        motivo: `o catálogo pede no mínimo ${p.pedidoMinimo} ${p.unidadeVenda || 'peças'} deste item`,
      });
      continue;
    }

    const calc = precoUnitario(p.precoBase, desconto, cond, regras);
    const total = Math.round((calc.preco * qtd + Number.EPSILON) * 100) / 100;

    itens.push({
      codigo: p.codigo,
      codigoOriginal: p.codigoOriginal || p.codigo,
      nome: p.nome,
      categoria: p.categoria,
      imagem: p.imagemManual || p.imagem || '',
      quantidade: qtd,
      natureza,
      mesChegada: natureza === 'programado' && p.chegadas?.length ? String(p.chegadas[0].rotulo || '') : '',
      precoTabela: p.precoBase,
      precoUnitario: calc.preco,
      total,
      estoqueNoMomento: p.estoque,
      // Vão junto para o PDF: sem a unidade, "24" pode virar 24 peças ou 24
      // embalagens de 12 na hora de expedir; sem a tarja, um pedido inteiro de
      // itens REDUZIDO sai igual a um de itens REGULAR.
      unidadeVenda: p.unidadeVenda || '',
      situacaoEstoque: p.situacaoEstoque || '',
    });

    pecas += qtd;
    if (natureza === 'pronta') totalPronta += total;
    else totalProgramado += total;
  }

  const arred = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
  totalPronta = arred(totalPronta);
  totalProgramado = arred(totalProgramado);
  const total = arred(totalPronta + totalProgramado);

  // Condição escolhida precisa estar realmente liberada para este total —
  // a Samsonite só libera 60/90, 90 e 60/90/120 acima de R$ 15.000, e essa
  // checagem tem que valer no servidor, não só esconder o botão na tela.
  const permitidas = condicoesDisponiveis(regras, total);
  if (!permitidas.some((c) => c.id === cond.id)) {
    const erro = new Error(
      `A condição "${cond.rotulo}" só fica disponível a partir de ${
        (regras.condicoesAcimaDeValor?.valorMinimo || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
      } em pedido. Escolha outra condição ou aumente o pedido.`
    );
    erro.status = 422;
    throw erro;
  }

  const valorFreteCif = marca.valorFreteCif !== null && marca.valorFreteCif !== undefined ? marca.valorFreteCif : config.valorFreteCif;
  const pedidoMinimo = marca.pedidoMinimo !== null && marca.pedidoMinimo !== undefined ? marca.pedidoMinimo : config.pedidoMinimo;

  const cab = corpo.cabecalho || {};
  // Quem decide o frete é o valor do pedido, não o campo da tela. O campo de
  // frete só fica travado quando JÁ é CIF; abaixo do patamar ele ficava
  // editável, e escrever "CIF" nele passava direto — o frete de um pedido
  // abaixo do mínimo saía por conta da representação. A equipe continua
  // podendo informar o frete à mão, porque aí existe alguém respondendo.
  const freteCalculado = total >= valorFreteCif ? 'CIF' : 'FOB';
  const frete = ehCliente
    ? freteCalculado
    : (String(cab.frete || '').toUpperCase() === 'CIF' ? 'CIF' : freteCalculado);

  // pedidoMinimo/valorFreteCif aqui já são os efetivos (marca, com Config
  // como plano B) — routes/previa e / continuam lendo `config.pedidoMinimo`
  // e `config.valorFreteCif` sem saber que existe uma marca por trás.
  const configEfetivo = { ...config.toObject(), pedidoMinimo, valorFreteCif };

  return {
    config: configEfetivo,
    marca,
    recusados,
    dados: {
      marcaSlug,
      clienteId: sessao.id,
      clienteUsuario: sessao.usuario,
      razaoSocial: cab.razaoSocial || cliente?.razaoSocial || '',
      cnpj: cab.cnpj || cliente?.cnpj || '',
      endereco: cab.endereco || cliente?.endereco || '',
      telefone: cab.telefone || cliente?.telefone || '',
      email: cab.email || cliente?.email || '',
      vendedor: cab.vendedor || cliente?.vendedor || '',
      transportadora: cab.transportadora || cliente?.transportadora || '',
      frete,
      condicao: cond.id,
      condicaoRotulo: cond.rotulo,
      prazoMedio: info.prazoMedio,
      acrescimoPrazo: info.acrescimo,
      descontoCliente: desconto,
      observacoes: cab.observacoes || '',
      itens,
      totalPronta,
      totalProgramado,
      total,
      pecas,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Prévia: recalcula o carrinho sem gravar nada
 * ------------------------------------------------------------------ */

/**
 * O que da prévia pode ir para o navegador do CLIENTE.
 *
 * `lib/catalogoServico.js` promete que "o desconto do cliente e a conta de
 * formação de preço não saem daqui", e `models/Usuario.js` diz que o desconto
 * NUNCA é enviado ao navegador dele. A prévia furava as duas coisas: mandava
 * `descontoCliente` inteiro e o `precoTabela` de cada item ao lado do preço
 * final — de onde a margem sai por subtração. Para a equipe, os dois campos
 * continuam, porque é ela que precisa conferir a conta.
 */
function limparPreviaDoCliente(dados) {
  const { descontoCliente, ...resto } = dados;
  return {
    ...resto,
    itens: (dados.itens || []).map(({ precoTabela, estoqueNoMomento, ...item }) => item),
  };
}

router.post('/previa', async (req, res) => {
  try {
    const { dados, config, recusados } = await montarPedido(req.session.usuario, req.body);
    const visivel = req.session.usuario.perfil === 'cliente' ? limparPreviaDoCliente(dados) : dados;
    res.json({
      ...visivel,
      recusados,
      pedidoMinimo: config.pedidoMinimo,
      atingiuMinimo: dados.total >= config.pedidoMinimo,
      faltaParaMinimo: Math.max(0, Math.round((config.pedidoMinimo - dados.total) * 100) / 100),
      freteCif: dados.total >= config.valorFreteCif,
      valorFreteCif: config.valorFreteCif,
    });
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message, negociar: !!e.negociar });
  }
});

/* ------------------------------------------------------------------ *
 * Envio do pedido
 * ------------------------------------------------------------------ */

router.post('/', async (req, res) => {
  try {
    const { dados, config, marca, recusados } = await montarPedido(req.session.usuario, req.body);

    if (recusados.length) {
      return res.status(422).json({
        erro: 'Alguns itens passaram do que existe em estoque. Ajuste as quantidades e envie de novo.',
        recusados,
      });
    }
    if (!dados.itens.length) {
      return res.status(400).json({ erro: 'Nenhum item válido no carrinho.' });
    }
    if (dados.total < config.pedidoMinimo) {
      return res.status(422).json({
        erro: `O pedido mínimo é de ${config.pedidoMinimo.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}. ` +
              `Faltam ${(config.pedidoMinimo - dados.total).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`,
        faltaParaMinimo: config.pedidoMinimo - dados.total,
      });
    }
    const obrigatorios = ['razaoSocial', 'cnpj', 'endereco', 'transportadora', 'vendedor'];
    const faltando = obrigatorios.filter((c) => !String(dados[c] || '').trim());
    if (faltando.length) {
      return res.status(400).json({
        erro: 'Preencha os dados do pedido antes de enviar.',
        campos: faltando,
      });
    }

    const pedido = await Pedido.create(dados);

    // O aviso por e-mail é acessório: se falhar, o pedido continua gravado.
    // E-mails: usa a lista própria da marca quando ela tiver uma cadastrada,
    // senão cai na lista global de Config (mesmo comportamento de antes).
    const emailsAviso = (marca.emailsAviso && marca.emailsAviso.length) ? marca.emailsAviso : config.emailsAviso;
    const url = `${process.env.URL_PUBLICA || ''}/painel#pedido-${pedido.numero}`;
    enviarAvisoPedido(pedido.toObject(), emailsAviso, url, marca.nome)
      .then((r) => {
        if (r.enviado) return Pedido.updateOne({ _id: pedido._id }, { avisoEnviado: true });
        console.warn('[aviso] não enviado:', r.motivo);
      })
      .catch((e) => console.warn('[aviso] falhou:', e.message));

    res.json({ ok: true, numero: pedido.numero, id: String(pedido._id) });
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message, negociar: !!e.negociar });
  }
});

/* ------------------------------------------------------------------ *
 * Consulta
 * ------------------------------------------------------------------ */

/** O cliente vê só os pedidos dele. A equipe vê todos. */
function escopo(sessao, extra = {}) {
  if (sessao.perfil === 'cliente') return { ...extra, clienteId: sessao.id };
  return extra;
}

router.get('/', async (req, res) => {
  const filtro = escopo(req.session.usuario);
  // String() na marra: sem isso, `?status[$regex]=(a+)+$` chegava ao Mongo
  // como operador, não como texto. O escopo do cliente continuava valendo,
  // mas a regex catastrófica ia para o banco assim mesmo.
  if (req.query.status) filtro.status = String(req.query.status);
  if (req.query.cliente && req.session.usuario.perfil !== 'cliente') {
    filtro.clienteId = String(req.query.cliente);
  }

  const limite = Number(req.query.limite);
  const pedidos = await Pedido.find(filtro)
    .sort({ createdAt: -1 })
    .limit(Number.isFinite(limite) && limite > 0 ? Math.min(1000, Math.floor(limite)) : 200)
    .lean();
  res.json(pedidos.map((p) => semDesconto(req.session.usuario, p)));
});

/**
 * O número do pedido, ou nada.
 *
 * `Number("abc")` é NaN, e NaN chegando ao Mongoose vira CastError. Com o
 * `.catch(next)` de hoje isso já não derruba o servidor, mas responder 400 na
 * hora é mais honesto do que deixar o banco reclamar.
 */
function numeroDoPedido(req) {
  const n = Number(req.params.numero);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** O desconto do cliente não volta nem no pedido gravado. */
function semDesconto(sessao, pedido) {
  if (!pedido || sessao.perfil !== 'cliente') return pedido;
  const { descontoCliente, ...resto } = pedido;
  return { ...resto, itens: (pedido.itens || []).map(({ precoTabela, ...i }) => i) };
}

router.get('/:numero', async (req, res) => {
  const numero = numeroDoPedido(req);
  if (!numero) return res.status(400).json({ erro: 'Número de pedido inválido.' });
  const p = await Pedido.findOne(escopo(req.session.usuario, { numero })).lean();
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  res.json(semDesconto(req.session.usuario, p));
});

/* ------------------------------------------------------------------ *
 * Saídas: Excel e PDF
 * ------------------------------------------------------------------ */

/**
 * O nome da marca para o cabeçalho do documento.
 *
 * Estava chumbado "MAXPRINT" no Excel de todo pedido — inclusive nos da
 * Samsonite, com preço Samsonite. É essa planilha que o Marcelo usa para
 * digitar no portal da indústria, e cabeçalho errado é exatamente o que faz o
 * pedido ser digitado no portal errado. No PDF era um mapa fixo de duas
 * marcas, então a Yin's saía sem nome nenhum.
 */
async function nomeDaMarcaDoPedido(pedido) {
  try {
    const m = await carregarMarca(pedido.marcaSlug || 'maxprint');
    if (m && m.nome) return m.nome;
  } catch (_) { /* marca apagada não impede a emissão do documento */ }
  const slug = String(pedido.marcaSlug || 'maxprint');
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

router.get('/:numero/excel', async (req, res) => {
  const numero = numeroDoPedido(req);
  if (!numero) return res.status(400).json({ erro: 'Número de pedido inválido.' });
  const p = await Pedido.findOne(escopo(req.session.usuario, { numero })).lean();
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  const buf = await gerarExcel(p, { nomeMarca: await nomeDaMarcaDoPedido(p) });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="pedido-${p.numero}.xlsx"`);
  res.send(Buffer.from(buf));
});

router.get('/:numero/pdf', async (req, res) => {
  const numero = numeroDoPedido(req);
  if (!numero) return res.status(400).json({ erro: 'Número de pedido inválido.' });
  const p = await Pedido.findOne(escopo(req.session.usuario, { numero })).lean();
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  const buf = await gerarPdf(p, { nomeMarca: await nomeDaMarcaDoPedido(p) });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="pedido-${p.numero}.pdf"`);
  res.send(buf);
});

/**
 * Prévia em Excel/PDF ANTES de enviar. O cliente pediu para poder baixar a
 * cópia do que vai mandar, então ela precisa existir sem pedido gravado.
 */
router.post('/copia/:formato', async (req, res) => {
  try {
    const { dados, marca } = await montarPedido(req.session.usuario, req.body);
    const rascunho = { ...dados, numero: 'RASCUNHO', createdAt: new Date() };
    const opcoesDoc = { nomeMarca: (marca && marca.nome) || '' };

    if (req.params.formato === 'pdf') {
      const buf = await gerarPdf(rascunho, opcoesDoc);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="pedido-rascunho.pdf"');
      return res.send(buf);
    }
    const buf = await gerarExcel(rascunho, opcoesDoc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="pedido-rascunho.xlsx"');
    return res.send(Buffer.from(buf));
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message });
  }
});

/* ------------------------------------------------------------------ *
 * Painel: mudança de status
 * ------------------------------------------------------------------ */

const STATUS_VALIDOS = ['novo', 'digitado', 'faturado', 'cancelado'];

router.patch('/:numero', requireInterno, async (req, res) => {
  const permitido = {};
  // Lista fechada: o enum do schema já recusaria outro valor, mas com erro de
  // validação em vez de uma resposta que explica.
  if (req.body.status) {
    const s = String(req.body.status);
    if (!STATUS_VALIDOS.includes(s)) {
      return res.status(400).json({ erro: `Status inválido. Use um destes: ${STATUS_VALIDOS.join(', ')}.` });
    }
    permitido.status = s;
  }
  if (req.body.observacaoInterna !== undefined) permitido.observacaoInterna = String(req.body.observacaoInterna);

  const numero = numeroDoPedido(req);
  if (!numero) return res.status(400).json({ erro: 'Número de pedido inválido.' });

  const p = await Pedido.findOneAndUpdate({ numero }, permitido, { new: true }).lean();
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  res.json(p);
});

/* ------------------------------------------------------------------ *
 * Painel: excluir pedido
 *
 * Apaga de vez, como combinado — não fica cópia no banco. Duas coisas
 * acontecem junto com o apagar, e as duas são de propósito:
 *
 *  1. o número vai para a configuração antes de o pedido sumir, para que ele
 *     NUNCA seja dado a outro pedido. O PDF do pedido apagado pode já estar no
 *     e-mail de alguém;
 *  2. o pedido inteiro sai no log do servidor antes de morrer. É a única
 *     chance de reconstruir alguma coisa se o pedido errado for apagado —
 *     `pm2 logs maxprint-pedidos` guarda isso por dias. Custa nada e um dia
 *     salva uma tarde.
 *
 * Cliente não chega aqui: requireInterno barra. Admin e vendedor podem, como
 * o Marcelo pediu.
 * ------------------------------------------------------------------ */
router.delete('/:numero', requireInterno, async (req, res) => {
  const numero = Number(req.params.numero);
  if (!Number.isFinite(numero)) return res.status(400).json({ erro: 'Número de pedido inválido.' });

  const p = await Pedido.findOne({ numero }).lean();
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });

  const config = await Config.carregar();
  if ((config.ultimoNumeroPedido || 0) < numero) {
    config.ultimoNumeroPedido = numero;
    await config.save();
  }

  console.log('[pedido excluido]', JSON.stringify({
    quem: req.session.usuario.usuario,
    quando: new Date().toISOString(),
    pedido: p,
  }));

  await Pedido.deleteOne({ _id: p._id });

  res.json({
    ok: true,
    numero,
    razaoSocial: p.razaoSocial,
    total: p.total,
  });
});

module.exports = router;
