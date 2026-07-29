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

  // Tudo aqui é da MAXPRINT. Depois que o sistema virou multimarca, cada
  // consulta e cada escrita deste recruzamento precisa dizer isso: sem o
  // filtro por marca, o `updateMany` do fim desativaria o catálogo inteiro
  // da Samsonite toda vez que a Maxprint fosse reimportada.
  const MARCA = 'maxprint';

  // As imagens que o admin subiu à mão sobrevivem ao recruzamento.
  const manuais = await Produto.find({ marcaSlug: MARCA, imagemManual: { $ne: '' } })
    .select('codigo imagemManual').lean();
  const mapaManual = new Map(manuais.map((m) => [m.codigo, m.imagemManual]));

  const operacoes = produtos.map((p) => ({
    updateOne: {
      filter: { codigo: p.codigo, marcaSlug: MARCA },
      update: { $set: { ...p, marcaSlug: MARCA, imagemManual: mapaManual.get(p.codigo) || '', ativo: true } },
      upsert: true,
    },
  }));

  if (operacoes.length) await Produto.bulkWrite(operacoes, { ordered: false });

  // Some do catálogo o que saiu das planilhas, sem apagar o histórico.
  const vivos = produtos.map((p) => p.codigo);
  await Produto.updateMany({ marcaSlug: MARCA, codigo: { $nin: vivos } }, { $set: { ativo: false } });

  relatorio.desativados = await Produto.countDocuments({ marcaSlug: MARCA, ativo: false });
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
  // A marca vem por query (?marca=samsonite) porque o mesmo código pode, em
  // tese, existir em duas marcas — o índice do Produto é (marcaSlug, codigo).
  const marcaSlug = String(req.query.marca || 'maxprint').toLowerCase();
  const p = await Produto.findOneAndUpdate(
    { codigo: req.params.codigo, marcaSlug },
    { imagemManual: req.file.filename },
    { new: true }
  ).lean();
  if (!p) return res.status(404).json({ erro: 'Produto não encontrado.' });
  res.json({ ok: true, imagem: req.file.filename });
});

/* ------------------------------------------------------------------ *
 * Importação da Samsonite
 *
 * Diferente da Maxprint, aqui a base inteira (preço, saldo e descrição) vem
 * de UM arquivo só, o HTML da aplicação antiga. Os PDFs são opcionais e
 * servem só para trazer a foto de cada cor.
 *
 * Roda em SEGUNDO PLANO, com consulta de andamento à parte. Motivo: extrair
 * as fotos dos dois catálogos leva alguns minutos, e o Nginx corta conexão
 * ociosa bem antes disso — uma requisição só, esperando o fim, morreria no
 * meio do caminho e deixaria o Marcelo sem saber se importou ou não.
 * ------------------------------------------------------------------ */

const { importarSamsonite } = require('../lib/importSamsonite');
const { importarCatalogoSamsonite } = require('../lib/importCatalogoSamsonite');
const { cruzarComFotos } = require('../lib/cruzamentoSamsonite');

// Um processo pm2, uma execução por vez: um Map em memória basta. Se o
// processo reiniciar no meio, o job some — e é o certo, porque o resultado
// parcial não vale nada; o Marcelo simplesmente importa de novo.
const tarefas = new Map();

function novaTarefa() {
  const id = `imp-${Date.now().toString(36)}`;
  tarefas.set(id, { id, estado: 'rodando', etapa: 'começando', progresso: 0, relatorio: null, avisos: [], erro: '' });
  // Não deixo lixo acumulando na memória para sempre.
  if (tarefas.size > 20) tarefas.delete([...tarefas.keys()][0]);
  return id;
}

function marcar(id, campos) {
  const t = tarefas.get(id);
  if (t) Object.assign(t, campos);
}

