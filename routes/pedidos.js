'use strict';

const express = require('express');
const Pedido = require('../models/Pedido');
const Produto = require('../models/Produto');
const Usuario = require('../models/Usuario');
const Config = require('../models/Config');
const { requireLogin, requireInterno } = require('../middleware/auth');
const { precoUnitario, fatorPrazo, interpretarCondicao, condicoesDisponiveis, regrasDaMarca } = require('../lib/prazo');
const { carregarMarca, podeAcessarMarca } = require('../lib/marcas');
const { gerarExcel } = require('../lib/gerarExcel');
const { gerarPdf } = require('../lib/gerarPdf');
const { enviarAvisoPedido } = require('../lib/email');

const router = express.Router();
router.use(requireLogin);

/* ------------------------------------------------------------------ *
 * Montagem do pedido (usada tanto na prévia quanto no envio)
 * ------------------------------------------------------------------ */

async function montarPedido(sessao, corpo) {
  const config = await Config.carregar();
  const cliente = await Usuario.findById(sessao.id).lean();
  const ehCliente = sessao.perfil === 'cliente';
  const desconto = ehCliente ? (cliente?.desconto || 0) : Number(corpo.descontoManual || 0);

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

  const codigos = linhas.map((l) => String(l.codigo));
  const produtos = await Produto.find({ codigo: { $in: codigos }, marcaSlug }).lean();
  const mapa = new Map(produtos.map((p) => [p.codigo, p]));

  const itens = [];
  const recusados = [];
  let totalPronta = 0;
  let totalProgramado = 0;
  let pecas = 0;

  for (const l of linhas) {
    const p = mapa.get(String(l.codigo));
    const qtd = Math.floor(Number(l.quantidade || 0));
    if (!p || qtd <= 0) continue;

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
  const frete = total >= valorFreteCif ? 'CIF' : (cab.frete || 'FOB');

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

router.post('/previa', async (req, res) => {
  try {
    const { dados, config, recusados } = await montarPedido(req.session.usuario, req.body);
    res.json({
      ...dados,
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
  if (req.query.status) filtro.status = req.query.status;
  if (req.query.cliente && req.session.usuario.perfil !== 'cliente') filtro.clienteId = req.query.cliente;

  const pedidos = await Pedido.find(filtro)
    .sort({ createdAt: -1 })
    .limit(Number(req.query.limite || 200))
    .lean();
  res.json(pedidos);
});

router.get('/:numero', async (req, res) => {
  const p = await Pedido.findOne(escopo(req.session.usuario, { numero: Number(req.params.numero) })).lean();
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  res.json(p);
});

/* ------------------------------------------------------------------ *
 * Saídas: Excel e PDF
 * ------------------------------------------------------------------ */

router.get('/:numero/excel', async (req, res) => {
  const p = await Pedido.findOne(escopo(req.session.usuario, { numero: Number(req.params.numero) })).lean();
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  const buf = await gerarExcel(p);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="pedido-${p.numero}.xlsx"`);
  res.send(Buffer.from(buf));
});

router.get('/:numero/pdf', async (req, res) => {
  const p = await Pedido.findOne(escopo(req.session.usuario, { numero: Number(req.params.numero) })).lean();
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  const buf = await gerarPdf(p);
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
    const { dados } = await montarPedido(req.session.usuario, req.body);
    const rascunho = { ...dados, numero: 'RASCUNHO', createdAt: new Date() };

    if (req.params.formato === 'pdf') {
      const buf = await gerarPdf(rascunho);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="pedido-rascunho.pdf"');
      return res.send(buf);
    }
    const buf = await gerarExcel(rascunho);
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

router.patch('/:numero', requireInterno, async (req, res) => {
  const permitido = {};
  if (req.body.status) permitido.status = req.body.status;
  if (req.body.observacaoInterna !== undefined) permitido.observacaoInterna = req.body.observacaoInterna;

  const p = await Pedido.findOneAndUpdate(
    { numero: Number(req.params.numero) },
    permitido,
    { new: true }
  ).lean();
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  res.json(p);
});

module.exports = router;
