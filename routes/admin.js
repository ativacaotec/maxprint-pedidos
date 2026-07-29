'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const Usuario = require('../models/Usuario');
const Pedido = require('../models/Pedido');
const Produto = require('../models/Produto');
const Config = require('../models/Config');
const Marca = require('../models/Marca');
const { enviarAvisoPedido, configurado } = require('../lib/email');
const { carregarMarca, listarMarcasAtivas } = require('../lib/marcas');
const { requireLogin, requireInterno, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin, requireInterno);

/* ------------------------------------------------------------------ *
 * Clientes e usuários
 * ------------------------------------------------------------------ */

const CAMPOS_PUBLICOS =
  'nome usuario perfil ativo email razaoSocial cnpj endereco telefone vendedor transportadora desconto catalogoStatus verOutlet permitirProgramado marcasPermitidas ultimoAcesso createdAt';

/** Lista de slugs de marca válidos hoje, para não gravar lixo no cadastro do cliente. */
function marcasValidas(lista) {
  if (!Array.isArray(lista)) return undefined;
  return [...new Set(lista.map((s) => String(s || '').toLowerCase().trim()).filter(Boolean))];
}

router.get('/usuarios', async (req, res) => {
  const filtro = {};
  if (req.query.perfil) filtro.perfil = req.query.perfil;
  const lista = await Usuario.find(filtro).select(CAMPOS_PUBLICOS).sort({ nome: 1 }).lean();
  res.json(lista);
});

/** Senha sugerida: legível de ditar por telefone e ainda assim aleatória. */
function senhaSugerida() {
  const letras = 'abcdefghjkmnpqrstuvwxyz';
  const numeros = '23456789';
  const pega = (s, n) => Array.from({ length: n }, () => s[crypto.randomInt(s.length)]).join('');
  return `${pega(letras, 4)}-${pega(numeros, 4)}`;
}

router.get('/senha-sugerida', requireAdmin, (req, res) => {
  res.json({ senha: senhaSugerida() });
});

router.post('/usuarios', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const usuario = String(b.usuario || '').trim().toLowerCase();
    if (!usuario || !b.nome) return res.status(400).json({ erro: 'Nome e usuário são obrigatórios.' });

    const existe = await Usuario.findOne({ usuario });
    if (existe) return res.status(409).json({ erro: 'Já existe alguém com esse usuário.' });

    const senha = String(b.senha || '') || senhaSugerida();
    if (senha.length < 6) return res.status(400).json({ erro: 'A senha precisa de pelo menos 6 caracteres.' });

    const novo = await Usuario.create({
      nome: b.nome,
      usuario,
      senhaHash: bcrypt.hashSync(senha, 10),
      perfil: b.perfil || 'cliente',
      email: b.email || '',
      razaoSocial: b.razaoSocial || '',
      cnpj: b.cnpj || '',
      endereco: b.endereco || '',
      telefone: b.telefone || '',
      vendedor: b.vendedor || '',
      transportadora: b.transportadora || '',
      desconto: Number(b.desconto || 0),
      catalogoStatus: b.catalogoStatus || 'travado',
      verOutlet: b.verOutlet !== false,
      permitirProgramado: b.permitirProgramado !== false,
      marcasPermitidas: marcasValidas(b.marcasPermitidas) || ['maxprint'],
    });

    // A senha em claro volta UMA vez, para o admin repassar ao cliente.
    // Depois disso só existe o hash.
    res.json({ ok: true, id: String(novo._id), usuario: novo.usuario, senha });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

router.patch('/usuarios/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const set = {};
  const permitidos = [
    'nome', 'email', 'razaoSocial', 'cnpj', 'endereco', 'telefone', 'vendedor',
    'transportadora', 'catalogoStatus', 'ativo', 'verOutlet', 'permitirProgramado', 'perfil',
  ];
  for (const c of permitidos) if (b[c] !== undefined) set[c] = b[c];
  if (b.desconto !== undefined) set.desconto = Math.min(Math.max(Number(b.desconto) || 0, 0), 0.95);
  if (b.marcasPermitidas !== undefined) {
    const validas = marcasValidas(b.marcasPermitidas);
    // Lista vazia de propósito não vira "sem marca nenhuma" — cai no default
    // ['maxprint'], porque um cliente sem nenhuma marca marcada fica sem
    // conseguir ver catálogo nenhum, o que quase certamente não é a intenção.
    set.marcasPermitidas = validas && validas.length ? validas : ['maxprint'];
  }

  const u = await Usuario.findByIdAndUpdate(req.params.id, set, { new: true })
    .select(CAMPOS_PUBLICOS).lean();
  if (!u) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  res.json(u);
});