async function rodarImportacaoSamsonite(id, arquivos, opcoes) {
  const MARCA = 'samsonite';
  try {
    const base = arquivos.base;
    marcar(id, { etapa: 'lendo a base da Samsonite', progresso: 5 });

    const { produtos, relatorio: relBase, avisos } = await importarSamsonite(base.path, {
      pastaImagens: PASTA_IMAGENS,
      prefixo: `sam${Date.now().toString(36)}`,
    });

    // Fotos por cor: cada PDF é uma passada demorada, então informo o
    // andamento a cada arquivo em vez de deixar a tela parada.
    const catalogos = [];
    const pdfs = arquivos.pdfs || [];
    for (const [i, f] of pdfs.entries()) {
      marcar(id, {
        etapa: `lendo fotos do catálogo ${i + 1} de ${pdfs.length} (${f.originalname})`,
        progresso: 10 + Math.round((70 * i) / Math.max(1, pdfs.length)),
      });
      const r = await importarCatalogoSamsonite(f.path, {
        pastaImagens: PASTA_IMAGENS,
        prefixo: `sam${Date.now().toString(36)}${i}`,
      });
      catalogos.push(r);
      avisos.push(...(r.avisos || []).map((a) => `${f.originalname}: ${a}`));
    }

    let relCruz = null;
    if (catalogos.length) {
      marcar(id, { etapa: 'casando as fotos com os produtos', progresso: 82 });
      const cruz = cruzarComFotos(produtos, catalogos);
      relCruz = cruz.relatorio;
      avisos.push(...cruz.avisos);
    }

    marcar(id, { etapa: 'gravando no banco', progresso: 90 });

    // Foto que o admin subiu à mão sobrevive à reimportação, igual à Maxprint.
    const manuais = await Produto.find({ marcaSlug: MARCA, imagemManual: { $ne: '' } })
      .select('codigo imagemManual').lean();
    const mapaManual = new Map(manuais.map((m) => [m.codigo, m.imagemManual]));

    const operacoes = produtos.map((p) => ({
      updateOne: {
        filter: { codigo: p.codigo, marcaSlug: MARCA },
        update: { $set: { ...p, marcaSlug: MARCA, imagemManual: mapaManual.get(p.codigo) || '', ativo: true } },
        upsert: true,
      },
    }));
    if (operacoes.length) await Produto.bulkWrite(operacoes, { ordered: false });

    // Só desativa o que é da Samsonite — a Maxprint não pode ser tocada aqui.
    const vivos = produtos.map((p) => p.codigo);
    await Produto.updateMany({ marcaSlug: MARCA, codigo: { $nin: vivos } }, { $set: { ativo: false } });

    const relatorio = {
      ...relBase,
      cruzamentoFotos: relCruz,
      desativados: await Produto.countDocuments({ marcaSlug: MARCA, ativo: false }),
    };

    await Importacao.create({
      tipo: 'samsonite',
      arquivos: [base.originalname, ...pdfs.map((f) => f.originalname)],
      usuario: opcoes.usuario,
      duracaoSegundos: Math.round((Date.now() - opcoes.inicio) / 1000),
      relatorio,
      avisos,
      erro: '',
    });

    marcar(id, { estado: 'pronto', etapa: 'concluído', progresso: 100, relatorio, avisos });
  } catch (e) {
    console.error('[import samsonite]', e);
    marcar(id, { estado: 'erro', etapa: 'falhou', erro: e.message });
    await Importacao.create({
      tipo: 'samsonite',
      arquivos: [],
      usuario: opcoes.usuario,
      duracaoSegundos: Math.round((Date.now() - opcoes.inicio) / 1000),
      relatorio: {},
      avisos: [],
      erro: e.message,
    }).catch(() => { /* o log já saiu no console */ });
  } finally {
    limpar([arquivos.base, ...(arquivos.pdfs || [])].filter(Boolean));
  }
}

