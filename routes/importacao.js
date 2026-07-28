'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const Base = require('../models/Base');
const Produto = require('../models/Produto');
const Importacao = require('../models/Importacao');
const { requireLogin, requireAdmin } = require('../middleware/auth');

const { importarPreco } = require('../lib/importPreco');
const { importarEstoque, juntarEstoque } = require('../lib/importEstoque');
const { importarCatalogo } = require('../lib/importCatalogo');
const { cruzar } = require('../lib/cruzamento');

const router = express.Router();
router.use(requireLogin, requireAdmin);

const PASTA_UPLOAD = path.join(__dirname, '..', 'uploads');
const PASTA_IMAGENS = path.join(__dirname, '..', 'public', 'img');
fs.mkdirSync(PASTA_UPLOAD, { recursive: true });
fs.mkdirSync(PASTA_IMAGENS, { recursive: true });

const upload = multer({
  dest: PASTA_UPLOAD,
  limits: { fileSize: 120 * 1024 * 1024, files: 12 },
});

/* ------------------------------------------------------------------ *
 * O cruzamento é refeito sempre que qualquer uma das três bases muda.
 * ------------------------------------------------------------------ */

async function recruzar() {
  const [preco, estoque, catalogo, modelos] = await Promise.all([
    Base.findOne({ tipo: 'preco' }).lean(),
    Base.findOne({ tipo: 'estoque' }).lean(),
    Base.findOne({ tipo: 'catalogo' }).lean(),
    Base.findOne({ tipo: 'catalogoModelos' }).lean(),
  ]);

  const { produtos, relatorio } = cruzar({
    precos: preco?.itens || [],
    estoques: estoque?.itens || [],
    catalogo: catalogo?.itens || [],
    fichasPorModelo: modelos?.itens || [],
  });

  // As imagens que o admin subiu à mão sobrevivem ao recruzamento.
  const manuais = await Produto.find({ imagemManual: { $ne: '' } })
    .select('codigo imagemManual').lean();
  const mapaManual = new Map(manuais.map((m) => [m.codigo, m.imagemManual]));

  const operacoes = produtos.map((p) => ({
    updateOne: {
      filter: { codigo: p.codigo },
      update: { $set: { ...p, imagemManual: mapaManual.get(p.codigo) || '', ativo: true } },
      upsert: true,
    },
  }));

  if (operacoes.length) await Produto.bulkWrite(operacoes, { ordered: false });

  // Some do catálogo o que saiu das planilhas, sem apagar o histórico.
  const vivos = produtos.map((p) => p.codigo);
  await Produto.updateMany({ codigo: { $nin: vivos } }, { $set: { ativo: false } });

  relatorio.desativados = await Produto.countDocuments({ ativo: false });
  return relatorio;
}

function limpar(arquivos) {
  for (const a of arquivos || []) {
    try { fs.unlinkSync(a.path); } catch (_) { /* arquivo temporário */ }
  }
}

async function registrar(tipo, req, inicio, relatorio, avisos, erro) {
  return Importacao.create({
    tipo,
    arquivos: (req.files || []).map((f) => f.originalname),
    usuario: req.session.usuario.usuario,
    duracaoSegundos: Math.round((Date.now() - inicio) / 1000),
    relatorio: relatorio || {},
    avisos: avisos || [],
    erro: erro || '',
  });
}

/* ------------------------------------------------------------------ *
 * Botão 1: catálogos em PDF (aceita vários de uma vez)
 * ------------------------------------------------------------------ */