router.post('/usuarios/:id/senha', requireAdmin, async (req, res) => {
  const senha = String(req.body.senha || '') || senhaSugerida();
  if (senha.length < 6) return res.status(400).json({ erro: 'A senha precisa de pelo menos 6 caracteres.' });
  const u = await Usuario.findByIdAndUpdate(req.params.id, { senhaHash: bcrypt.hashSync(senha, 10) });
  if (!u) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  res.json({ ok: true, senha });
});

/* ------------------------------------------------------------------ *
 * Configuração
 * ------------------------------------------------------------------ */

router.get('/config', async (req, res) => res.json(await Config.carregar()));

router.put('/config', requireAdmin, async (req, res) => {
  const c = await Config.carregar();
  const b = req.body || {};
  if (b.pedidoMinimo !== undefined) c.pedidoMinimo = Number(b.pedidoMinimo) || 0;
  if (b.valorFreteCif !== undefined) c.valorFreteCif = Number(b.valorFreteCif) || 0;
  if (b.itensRanking !== undefined) c.itensRanking = Math.max(1, Number(b.itensRanking) || 15);
  if (Array.isArray(b.statusBloqueados)) c.statusBloqueados = b.statusBloqueados;
  if (Array.isArray(b.emailsAviso)) c.emailsAviso = b.emailsAviso.filter(Boolean);
  if (b.tituloSistema) c.tituloSistema = b.tituloSistema;
  await c.save();
  res.json(c);
});

/* ------------------------------------------------------------------ *
 * Marcas: abas do sistema (Maxprint, Samsonite, e no futuro Yins)
 * ------------------------------------------------------------------ */

router.get('/marcas', async (req, res) => {
  const lista = await Marca.find().sort({ ordem: 1, nome: 1 }).lean();
  res.json(lista);
});

const CAMPOS_MARCA_EDITAVEIS = [
  'nome', 'ativa', 'ordem', 'corPrimaria', 'corSecundaria', 'logoClara', 'logoEscura',
  'pedidoMinimo', 'valorFreteCif', 'condicoesPagamento', 'condicoesAcimaDeValor',
  'aplicarAcrescimoPrazo', 'prazoMaximoDias', 'acrescimoNoTeto', 'emailsAviso', 'subMarcas',
];

router.patch('/marcas/:slug', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const set = {};
  for (const c of CAMPOS_MARCA_EDITAVEIS) if (b[c] !== undefined) set[c] = b[c];

  const m = await Marca.findOneAndUpdate({ slug: String(req.params.slug).toLowerCase() }, set, { new: true }).lean();
  if (!m) return res.status(404).json({ erro: 'Marca não encontrada.' });
  res.json(m);
});

/* ------------------------------------------------------------------ *
 * Painel: números da casa
 * ------------------------------------------------------------------ */

router.get('/resumo', async (req, res) => {
  const [novos, digitados, faturados, produtos, clientes] = await Promise.all([
    Pedido.countDocuments({ status: 'novo' }),
    Pedido.countDocuments({ status: 'digitado' }),
    Pedido.countDocuments({ status: 'faturado' }),
    Produto.countDocuments({ ativo: true }),
    Usuario.countDocuments({ perfil: 'cliente', ativo: true }),
  ]);

  const trintaDias = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const [agregado] = await Pedido.aggregate([
    { $match: { createdAt: { $gte: trintaDias }, status: { $ne: 'cancelado' } } },
    { $group: { _id: null, total: { $sum: '$total' }, pedidos: { $sum: 1 }, pecas: { $sum: '$pecas' } } },
  ]);

  const semFoto = await Produto.countDocuments({ ativo: true, imagem: '', imagemManual: '' });
  const semSaldo = await Produto.countDocuments({ ativo: true, estoque: 0 });
  const naoAvisados = await Pedido.countDocuments({ avisoEnviado: false, status: 'novo' });

  res.json({
    emailConfigurado: configurado(),
    naoAvisados,
    pedidos: { novos, digitados, faturados },
    ultimos30: agregado || { total: 0, pedidos: 0, pecas: 0 },
    produtos,
    clientes,
    semFoto,
    semSaldo,
  });
});

/**
 * Dispara um aviso de teste. Serve para descobrir na hora se a chave do
 * serviço de e-mail está certa, em vez de só perceber quando um pedido de
 * verdade chegar e ninguém for avisado.
 */