router.post(
  '/samsonite',
  upload.fields([{ name: 'base', maxCount: 1 }, { name: 'pdfs', maxCount: 8 }]),
  async (req, res) => {
    const base = (req.files && req.files.base && req.files.base[0]) || null;
    const pdfs = (req.files && req.files.pdfs) || [];

    if (!base) {
      limpar(pdfs);
      return res.status(400).json({ erro: 'Escolha o arquivo HTML da base da Samsonite.' });
    }

    const id = novaTarefa();
    // Dispara e responde na hora: quem acompanha é o /samsonite/status/:id.
    rodarImportacaoSamsonite(id, { base, pdfs }, {
      usuario: req.session.usuario.usuario,
      inicio: Date.now(),
    });

    res.json({ ok: true, tarefa: id });
  }
);

/* ------------------------------------------------------------------ *
 * Estoque da Samsonite (planilha "Sortimento Produtos Wholesale")
 *
 * É a planilha que atualiza o saldo. Rápida (não tem PDF para rasterizar),
 * então roda na própria requisição, sem tarefa em segundo plano.
 * ------------------------------------------------------------------ */

const { importarEstoqueSamsonite } = require('../lib/importEstoqueSamsonite');

router.post('/samsonite/estoque', upload.array('arquivos', 4), async (req, res) => {
  const inicio = Date.now();
  const MARCA = 'samsonite';
  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ erro: 'Escolha a planilha de estoque da Samsonite.' });
    }

    const itens = [];
    const avisos = [];
    let relatorioBase = {};
    for (const f of req.files) {
      const r = importarEstoqueSamsonite(f.path);
      itens.push(...r.itens);
      avisos.push(...r.avisos.map((a) => `${f.originalname}: ${a}`));
      relatorioBase = r.relatorio;
    }

    // Quem já está no catálogo, e em que condição. Preciso saber de duas
    // coisas antes de gravar: se o item existe e se ele está em promoção.
    const existentes = await Produto.find({ marcaSlug: MARCA })
      .select('codigo emPromocao precoBase precoCheio descontoPromo').lean();
    const mapa = new Map(existentes.map((p) => [p.codigo, p]));

    let atualizados = 0, criados = 0, promoPreservada = 0;
    const operacoes = [];

    for (const it of itens) {
      const atual = mapa.get(it.codigo);

      // O preço da planilha é o CHEIO (ver lib/importEstoqueSamsonite.js).
      // Item em promoção mantém o preço promocional: deixar a planilha
      // sobrescrever apagaria o desconto sem ninguém notar.
      const emPromocao = !!(atual && atual.emPromocao);
      if (emPromocao) promoPreservada++;

      const campos = {
        marcaSlug: MARCA,
        codigo: it.codigo,
        codigoOriginal: it.codigoOriginal,
        subMarca: it.subMarca,
        categoria: it.subMarca,
        grupo: it.grupo,
        tipoProduto: it.tipoProduto,
        cor: it.cor,
        ncm: it.ncm,
        precoVarejo: it.precoVarejo,
        estoque: it.estoque,
        status: it.estoque > 0 ? 'DISPONIVEL' : 'SEM SALDO',
        ativo: true,
      };

      if (emPromocao) {
        // Só o preço de tabela acompanha a planilha; o que o cliente paga
        // continua sendo o promocional já gravado.
        campos.precoCheio = it.precoCheio || atual.precoCheio || 0;
      } else {
        campos.precoCheio = it.precoCheio;
        campos.precoBase = it.precoCheio;
      }

      if (!atual) {
        criados++;
        campos.nome = [it.grupo, it.tipoProduto].filter(Boolean).join(' ') || it.tipoProduto || it.grupo;
        campos.precoBase = it.precoCheio;
        campos.imagem = '';
        campos.grupoCores = [];
      } else {
        atualizados++;
      }

      operacoes.push({
        updateOne: {
          filter: { codigo: it.codigo, marcaSlug: MARCA },
          update: { $set: campos },
          upsert: true,
        },
      });
    }

    if (operacoes.length) await Produto.bulkWrite(operacoes, { ordered: false });

    // Item que sumiu da planilha: zero o saldo em vez de desativar. A
    // planilha é de sortimento, não de catálogo — sumir dela quer dizer "sem
    // saldo agora", não "produto acabou". Desativar apagaria do catálogo um
    // item que volta na semana seguinte.
    const vivos = itens.map((i) => i.codigo);
    const foraDaPlanilha = await Produto.updateMany(
      { marcaSlug: MARCA, codigo: { $nin: vivos }, estoque: { $gt: 0 } },
      { $set: { estoque: 0, status: 'SEM SALDO' } }
    );

    // Os grupos de cor precisam ser refeitos: itens novos entram nas linhas
    // que já existiam, e sem isso o card não mostraria a cor nova.
    const todos = await Produto.find({ marcaSlug: MARCA, ativo: true })
      .select('codigo subMarca grupo tipoProduto').lean();
    const porChave = new Map();
    for (const p of todos) {
      const chave = [p.subMarca, p.grupo, p.tipoProduto].join('|').toUpperCase();
      if (!porChave.has(chave)) porChave.set(chave, []);
      porChave.get(chave).push(p.codigo);
    }
    const opCores = [];
    let gruposDeCor = 0;
    for (const codigos of porChave.values()) {
      const grupo = codigos.length > 1 ? codigos : [];
      if (grupo.length) gruposDeCor++;
      for (const codigo of codigos) {
        opCores.push({ updateOne: { filter: { codigo, marcaSlug: MARCA }, update: { $set: { grupoCores: grupo } } } });
      }
    }
    if (opCores.length) await Produto.bulkWrite(opCores, { ordered: false });

    const relatorio = {
      ...relatorioBase,
      atualizados,
      criados,
      promoPreservada,
      zeradosPorSumirDaPlanilha: foraDaPlanilha.modifiedCount || 0,
      gruposDeCor,
      totalNoCatalogo: await Produto.countDocuments({ marcaSlug: MARCA, ativo: true }),
    };

    await Importacao.create({
      tipo: 'samsonite',
      arquivos: req.files.map((f) => f.originalname),
      usuario: req.session.usuario.usuario,
      duracaoSegundos: Math.round((Date.now() - inicio) / 1000),
      relatorio,
      avisos,
      erro: '',
    });

    limpar(req.files);
    res.json({ ok: true, relatorio, avisos });
  } catch (e) {
    console.error('[import estoque samsonite]', e);
    limpar(req.files);
    res.status(500).json({ erro: `Falhou ao ler a planilha de estoque: ${e.message}` });
  }
});

