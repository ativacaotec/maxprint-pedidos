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
    Base.findOne({ marcaSlug: 'maxprint', tipo: 'preco' }).lean(),
    Base.findOne({ marcaSlug: 'maxprint', tipo: 'estoque' }).lean(),
    Base.findOne({ marcaSlug: 'maxprint', tipo: 'catalogo' }).lean(),
    Base.findOne({ marcaSlug: 'maxprint', tipo: 'catalogoModelos' }).lean(),
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

  // Conserto dos produtos anteriores à multimarca.
  //
  // Os produtos criados antes de existir o campo `marcaSlug` ficaram SEM ele.
  // O documento continua ativo no banco, mas nenhuma consulta por marca o
  // enxerga — nem o catálogo do cliente (`{marcaSlug:'maxprint'}`), nem a busca
  // do painel, nem o upsert daqui de baixo. Foi assim que a aba Maxprint
  // apareceu vazia com 453 produtos ativos no banco: eles não estavam
  // desativados, estavam invisíveis.
  //
  // Todo produto sem marca é da Maxprint: a Samsonite já nasceu com o campo
  // preenchido. Rodar de novo não faz nada, porque depois da primeira vez não
  // sobra documento sem o campo.
  const semMarca = await Produto.updateMany(
    { marcaSlug: { $in: [null, ''] } },
    { $set: { marcaSlug: MARCA } }
  );
  const adotados = semMarca.modifiedCount || semMarca.nModified || 0;
  if (adotados) console.log(`[recruzar] ${adotados} produto(s) antigos ganharam marcaSlug=${MARCA}`);

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
  //
  // Trava: cruzamento que não produziu NENHUM produto não desativa nada. Isso
  // só acontece quando uma das bases veio vazia ou ilegível, e nesse caso
  // apagar o catálogo inteiro é o pior desfecho possível — melhor manter o que
  // estava valendo e deixar o problema visível no relatório.
  const vivos = produtos.map((p) => p.codigo);
  if (vivos.length) {
    await Produto.updateMany({ marcaSlug: MARCA, codigo: { $nin: vivos } }, { $set: { ativo: false } });
  } else {
    relatorio.catalogoPreservado = true;
    relatorio.aviso = 'O cruzamento não gerou nenhum produto, então o catálogo anterior foi mantido '
      + 'como estava. Confira as bases de preço, estoque e catálogo.';
  }

  relatorio.desativados = await Produto.countDocuments({ marcaSlug: MARCA, ativo: false });
  relatorio.ativos = await Produto.countDocuments({ marcaSlug: MARCA, ativo: true });
  relatorio.adotados = adotados;
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

    const anterior = await Base.findOne({ marcaSlug: 'maxprint', tipo: 'catalogo' }).lean();
    const anteriorModelos = await Base.findOne({ marcaSlug: 'maxprint', tipo: 'catalogoModelos' }).lean();
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
      { marcaSlug: 'maxprint', tipo: 'catalogo' },
      { marcaSlug: 'maxprint', tipo: 'catalogo', itens: fichas, origem, atualizadoEm: new Date() },
      { upsert: true }
    );
    await Base.findOneAndUpdate(
      { marcaSlug: 'maxprint', tipo: 'catalogoModelos' },
      { marcaSlug: 'maxprint', tipo: 'catalogoModelos', itens: fichasModelo, atualizadoEm: new Date() },
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

    // A base guardada é a fonte do catálogo: enquanto uma nova não chega, a
    // última continua valendo. Por isso um arquivo que não rendeu nenhuma
    // linha NÃO substitui o que está gravado — senão bastaria subir a planilha
    // errada uma vez para o catálogo inteiro sumir. Recusa e explica.
    if (!junto.itens.length) {
      limpar(req.files);
      return res.status(400).json({
        erro: 'Nenhuma linha de estoque foi lida nesses arquivos, então nada foi alterado — '
          + 'a base anterior continua valendo. Confira se as planilhas são os "Mapa de chegadas" '
          + '(a tabela de preço vai no botão de preço).',
      });
    }

    await Base.findOneAndUpdate(
      { marcaSlug: 'maxprint', tipo: 'estoque' },
      {
        marcaSlug: 'maxprint',
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

    // Mesma proteção do estoque: base vazia não substitui a que está guardada.
    if (!mapa.size) {
      limpar(req.files);
      return res.status(400).json({
        erro: 'Nenhum preço foi lido nesse arquivo, então nada foi alterado — a tabela anterior '
          + 'continua valendo. Confira se é a "Tabela Maxprint" com as abas de categoria.',
      });
    }

    await Base.findOneAndUpdate(
      { marcaSlug: 'maxprint', tipo: 'preco' },
      { marcaSlug: 'maxprint', tipo: 'preco', itens: [...mapa.values()], origem: porArquivo, atualizadoEm: new Date() },
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

// O código vira nome de arquivo, então nada de barra, ponto-ponto e afins.
const codigoSeguro = (c) => String(c || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 40);

const uploadImagem = multer({
  storage: multer.diskStorage({
    destination: PASTA_IMAGENS,
    filename: (req, file, cb) => {
      let ext = (path.extname(file.originalname) || '').toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) ext = '.jpg';
      // O carimbo de tempo é o que faz a foto nova aparecer na hora: o /img é
      // servido com cache de 30 dias, e regravar o mesmo nome deixaria o
      // navegador mostrando a foto velha.
      cb(null, `manual-${codigoSeguro(req.params.codigo)}-${Date.now().toString(36)}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//i.test(file.mimetype)) return cb(null, true);
    cb(new Error('Envie uma imagem (JPG, PNG ou WEBP).'));
  },
});

router.post('/foto/:codigo', uploadImagem.single('imagem'), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Escolha uma imagem.' });
  // A marca vem por query (?marca=samsonite) porque o mesmo código pode, em
  // tese, existir em duas marcas — o índice do Produto é (marcaSlug, codigo).
  const marcaSlug = String(req.query.marca || 'maxprint').toLowerCase();
  const p = await Produto.findOneAndUpdate(
    { codigo: req.params.codigo, marcaSlug },
    // A foto anexada à mão passa a ser a boa, e a origem fica registrada para
    // a faxina de fotos repetidas não mexer nela nunca mais.
    { imagemManual: req.file.filename, imagemIlustrativa: false, fotoOrigem: `anexada por ${req.session.usuario.usuario}` },
    { new: true }
  ).lean();
  if (!p) {
    try { fs.unlinkSync(path.join(PASTA_IMAGENS, req.file.filename)); } catch (_) {}
    return res.status(404).json({ erro: 'Produto não encontrado.' });
  }
  res.json({ ok: true, imagem: req.file.filename, codigo: p.codigo, nome: p.nome });
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

/**
 * Importa (ou refaz) o catálogo da Samsonite.
 *
 * A BASE E OS PDFs FICAM GUARDADOS, e é isso que muda em relação ao que havia
 * antes. Regra que o Marcelo pediu para valer em toda marca: o que ele subiu
 * por último continua valendo até ele mandar substituir. Então:
 *
 *   - subiu base nova   → lê, grava como a base guardada e usa;
 *   - não subiu base    → usa a guardada, sem pedir arquivo nenhum;
 *   - subiu PDFs        → leem, substituem os guardados e valem;
 *   - não subiu PDFs    → valem os guardados.
 *
 * Com isso, "refazer o catálogo" vira um botão, e não uma reimportação. As
 * fotos, essas, vivem no banco por código e não dependem de arquivo nenhum.
 */
async function rodarImportacaoSamsonite(id, arquivos, opcoes) {
  const MARCA = 'samsonite';
  try {
    const base = arquivos.base;
    let produtos;
    let relBase;
    let avisos = [];
    let origemBase = [];

    if (base) {
      marcar(id, { etapa: 'lendo a base da Samsonite', progresso: 5 });
      const r = await importarSamsonite(base.path, {
        pastaImagens: PASTA_IMAGENS,
        prefixo: `sam${Date.now().toString(36)}`,
      });
      produtos = r.produtos;
      relBase = r.relatorio;
      avisos = r.avisos || [];
      origemBase = [{ arquivo: base.originalname, produtos: produtos.length }];
      await Base.findOneAndUpdate(
        { marcaSlug: MARCA, tipo: 'base' },
        { marcaSlug: MARCA, tipo: 'base', itens: produtos, origem: origemBase, atualizadoEm: new Date() },
        { upsert: true }
      );
    } else {
      marcar(id, { etapa: 'usando a base guardada da Samsonite', progresso: 5 });
      const guardada = await Base.findOne({ marcaSlug: MARCA, tipo: 'base' }).lean();
      if (!guardada || !(guardada.itens || []).length) {
        throw new Error('Não há base da Samsonite guardada. Suba o arquivo da base uma vez.');
      }
      produtos = guardada.itens;
      origemBase = guardada.origem || [];
      relBase = { totalValido: produtos.length, deBaseGuardada: true };
      avisos.push(`Base guardada de ${new Date(guardada.atualizadoEm).toLocaleString('pt-BR')}.`);
    }

    // Fotos por cor: cada PDF é uma passada demorada, então informo o
    // andamento a cada arquivo em vez de deixar a tela parada.
    let catalogos = [];
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

    if (pdfs.length) {
      await Base.findOneAndUpdate(
        { marcaSlug: MARCA, tipo: 'catalogo' },
        {
          marcaSlug: MARCA,
          tipo: 'catalogo',
          itens: catalogos,
          origem: pdfs.map((f) => ({ arquivo: f.originalname })),
          atualizadoEm: new Date(),
        },
        { upsert: true }
      );
    } else {
      // Sem PDF novo, valem as fichas guardadas. As imagens já estão no disco
      // desde a leitura original, então nada precisa ser extraído de novo.
      const guardado = await Base.findOne({ marcaSlug: MARCA, tipo: 'catalogo' }).lean();
      if (guardado && (guardado.itens || []).length) {
        catalogos = guardado.itens;
        avisos.push(`Fotos dos catálogos guardados em ${new Date(guardado.atualizadoEm).toLocaleString('pt-BR')}.`);
      }
    }

    let relCruz = null;
    if (catalogos.length) {
      marcar(id, { etapa: 'casando as fotos com os produtos', progresso: 82 });
      const cruz = cruzarComFotos(produtos, catalogos);
      relCruz = cruz.relatorio;
      avisos.push(...cruz.avisos);
    }

    marcar(id, { etapa: 'gravando no banco', progresso: 90 });

    // Fotos que já estão no catálogo sobrevivem à reimportação da base.
    //
    // O arquivo da Samsonite não traz foto: `importSamsonite` monta cada
    // produto com `imagem: ''`, e o `$set` abaixo gravava esse vazio por cima
    // do que já existia. Foi o que aconteceu em 29/07/2026 — a varredura das
    // lojas oficiais baixou 766 fotos às 20:01 e a reimportação da base às
    // 20:07 apagou todas, deixando os 1.546 produtos sem imagem de novo.
    //
    // Foto encontrada é trabalho de uma hora de varredura: ela fica no banco e
    // vale para o catálogo, o PDF e o Excel do pedido. Só é substituída quando
    // a importação traz uma foto de verdade no lugar (a dos PDFs do catálogo).
    const anteriores = await Produto.find({ marcaSlug: MARCA })
      .select('codigo imagem imagemManual fotoOrigem').lean();
    const mapaManual = new Map(
      anteriores.filter((a) => a.imagemManual).map((a) => [a.codigo, a.imagemManual])
    );
    const mapaFoto = new Map(
      anteriores.filter((a) => a.imagem).map((a) => [a.codigo, { imagem: a.imagem, fotoOrigem: a.fotoOrigem || '' }])
    );

    let fotosPreservadas = 0;
    const operacoes = produtos.map((p) => {
      const campos = { ...p, marcaSlug: MARCA, imagemManual: mapaManual.get(p.codigo) || '', ativo: true };
      const guardada = mapaFoto.get(p.codigo);
      if (!campos.imagem && guardada) {
        campos.imagem = guardada.imagem;
        campos.fotoOrigem = guardada.fotoOrigem;
        fotosPreservadas++;
      }
      return {
        updateOne: {
          filter: { codigo: p.codigo, marcaSlug: MARCA },
          update: { $set: campos },
          upsert: true,
        },
      };
    });
    if (operacoes.length) await Produto.bulkWrite(operacoes, { ordered: false });

    // Só desativa o que é da Samsonite — a Maxprint não pode ser tocada aqui.
    const vivos = produtos.map((p) => p.codigo);
    await Produto.updateMany({ marcaSlug: MARCA, codigo: { $nin: vivos } }, { $set: { ativo: false } });

    // O saldo da última planilha de sortimento volta por cima da base.
    //
    // A base carrega o estoque do dia em que ela foi gerada. Sem isto,
    // remontar o catálogo devolveria saldo velho e apagaria a atualização de
    // estoque mais recente — o cliente veria peça que já saiu.
    let relEstoque = null;
    const estoqueGuardado = await Base.findOne({ marcaSlug: MARCA, tipo: 'estoque' }).lean();
    if (estoqueGuardado && (estoqueGuardado.itens || []).length) {
      marcar(id, { etapa: 'reaplicando o saldo da última planilha de estoque', progresso: 95 });
      relEstoque = await aplicarEstoqueSamsonite(estoqueGuardado.itens);
      avisos.push(`Saldo da planilha de estoque de ${new Date(estoqueGuardado.atualizadoEm).toLocaleString('pt-BR')} reaplicado.`);
    }

    const relatorio = {
      ...relBase,
      cruzamentoFotos: relCruz,
      estoqueReaplicado: relEstoque,
      fotosPreservadas,
      desativados: await Produto.countDocuments({ marcaSlug: MARCA, ativo: false }),
    };

    await Importacao.create({
      tipo: 'samsonite',
      arquivos: base
        ? [base.originalname, ...pdfs.map((f) => f.originalname)]
        : ['(bases guardadas)', ...pdfs.map((f) => f.originalname)],
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

    // Sem base nova, vale a guardada — desde que exista. Só na primeira vez o
    // arquivo é obrigatório; daí em diante subir de novo é escolha, não regra.
    if (!base) {
      const guardada = await Base.findOne({ marcaSlug: 'samsonite', tipo: 'base' }).select('_id').lean();
      if (!guardada) {
        limpar(pdfs);
        return res.status(400).json({
          erro: 'Ainda não há base da Samsonite guardada. Escolha o arquivo HTML da base nesta primeira vez.',
        });
      }
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
 * Yin's — o catálogo em PDF É a base
 *
 * Aqui não existe planilha nem HTML da fábrica: código, descrição, custo,
 * imposto e situação de estoque saem todos do PDF. Cada catálogo enviado vira
 * uma "tabela" (Papelaria, Mochilas, Volta às Aulas...), que é a categoria do
 * produto no menu do cliente; a seção do sumário de cada catálogo vira a linha.
 *
 * Roda em segundo plano e usa a mesma lista de tarefas das outras marcas: um
 * catálogo de 485 páginas leva alguns minutos, e o Nginx corta conexão ociosa
 * bem antes disso.
 * ------------------------------------------------------------------ */

const { importarCatalogoYins } = require('../lib/importCatalogoYins');

/** Nome da tabela a partir do arquivo: "TABELA_YINS_KIDS_2026 2.pdf" -> "Yins Kids". */
function tituloDoArquivo(nomeArquivo) {
  return String(nomeArquivo || '')
    .replace(/\.pdf$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\bcompress(ed|ado)\b/gi, '')
    .replace(/\bcompactado\b/gi, '')
    .replace(/\btabela\b/gi, '')
    .replace(/\b\d{1,2}\b(?=\s*$)/, '')
    .replace(/\s+/g, ' ')
    .trim() || 'Catálogo';
}

async function rodarImportacaoYins(id, arquivos, opcoes) {
  const MARCA = 'yins';
  const inicio = Date.now();
  try {
    marcar(id, { etapa: 'conferindo as ferramentas de leitura de PDF', progresso: 1 });

    // Uma foto só pode ser de um código. O mapa é compartilhado entre os
    // catálogos: se a mesma imagem aparece em dois, nenhum dos dois fica com
    // ela — foto errada é pior que foto faltando.
    const porConteudo = new Map();
    const todos = [];
    const avisos = [];
    const porCatalogo = [];

    for (const [i, f] of arquivos.entries()) {
      const titulo = opcoes.titulos[i] || tituloDoArquivo(f.originalname);
      marcar(id, {
        etapa: `lendo ${titulo} (${i + 1} de ${arquivos.length})`,
        progresso: 2 + Math.round((90 * i) / Math.max(1, arquivos.length)),
      });
      const r = await importarCatalogoYins(f.path, {
        pastaImagens: PASTA_IMAGENS,
        prefixo: 'yins',
        titulo,
        porConteudo,
        aoAndar: (p) => marcar(id, {
          etapa: `${titulo}: página ${p.pagina} de ${p.total}, ${p.produtos} itens`,
          progresso: 2 + Math.round((90 * (i + p.pagina / Math.max(1, p.total))) / Math.max(1, arquivos.length)),
        }),
      });
      todos.push(...r.produtos);
      avisos.push(...r.avisos.map((a) => `${titulo}: ${a}`));
      porCatalogo.push(r.relatorio);
    }

    marcar(id, { etapa: 'gravando no catálogo', progresso: 94 });

    // Subir um catálogo NÃO apaga os outros.
    //
    // São sete tabelas, mais de 150 MB de PDF. Ninguém sobe tudo de uma vez, e
    // quando chega a Papelaria nova as outras seis continuam valendo. Então a
    // base guardada é atualizada por TABELA: sai o que era daquela tabela,
    // entra o que acabou de ser lido, e o resto fica onde está.
    const guardada = await Base.findOne({ marcaSlug: MARCA, tipo: 'base' }).lean();
    const anteriores = (guardada && guardada.itens) || [];
    const titulosLidos = new Set(porCatalogo.map((r) => r.catalogo));
    const mantidos = anteriores.filter((p) => !titulosLidos.has(p.catalogo));
    // Código que voltou noutra tabela pertence à leitura nova.
    const novos = new Set(todos.map((p) => p.codigo));
    const base = [...mantidos.filter((p) => !novos.has(p.codigo)), ...todos];

    const origemAntes = ((guardada && guardada.origem) || []).filter((o) => !titulosLidos.has(o.titulo));
    await Base.findOneAndUpdate(
      { marcaSlug: MARCA, tipo: 'base' },
      {
        marcaSlug: MARCA, tipo: 'base', itens: base,
        origem: [
          ...origemAntes,
          ...arquivos.map((f, i) => ({
            arquivo: f.originalname,
            titulo: opcoes.titulos[i] || tituloDoArquivo(f.originalname),
            itens: todos.filter((p) => p.catalogo === (opcoes.titulos[i] || tituloDoArquivo(f.originalname))).length,
            em: new Date(),
          })),
        ],
        atualizadoEm: new Date(),
      },
      { upsert: true }
    );

    const relatorio = await gravarProdutosYins(base, avisos);
    relatorio.lidosAgora = todos.length;
    relatorio.mantidosDeAntes = base.length - todos.length;
    relatorio.porCatalogo = porCatalogo;

    await Importacao.create({
      tipo: 'yins',
      arquivos: arquivos.map((f) => f.originalname),
      usuario: opcoes.usuario,
      duracaoSegundos: Math.round((Date.now() - inicio) / 1000),
      relatorio,
      avisos: avisos.slice(0, 300),
      erro: '',
    });

    marcar(id, {
      estado: 'pronto', etapa: 'concluído', progresso: 100,
      relatorio, avisos: avisos.slice(0, 60),
    });
  } catch (e) {
    console.error('[import yins]', e);
    marcar(id, { estado: 'erro', etapa: 'falhou', erro: e.message });
    await Importacao.create({
      tipo: 'yins', arquivos: arquivos.map((f) => f.originalname),
      usuario: opcoes.usuario,
      duracaoSegundos: Math.round((Date.now() - inicio) / 1000),
      relatorio: {}, avisos: [], erro: e.message,
    }).catch(() => {});
  } finally {
    limpar(arquivos);
  }
}

/**
 * Grava os itens lidos como produtos da Yin's.
 *
 * `categoria` recebe o nome do catálogo e `linhaProduto` a seção do sumário:
 * assim o menu lateral do cliente, que já sabe trabalhar com categoria e
 * linha, mostra a Yin's sem precisar de tela nova.
 */
async function gravarProdutosYins(itens, avisos) {
  const MARCA = 'yins';

  // Foto anexada à mão sobrevive a qualquer reimportação.
  const anteriores = await Produto.find({ marcaSlug: MARCA }).select('codigo imagemManual').lean();
  const mapaManual = new Map(anteriores.filter((a) => a.imagemManual).map((a) => [a.codigo, a.imagemManual]));

  const operacoes = itens.map((p) => ({
    updateOne: {
      filter: { codigo: p.codigo, marcaSlug: MARCA },
      update: {
        $set: {
          marcaSlug: MARCA,
          codigo: p.codigo,
          codigoOriginal: p.codigoOriginal,
          ref: p.ref,
          nome: p.nome || p.ref,
          descricaoEstoque: p.descricao,
          categoria: p.catalogo,
          linhaProduto: p.segmento,
          catalogoNome: p.catalogo,
          segmento: p.segmento,
          cor: p.cor,
          precoBase: p.preco,
          precoCaixa: p.precoCaixa,
          condicaoCaixa: p.condicaoCaixa,
          ipi: p.ipi,
          temST: p.st,
          unidadeVenda: p.unidadeVenda,
          embalagem: p.embalagem,
          caixaMasterTexto: p.caixaMaster,
          pedidoMinimo: p.pedidoMinimo,
          situacaoEstoque: p.situacao,
          status: p.situacao,
          lancamento: p.lancamento,
          ean: p.ean,
          ncm: p.ncm,
          paginaCatalogo: p.pagina,
          estoque: 0,
          previstoTotal: 0,
          chegadas: [],
          imagem: p.imagem,
          imagemManual: mapaManual.get(p.codigo) || '',
          imagemIlustrativa: false,
          fotoOrigem: `catálogo ${p.catalogo}, p.${p.pagina}`,
          ativo: true,
        },
      },
      upsert: true,
    },
  }));

  if (operacoes.length) await Produto.bulkWrite(operacoes, { ordered: false });

  // Item que saiu dos catálogos sai do ar, mas só quando a leitura produziu
  // alguma coisa — leitura vazia não pode apagar o catálogo inteiro.
  const vivos = itens.map((p) => p.codigo);
  let desativados = 0;
  if (vivos.length) {
    const r = await Produto.updateMany(
      { marcaSlug: MARCA, codigo: { $nin: vivos } }, { $set: { ativo: false } });
    desativados = r.modifiedCount || r.nModified || 0;
  } else {
    avisos.push('A leitura não gerou nenhum item; o catálogo anterior foi mantido como estava.');
  }

  const porSituacao = {};
  for (const p of itens) porSituacao[p.situacao || '(sem tarja)'] = (porSituacao[p.situacao || '(sem tarja)'] || 0) + 1;

  return {
    total: itens.length,
    comFoto: itens.filter((p) => p.imagem).length,
    semFoto: itens.filter((p) => !p.imagem).length,
    semPreco: itens.filter((p) => !p.preco).length,
    porSituacao,
    catalogos: [...new Set(itens.map((p) => p.catalogo))].length,
    segmentos: [...new Set(itens.map((p) => p.segmento))].length,
    desativados,
    ativos: await Produto.countDocuments({ marcaSlug: 'yins', ativo: true }),
  };
}

router.post('/yins', upload.array('pdfs', 12), async (req, res) => {
  const arquivos = req.files || [];
  if (!arquivos.length) return res.status(400).json({ erro: 'Escolha pelo menos um catálogo em PDF.' });

  let titulos = [];
  try { titulos = JSON.parse(req.body.titulos || '[]'); } catch (_) { titulos = []; }

  const id = novaTarefa();
  rodarImportacaoYins(id, arquivos, {
    usuario: req.session.usuario.usuario,
    titulos,
  });
  res.json({ ok: true, tarefa: id });
});

/** Refaz o catálogo da Yin's com os itens já lidos, sem reler PDF nenhum. */
router.post('/yins/recruzar', async (req, res) => {
  try {
    const guardada = await Base.findOne({ marcaSlug: 'yins', tipo: 'base' }).lean();
    if (!guardada || !(guardada.itens || []).length) {
      return res.status(400).json({ erro: 'Não há catálogo da Yin\'s guardado ainda. Suba os PDFs uma vez.' });
    }
    const avisos = [];
    const relatorio = await gravarProdutosYins(guardada.itens, avisos);
    res.json({ ok: true, relatorio, avisos });
  } catch (e) {
    console.error('[yins recruzar]', e);
    res.status(500).json({ erro: `Não consegui refazer o catálogo da Yin's: ${e.message}` });
  }
});

/**
 * Refaz o catálogo da Samsonite com a base e os PDFs que já estão guardados.
 *
 * Mesma ideia do botão da Maxprint: nenhuma planilha é pedida, nada é
 * substituído. Serve para quando o catálogo precisa ser remontado — depois de
 * uma faxina de fotos, de um ajuste no cruzamento, ou simplesmente porque
 * alguma coisa saiu torta e reimportar seria caro.
 */
router.post('/samsonite/recruzar', async (req, res) => {
  const guardada = await Base.findOne({ marcaSlug: 'samsonite', tipo: 'base' }).select('_id').lean();
  if (!guardada) {
    return res.status(400).json({
      erro: 'Não há base da Samsonite guardada ainda. Suba o arquivo da base uma vez e o botão passa a funcionar.',
    });
  }
  const id = novaTarefa();
  rodarImportacaoSamsonite(id, { base: null, pdfs: [] }, {
    usuario: req.session.usuario.usuario,
    inicio: Date.now(),
  });
  res.json({ ok: true, tarefa: id });
});

/* ------------------------------------------------------------------ *
 * Estoque da Samsonite (planilha "Sortimento Produtos Wholesale")
 *
 * É a planilha que atualiza o saldo. Rápida (não tem PDF para rasterizar),
 * então roda na própria requisição, sem tarefa em segundo plano.
 * ------------------------------------------------------------------ */

const { importarEstoqueSamsonite } = require('../lib/importEstoqueSamsonite');

/**
 * Aplica no catálogo os itens da planilha de sortimento da Samsonite.
 *
 * Está numa função à parte porque roda em dois momentos: quando a planilha
 * chega, e de novo quando o catálogo é remontado a partir da base guardada —
 * senão o "refazer catálogo" devolveria os saldos velhos da base, apagando a
 * atualização de estoque mais recente sem ninguém pedir.
 */
async function aplicarEstoqueSamsonite(itens) {
  const MARCA = 'samsonite';
  {
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

    return {
      atualizados,
      criados,
      promoPreservada,
      zeradosPorSumirDaPlanilha: foraDaPlanilha.modifiedCount || 0,
      gruposDeCor,
      totalNoCatalogo: await Produto.countDocuments({ marcaSlug: MARCA, ativo: true }),
    };
  }
}

router.post('/samsonite/estoque', upload.array('arquivos', 4), async (req, res) => {
  const inicio = Date.now();
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

    // A planilha fica guardada, como toda base: é ela que devolve o saldo
    // certo quando o catálogo é remontado sem reimportar nada.
    await Base.findOneAndUpdate(
      { marcaSlug: 'samsonite', tipo: 'estoque' },
      {
        marcaSlug: 'samsonite',
        tipo: 'estoque',
        itens,
        origem: req.files.map((f) => ({ arquivo: f.originalname })),
        atualizadoEm: new Date(),
      },
      { upsert: true }
    );

    const relatorio = { ...relatorioBase, ...(await aplicarEstoqueSamsonite(itens)) };

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

/* ------------------------------------------------------------------ *
 * Buscador de fotos nas lojas oficiais da Samsonite
 *
 * Roda em segundo plano e usa a MESMA lista de tarefas da importação, então
 * o painel acompanha pelo mesmo /samsonite/status/:id.
 * ------------------------------------------------------------------ */

const { buscarFotosSamsonite } = require('../lib/buscarFotosSamsonite');

async function rodarBuscaDeFotos(id, opcoes) {
  const MARCA = 'samsonite';
  let gravadas = 0;
  try {
    marcar(id, { etapa: 'vendo quem está sem foto', progresso: 2 });

    // Só quem realmente precisa: foto do catálogo em PDF e foto anexada à mão
    // pelo admin têm prioridade e não são tocadas.
    const filtro = { marcaSlug: MARCA, ativo: true, imagem: '', imagemManual: '' };
    if (opcoes.soComSaldo) filtro.estoque = { $gt: 0 };

    const semFoto = await Produto.find(filtro).select('codigo codigoOriginal nome').lean();
    if (!semFoto.length) {
      marcar(id, { estado: 'pronto', etapa: 'nada a fazer', progresso: 100,
        relatorio: { procurados: 0, fotosBaixadas: 0 }, avisos: ['Todos os produtos já têm foto.'] });
      return;
    }

    const { resultados, relatorio, avisos } = await buscarFotosSamsonite(semFoto, {
      pastaImagens: PASTA_IMAGENS,
      prefixo: 'samweb',
      pausaMs: opcoes.pausaMs,
      aoAndar: (p) => {
        // O progresso é estimado: não dá para saber quantas páginas a loja tem
        // antes de ler o sitemap. Prefiro uma barra que anda a uma barra parada.
        const prog = Math.min(92, 5 + Math.round((p.achados / Math.max(1, semFoto.length)) * 80));
        marcar(id, { etapa: p.etapa, progresso: prog });
      },
      // Cada foto é gravada no catálogo assim que fica pronta, e não só no fim.
      // A varredura leva de 30 a 60 minutos: se o servidor reiniciar no meio,
      // tudo que já foi encontrado até ali continua valendo, e a próxima busca
      // começa menor, porque só procura quem ainda está sem foto.
      // Quando a mesma foto aparece de novo em outro código, a que já tinha
      // sido gravada volta atrás. Os dois ficam sem foto, e o Marcelo anexa a
      // certa pelo catálogo.
      aoDescartar: async (codigo) => {
        await Produto.updateOne(
          { codigo, marcaSlug: MARCA },
          { $set: { imagem: '', imagemIlustrativa: false, fotoOrigem: '' } }
        );
        if (gravadas > 0) gravadas--;
        marcar(id, { fotosGravadas: gravadas });
      },
      aoBaixar: async (r) => {
        await Produto.updateOne(
          { codigo: r.codigo, marcaSlug: MARCA },
          { $set: { imagem: r.arquivo, imagemIlustrativa: false, fotoOrigem: r.origem } }
        );
        gravadas++;
        marcar(id, { fotosGravadas: gravadas });
      },
    });

    marcar(id, { etapa: 'gravando as fotos no catálogo', progresso: 95 });

    const operacoes = resultados.map((r) => ({
      updateOne: {
        filter: { codigo: r.codigo, marcaSlug: MARCA },
        update: { $set: { imagem: r.arquivo, imagemIlustrativa: false, fotoOrigem: r.origem } },
      },
    }));
    if (operacoes.length) await Produto.bulkWrite(operacoes, { ordered: false });

    const relatorioFinal = {
      ...relatorio,
      fotosGravadas: gravadas,
      aindaSemFoto: await Produto.countDocuments({ marcaSlug: MARCA, ativo: true, imagem: '', imagemManual: '' }),
    };

    await Importacao.create({
      tipo: 'samsonite',
      arquivos: ['(busca de fotos nas lojas oficiais)'],
      usuario: opcoes.usuario,
      duracaoSegundos: Math.round((Date.now() - opcoes.inicio) / 1000),
      relatorio: relatorioFinal,
      avisos,
      erro: '',
    });

    marcar(id, { estado: 'pronto', etapa: 'concluído', progresso: 100, relatorio: relatorioFinal, avisos });
  } catch (e) {
    console.error('[busca fotos samsonite]', e);
    marcar(id, { estado: 'erro', etapa: 'falhou', erro: e.message });
  }
}

router.post('/samsonite/fotos', async (req, res) => {
  const id = novaTarefa();
  rodarBuscaDeFotos(id, {
    usuario: req.session.usuario.usuario,
    inicio: Date.now(),
    soComSaldo: String(req.body.soComSaldo || 'nao') === 'sim',
    // Intervalo entre páginas. Abaixo de 800ms começa a parecer ataque; o
    // padrão do buscador (1200ms) é o que eu recomendo deixar.
    pausaMs: Math.max(800, Number(req.body.pausaMs) || 1200),
  });
  res.json({ ok: true, tarefa: id });
});

router.get('/samsonite/status/:id', (req, res) => {
  const t = tarefas.get(req.params.id);
  if (!t) return res.status(404).json({ erro: 'Importação não encontrada (o servidor pode ter reiniciado).' });
  res.json(t);
});

/* ------------------------------------------------------------------ *
 * Faxina das fotos repetidas
 *
 * Conserta o estrago que a versão antiga do buscador deixou no banco: a
 * página de UMA cor escrevia também os SKUs das cores irmãs, e a mesma foto
 * foi gravada em todos eles. No catálogo do cliente isso aparece como três
 * mochilas com a foto da mesma cor, com o nome da cor certo embaixo.
 *
 * A assinatura é UMA só: a mesma imagem, byte a byte, em mais de um código.
 * Cobre os dois casos — a página inteira do catálogo em PDF usada como
 * ilustração de vários itens, e a foto de uma cor gravada em arquivos de nomes
 * diferentes para várias cores.
 *
 * Foto anexada à mão pelo admin não é tocada: aquela foi conferida por gente.
 * A suspeita é apagada do produto, não do disco — a próxima busca regrava por
 * cima com o mesmo nome de arquivo.
 * ------------------------------------------------------------------ */

const crypto = require('crypto');

// Impressão digital do arquivo de imagem. É por CONTEÚDO, e não pelo nome nem
// pela página de origem.
//
// A primeira versão desta faxina agrupava por página de origem, porque o
// buscador antigo carimbava a foto de uma página em todos os códigos que
// apareciam nela. Com o buscador consertado isso deixou de valer: uma mesma
// página da loja pode, legitimamente, dar foto DIFERENTE para dois códigos —
// e agrupar por página apagaria foto certa. Conferido em produção: de três
// pares suspeitos pela regra antiga, dois tinham fotos diferentes.
//
// Byte a byte não erra: se dois códigos têm o mesmo arquivo, é a mesma foto.
const cacheHash = new Map();
function digitalDaImagem(nome) {
  if (!nome) return '';
  if (cacheHash.has(nome)) return cacheHash.get(nome);
  let h = '';
  try {
    h = crypto.createHash('sha1').update(fs.readFileSync(path.join(PASTA_IMAGENS, nome))).digest('hex');
  } catch (_) { h = 'arquivo-sumiu:' + nome; }
  cacheHash.set(nome, h);
  return h;
}

router.post('/fotos/revisar', async (req, res) => {
  try {
    const marcaSlug = String(req.query.marca || req.body.marca || 'samsonite').toLowerCase();
    const aplicar = String(req.body.aplicar || 'sim') !== 'nao';

    // A foto de PÁGINA do catálogo (`imagemPagina`) é, por desenho, uma só para
    // todos os itens daquela página — e sai na tela com o aviso "foto
    // ilustrativa da linha". Ela repete, mas repete avisando. Por isso entra
    // numa conta à parte, e só sai se você pedir.
    const incluirPagina = String(req.body.incluirPagina || 'nao') === 'sim';

    const produtos = await Produto.find({
      marcaSlug,
      $or: [{ imagem: { $ne: '' } }, { imagemPagina: { $ne: '' } }],
    }).select('codigo codigoOriginal nome cor imagem imagemPagina imagemManual fotoOrigem').lean();

    const porConteudo = new Map();
    const comPaginaIlustrativa = [];
    for (const p of produtos) {
      if (p.imagemManual) continue;
      if (p.imagemPagina) comPaginaIlustrativa.push(p);
      if (!p.imagem) continue;
      const chave = digitalDaImagem(p.imagem);
      if (!chave) continue;
      if (!porConteudo.has(chave)) porConteudo.set(chave, []);
      porConteudo.get(chave).push(p);
    }

    const suspeitos = new Map(); // codigo -> motivo
    const grupos = [];
    const marcarGrupo = (lista, motivo, chave) => {
      if (lista.length < 2) return;
      grupos.push({ motivo, chave, codigos: lista.map((p) => p.codigoOriginal || p.codigo) });
      lista.forEach((p) => suspeitos.set(p.codigo, motivo));
    };
    for (const [chave, lista] of porConteudo) {
      marcarGrupo(lista, 'a mesma foto, byte a byte', lista[0].imagem);
    }

    let limpos = 0;
    let paginasLimpas = 0;
    if (aplicar && suspeitos.size) {
      const r = await Produto.updateMany(
        { marcaSlug, codigo: { $in: [...suspeitos.keys()] }, imagemManual: '' },
        { $set: { imagem: '', imagemIlustrativa: false, fotoOrigem: '' } }
      );
      limpos = r.modifiedCount || r.nModified || 0;
    }
    if (aplicar && incluirPagina && comPaginaIlustrativa.length) {
      const r = await Produto.updateMany(
        { marcaSlug, codigo: { $in: comPaginaIlustrativa.map((p) => p.codigo) }, imagemManual: '' },
        { $set: { imagemPagina: '', imagemIlustrativa: false } }
      );
      paginasLimpas = r.modifiedCount || r.nModified || 0;
    }

    res.json({
      ok: true,
      relatorio: {
        marca: marcaSlug,
        comFoto: produtos.length,
        gruposRepetidos: grupos.length,
        produtosSuspeitos: suspeitos.size,
        comPaginaIlustrativa: comPaginaIlustrativa.length,
        fotosLimpas: limpos,
        paginasLimpas,
        aplicado: aplicar,
        incluiuPagina: incluirPagina,
        semFotoAgora: await Produto.countDocuments({
          marcaSlug, ativo: true, imagem: '', imagemManual: '', imagemPagina: '',
        }),
      },
      amostra: grupos.slice(0, 15),
    });
  } catch (e) {
    console.error('[revisar fotos]', e);
    res.status(500).json({ erro: `Não consegui revisar as fotos: ${e.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * Refazer o cruzamento da Maxprint, sem reenviar arquivo
 *
 * As três bases da Maxprint (preço, estoque e catálogo) ficam guardadas no
 * banco e continuam valendo enquanto uma versão nova não chega. O cruzamento
 * que transforma as três em produtos do catálogo, porém, só rodava dentro de
 * uma importação — então, se o catálogo esvaziasse por qualquer motivo, o
 * único jeito de trazer de volta era reenviar uma planilha que o sistema já
 * tinha guardada.
 *
 * Foi o que aconteceu em 29/07/2026: os 392 produtos da Maxprint ficaram
 * inativos e a aba do cliente abriu vazia, com as três bases intactas.
 *
 * Este botão não recebe arquivo e não altera nenhuma base: só reexecuta o
 * cruzamento do que já está gravado. Rodar duas vezes seguidas dá o mesmo
 * resultado.
 * ------------------------------------------------------------------ */

router.post('/recruzar', async (req, res) => {
  const inicio = Date.now();
  try {
    const [preco, estoque] = await Promise.all([
      Base.findOne({ marcaSlug: 'maxprint', tipo: 'preco' }).select('itens').lean(),
      Base.findOne({ marcaSlug: 'maxprint', tipo: 'estoque' }).select('itens').lean(),
    ]);
    const nPreco = (preco?.itens || []).length;
    const nEstoque = (estoque?.itens || []).length;

    if (!nPreco || !nEstoque) {
      return res.status(400).json({
        erro: 'Não dá para refazer o cruzamento: '
          + (!nPreco ? 'a base de PREÇO está vazia. ' : '')
          + (!nEstoque ? 'a base de ESTOQUE está vazia. ' : '')
          + 'Importe essa base primeiro.',
      });
    }

    const relatorio = await recruzar();
    await registrar('recruzamento', req, inicio, relatorio, []);
    res.json({ ok: true, relatorio });
  } catch (e) {
    console.error('[recruzar]', e);
    await registrar('recruzamento', req, inicio, {}, [], e.message);
    res.status(500).json({ erro: `Falhou ao refazer o cruzamento: ${e.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * Histórico e situação das bases
 * ------------------------------------------------------------------ */

router.get('/historico', async (req, res) => {
  const lista = await Importacao.find().sort({ createdAt: -1 }).limit(40).lean();
  res.json(lista);
});

router.get('/situacao', async (req, res) => {
  const guardadas = await Base.find().select('marcaSlug tipo origem atualizadoEm itens').lean();
  // `bases` e `contagem` continuam existindo com o formato antigo (a aba da
  // Maxprint do painel lê deles). `basesPorMarca` é o formato novo, que a
  // Samsonite e a próxima marca usam.
  const bases = guardadas
    .filter((b) => (b.marcaSlug || 'maxprint') === 'maxprint')
    .map(({ itens, ...resto }) => resto);
  const contagem = {};
  const basesPorMarca = {};
  for (const b of guardadas) {
    const marca = b.marcaSlug || 'maxprint';
    if (marca === 'maxprint') contagem[b.tipo] = (b.itens || []).length;
    (basesPorMarca[marca] = basesPorMarca[marca] || []).push({
      tipo: b.tipo,
      itens: (b.itens || []).length,
      origem: b.origem || [],
      atualizadoEm: b.atualizadoEm,
    });
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
    basesPorMarca,
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