router.post('/testar-email', requireAdmin, async (req, res) => {
  const c = await Config.carregar();
  if (!configurado()) {
    return res.status(400).json({
      erro: 'A chave do serviço de e-mail não está configurada no servidor (EMAIL_API_KEY no arquivo .env).',
    });
  }
  const falso = {
    numero: 'TESTE',
    razaoSocial: 'Envio de teste',
    cnpj: '00.000.000/0001-00',
    condicaoRotulo: '30 dias',
    frete: 'CIF',
    total: 3500,
    totalProgramado: 0,
    pecas: 120,
    itens: [{ codigo: 'TESTE', codigoOriginal: 'TESTE', nome: 'Item de teste', quantidade: 120, total: 3500 }],
  };
  const r = await enviarAvisoPedido(falso, c.emailsAviso, (process.env.URL_PUBLICA || '') + '/painel');
  if (!r.enviado) return res.status(502).json({ erro: `Não consegui enviar: ${r.motivo}` });
  res.json({ ok: true, para: c.emailsAviso });
});

/**
 * Reenvia o aviso de um pedido que ficou sem notificação (por exemplo, porque
 * a chave de e-mail ainda não estava configurada quando ele chegou).
 */
router.post('/reenviar-aviso/:numero', requireAdmin, async (req, res) => {
  const c = await Config.carregar();
  const p = await Pedido.findOne({ numero: Number(req.params.numero) }).lean();
  if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  const marca = await carregarMarca(p.marcaSlug || 'maxprint');
  const emailsAviso = (marca && marca.emailsAviso && marca.emailsAviso.length) ? marca.emailsAviso : c.emailsAviso;
  const r = await enviarAvisoPedido(p, emailsAviso, `${process.env.URL_PUBLICA || ''}/painel`, marca ? marca.nome : '');
  if (!r.enviado) return res.status(502).json({ erro: `Não consegui enviar: ${r.motivo}` });
  await Pedido.updateOne({ _id: p._id }, { avisoEnviado: true });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Relatórios
 * ------------------------------------------------------------------ */

function periodo(req) {
  const de = req.query.de ? new Date(req.query.de) : new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const ate = req.query.ate ? new Date(`${req.query.ate}T23:59:59`) : new Date();
  return { createdAt: { $gte: de, $lte: ate }, status: { $ne: 'cancelado' } };
}

router.get('/relatorio/clientes', async (req, res) => {
  const dados = await Pedido.aggregate([
    { $match: periodo(req) },
    { $group: { _id: '$razaoSocial', total: { $sum: '$total' }, pedidos: { $sum: 1 }, pecas: { $sum: '$pecas' } } },
    { $sort: { total: -1 } },
    { $limit: 100 },
  ]);
  res.json(dados);
});

router.get('/relatorio/produtos', async (req, res) => {
  const dados = await Pedido.aggregate([
    { $match: periodo(req) },
    { $unwind: '$itens' },
    {
      $group: {
        _id: { codigo: '$itens.codigo', nome: '$itens.nome' },
        pecas: { $sum: '$itens.quantidade' },
        total: { $sum: '$itens.total' },
        pedidos: { $sum: 1 },
      },
    },
    { $sort: { pecas: -1 } },
    { $limit: 100 },
  ]);
  res.json(dados.map((d) => ({ codigo: d._id.codigo, nome: d._id.nome, pecas: d.pecas, total: d.total, pedidos: d.pedidos })));
});

router.get('/relatorio/periodo', async (req, res) => {
  const dados = await Pedido.aggregate([
    { $match: periodo(req) },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
        total: { $sum: '$total' },
        pedidos: { $sum: 1 },
        pecas: { $sum: '$pecas' },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  res.json(dados);
});

/** Busca de produto no painel, para conferência e para subir foto. */
router.get('/produtos', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const filtro = { ativo: true };
  if (req.query.marca) filtro.marcaSlug = String(req.query.marca).toLowerCase();
  if (q) {
    filtro.$or = [
      { codigo: new RegExp(q.replace(/\D/g, ''), 'i') },
      { nome: new RegExp(q, 'i') },
      { descricaoEstoque: new RegExp(q, 'i') },
      // A Samsonite se procura pela cor e pela linha com muito mais frequência
      // do que por código — quem atende tem o nome da mala na cabeça, não o SKU.
      { cor: new RegExp(q, 'i') },
      { grupo: new RegExp(q, 'i') },
    ];
  }
  if (req.query.semFoto === 'sim') { filtro.imagem = ''; filtro.imagemManual = ''; }
  const lista = await Produto.find(filtro).sort({ estoque: -1 }).limit(200).lean();
  res.json(lista);
});

module.exports = router;