router.post('/catalogo', upload.array('arquivos', 12), async (req, res) => {
  const inicio = Date.now();
  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ erro: 'Escolha pelo menos um PDF.' });
    }

    const anterior = await Base.findOne({ tipo: 'catalogo' }).lean();
    const anteriorModelos = await Base.findOne({ tipo: 'catalogoModelos' }).lean();
    const acumular = String(req.body.acumular || 'sim') === 'sim';

    const fichas = acumular ? [...(anterior?.itens || [])] : [];
    const fichasModelo = acumular ? [...(anteriorModelos?.itens || [])] : [];
    const origem = acumular ? [...(anterior?.origem || [])] : [];
    const avisos = [];
    const porArquivo = [];

    for (const [i, f] of req.files.entries()) {
      const prefixo = `c${Date.now().toString(36)}${i}`;
      const r = await importarCatalogo(f.path, {
        pastaImagens: PASTA_IMAGENS,
        prefixo,
      });

      // O mesmo código vindo de um catálogo mais novo substitui o antigo.
      const novos = new Set(r.produtos.map((p) => p.codigo));
      const restantes = fichas.filter((p) => !novos.has(p.codigo));
      fichas.length = 0;
      fichas.push(...restantes, ...r.produtos);
      fichasModelo.push(...r.porModelo);

      origem.push({ arquivo: f.originalname, produtos: r.produtos.length, comFoto: r.comFoto, paginas: r.paginas });
      avisos.push(...r.avisos.map((a) => `${f.originalname}: ${a}`));
      porArquivo.push({
        arquivo: f.originalname,
        paginas: r.paginas,
        cards: r.cards,
        codigos: r.produtos.length,
        comFoto: r.comFoto,
        fichasPorModelo: r.porModelo.length,
      });
    }

    await Base.findOneAndUpdate(
      { tipo: 'catalogo' },
      { tipo: 'catalogo', itens: fichas, origem, atualizadoEm: new Date() },
      { upsert: true }
    );
    await Base.findOneAndUpdate(
      { tipo: 'catalogoModelos' },
      { tipo: 'catalogoModelos', itens: fichasModelo, atualizadoEm: new Date() },
      { upsert: true }
    );

    const relatorio = await recruzar();
    relatorio.porArquivo = porArquivo;
    await registrar('catalogo', req, inicio, relatorio, avisos);
    limpar(req.files);

    res.json({ ok: true, relatorio, avisos });
  } catch (e) {
    console.error('[import catalogo]', e);
    await registrar('catalogo', req, inicio, {}, [], e.message);
    limpar(req.files);
    res.status(500).json({ erro: `Falhou ao ler o catálogo: ${e.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * Botão 2: estoque (mapas de chegadas, vários de uma vez)
 * ------------------------------------------------------------------ */

router.post('/estoque', upload.array('arquivos', 12), async (req, res) => {
  const inicio = Date.now();
  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ erro: 'Escolha pelo menos uma planilha.' });
    }

    const resultados = req.files.map((f) => importarEstoque(f.path, f.originalname));
    const junto = juntarEstoque(resultados);

    await Base.findOneAndUpdate(
      { tipo: 'estoque' },
      {
        tipo: 'estoque',
        itens: junto.itens,
        origem: resultados.map((r, i) => ({
          arquivo: req.files[i].originalname,
          itens: r.itens.length,
          aba: r.aba,
          abasIgnoradas: r.abasIgnoradas,
          meses: r.mesesPrevisao,
        })),
        atualizadoEm: new Date(),
      },
      { upsert: true }
    );

    const relatorio = await recruzar();
    relatorio.porArquivo = resultados.map((r, i) => ({
      arquivo: req.files[i].originalname,
      itens: r.itens.length,
      comSaldo: r.itens.filter((x) => x.estoque > 0).length,
      aba: r.aba,
      abasIgnoradas: r.abasIgnoradas.length,
      meses: r.mesesPrevisao,
    }));

    await registrar('estoque', req, inicio, relatorio, junto.avisos);
    limpar(req.files);

    res.json({ ok: true, relatorio, avisos: junto.avisos });
  } catch (e) {
    console.error('[import estoque]', e);
    await registrar('estoque', req, inicio, {}, [], e.message);
    limpar(req.files);
    res.status(500).json({ erro: `Falhou ao ler o estoque: ${e.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * Botão 3: tabela de preço
 * ------------------------------------------------------------------ */

router.post('/preco', upload.array('arquivos', 4), async (req, res) => {
  const inicio = Date.now();
  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ erro: 'Escolha a planilha de preços.' });
    }

    const todos = [];
    const avisos = [];
    const porArquivo = [];

    for (const f of req.files) {
      const r = importarPreco(f.path);
      todos.push(...r.itens);
      avisos.push(...r.avisos.map((a) => `${f.originalname}: ${a}`));
      porArquivo.push({ arquivo: f.originalname, itens: r.itens.length, abas: r.porAba });
    }

    // Arquivo mais recente vence em caso de código repetido.
    const mapa = new Map();
    for (const it of todos) mapa.set(it.codigo, it);

    await Base.findOneAndUpdate(
      { tipo: 'preco' },
      { tipo: 'preco', itens: [...mapa.values()], origem: porArquivo, atualizadoEm: new Date() },
      { upsert: true }
    );

    const relatorio = await recruzar();
    relatorio.porArquivo = porArquivo;
    await registrar('preco', req, inicio, relatorio, avisos);
    limpar(req.files);

    res.json({ ok: true, relatorio, avisos });
  } catch (e) {
    console.error('[import preco]', e);
    await registrar('preco', req, inicio, {}, [], e.message);
    limpar(req.files);
    res.status(500).json({ erro: `Falhou ao ler a tabela de preço: ${e.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * Foto avulsa: cobre o que o catálogo não ilustra
 * ------------------------------------------------------------------ */

const uploadImagem = multer({
  storage: multer.diskStorage({
    destination: PASTA_IMAGENS,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase();
      cb(null, `manual-${req.params.codigo}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
});

router.post('/foto/:codigo', uploadImagem.single('imagem'), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Escolha uma imagem.' });
  const p = await Produto.findOneAndUpdate(
    { codigo: req.params.codigo },
    { imagemManual: req.file.filename },
    { new: true }
  ).lean();
  if (!p) return res.status(404).json({ erro: 'Produto não encontrado.' });
  res.json({ ok: true, imagem: req.file.filename });
});

/* ------------------------------------------------------------------ *
 * Histórico e situação das bases
 * ------------------------------------------------------------------ */

router.get('/historico', async (req, res) => {
  const lista = await Importacao.find().sort({ createdAt: -1 }).limit(40).lean();
  res.json(lista);
});

router.get('/situacao', async (req, res) => {
  const bases = await Base.find().select('tipo origem atualizadoEm').lean();
  const contagem = {};
  for (const b of await Base.find().select('tipo itens').lean()) {
    contagem[b.tipo] = (b.itens || []).length;
  }
  const produtos = await Produto.countDocuments({ ativo: true });
  const semFoto = await Produto.countDocuments({ ativo: true, imagem: '', imagemManual: '' });
  res.json({ bases, contagem, produtos, semFoto });
});

/** Lista os produtos sem foto, para o admin resolver os que importam. */
router.get('/sem-foto', async (req, res) => {
  const lista = await Produto.find({ ativo: true, imagem: '', imagemManual: '' })
    .select('codigo codigoOriginal nome categoria linhaProduto estoque')
    .sort({ estoque: -1 })
    .limit(500)
    .lean();
  res.json(lista);
});

module.exports = router;