router.get('/samsonite/status/:id', (req, res) => {
  const t = tarefas.get(req.params.id);
  if (!t) return res.status(404).json({ erro: 'Importação não encontrada (o servidor pode ter reiniciado).' });
  res.json(t);
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
  // Por marca, para o painel conseguir mostrar cada aba separada.
  const porMarca = await Produto.aggregate([
    { $match: { ativo: true } },
    {
      $group: {
        _id: '$marcaSlug',
        produtos: { $sum: 1 },
        semFoto: { $sum: { $cond: [{ $and: [{ $eq: ['$imagem', ''] }, { $eq: ['$imagemManual', ''] }] }, 1, 0] } },
      },
    },
  ]);

  const produtos = await Produto.countDocuments({ ativo: true });
  const semFoto = await Produto.countDocuments({ ativo: true, imagem: '', imagemManual: '' });
  res.json({
    bases,
    contagem,
    produtos,
    semFoto,
    porMarca: porMarca.map((m) => ({ marca: m._id || 'maxprint', produtos: m.produtos, semFoto: m.semFoto })),
  });
});

/** Lista os produtos sem foto, para o admin resolver os que importam. */
router.get('/sem-foto', async (req, res) => {
  const filtro = { ativo: true, imagem: '', imagemManual: '' };
  if (req.query.marca) filtro.marcaSlug = String(req.query.marca).toLowerCase();

  const lista = await Produto.find(filtro)
    .select('codigo codigoOriginal nome categoria linhaProduto estoque marcaSlug subMarca cor')
    .sort({ estoque: -1 })
    .limit(500)
    .lean();
  res.json(lista);
});

module.exports = router;
