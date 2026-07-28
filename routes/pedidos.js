'use strict';

const express = require('express');
const Pedido = require('../models/Pedido');
const Produto = require('../models/Produto');
const Usuario = require('../models/Usuario');
const Config = require('../models/Config');
const { requireLogin, requireInterno } = require('../middleware/auth');
const { precoUnitario, fatorPrazo, interpretarCondicao } = require('../lib/prazo');
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

  const cond = interpretarCondicao(corpo.condicao || '30');
  const info = fatorPrazo(cond);
  if (info.negociar) {
    const erro = new Error(
      `Prazo médio de ${info.prazoMedio} dias passa do limite de 60. ` +
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
  const produtos = await Produto.find({ codigo: { $in: codigos } }).lean();
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

    const disponivel = p.estoque > 0;
    const natureza = disponivel ? 'pronta' : 'programado';
    const limite = disponivel ? p.estoque : (p.previstoTotal || 0);

    // O bloqueio por saldo é aqui, no servidor. A trava da tela é conforto;
    // esta é a que vale, porque o navegador pode ser contornado.
    if (qtd > limite) {
      recusados.push({
        codigo: p.codigo,
        nome: p.nome,
        pedido: qtd,
        limite,
        motivo: disponivel ? 'quantidade acima do saldo disponível' : 'quantidade acima da chegada prevista',
      });
      continue;
    }

    const calc = precoUnitario(p.precoBase, desconto, cond);
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

  const cab = corpo.cabecalho || {};
  const frete = total >= config.valorFreteCif ? 'CIF' : (cab.frete || 'FOB');

  return {
    config,
    recusados,
    dados: {
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
    const { dados, config, recusados } = await montarPedido(req.session.usuario, req.body);

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
    const url = `${process.env.URL_PUBLICA || ''}/painel#pedido-${pedido.numero}`;
    enviarAvisoPedido(pedido.toObject(), config.emailsAviso, url)
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
