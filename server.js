'use strict';

require('dotenv').config();

/**
 * O VPS roda Node 20, que ainda não tem Promise.withResolvers — usado pelo
 * pdfjs-dist na leitura dos catálogos em PDF. Sem isto, a importação de
 * catálogo quebra lá e funciona aqui, que é o pior tipo de diferença.
 *
 * Foi adicionado direto no servidor em 28/07 e trazido para o código depois,
 * senão a próxima publicação o apagaria sem ninguém notar.
 */
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

const path = require('path');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const compression = require('compression');

const Config = require('./models/Config');
const { requireLogin } = require('./middleware/auth');

const rotasAuth = require('./routes/auth');
const rotasCatalogo = require('./routes/catalogo');
const rotasPedidos = require('./routes/pedidos');
const rotasAdmin = require('./routes/admin');
const rotasImportacao = require('./routes/importacao');
const rotasMarcas = require('./routes/marcas');

const PORTA = Number(process.env.PORT || 3001);
// Escuta só no loopback: quem fala com a internet é o Nginx. Sem isso o
// aplicativo fica acessível por IP:porta, driblando o HTTPS.
const HOST = process.env.HOST || '127.0.0.1';
const MONGO = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/maxprint_pedidos';

const app = express();
app.set('trust proxy', 1); // atrás do Nginx
app.use(compression());
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    name: 'maxprint.sid',
    secret: process.env.SESSION_SECRET || 'troque-isso-no-env',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGO, collectionName: 'sessoes' }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 12,
      httpOnly: true,
      sameSite: 'lax',
      secure: String(process.env.COOKIE_SEGURO || 'nao') === 'sim',
    },
  })
);

// Imagens dos produtos e logos. Cache longo: o nome do arquivo muda a cada
// importação, então não há risco de o navegador servir foto velha.
app.use('/img', express.static(path.join(__dirname, 'public', 'img'), { maxAge: '30d' }));
app.use('/logos', express.static(path.join(__dirname, 'public', 'logos'), { maxAge: '7d' }));
app.use('/estatico', express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

/* ----------------------------- páginas ----------------------------- */

app.get('/', (req, res) => {
  const u = req.session && req.session.usuario;
  if (!u) return res.redirect('/login');
  return res.redirect(u.perfil === 'cliente' ? '/catalogo' : '/painel');
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/catalogo', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'catalogo.html'));
});

app.get('/painel', requireLogin, (req, res) => {
  if (req.session.usuario.perfil === 'cliente') return res.redirect('/catalogo');
  res.sendFile(path.join(__dirname, 'views', 'painel.html'));
});

/* ------------------------------- API ------------------------------- */

app.use('/api/auth', rotasAuth);
app.use('/api/catalogo', rotasCatalogo);
app.use('/api/pedidos', rotasPedidos);
app.use('/api/admin', rotasAdmin);
app.use('/api/importacao', rotasImportacao);
app.use('/api/marcas', rotasMarcas);

app.get('/api/saude', (req, res) => {
  res.json({ ok: true, banco: mongoose.connection.readyState === 1, versao: require('./package.json').version });
});

app.use((req, res) => res.status(404).json({ erro: 'Endereço não encontrado.' }));

app.use((err, req, res, next) => {
  console.error('[erro]', err);
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ erro: 'Arquivo grande demais.' });
  }
  res.status(500).json({ erro: 'Deu problema aqui no servidor. Tente de novo.' });
});

/* ----------------------------- partida ----------------------------- */

/**
 * As bases guardadas passaram a ser POR MARCA.
 *
 * O índice antigo era único só no `tipo`, de quando só a Maxprint guardava
 * base. Com a Samsonite guardando a dela (e a Yins a caminho), esse índice
 * recusaria a segunda marca com erro de chave duplicada — e a importação
 * falharia sem motivo visível. Aqui o índice velho sai, os documentos que
 * ficaram sem marca são adotados pela Maxprint (eram todos dela) e o índice
 * novo, (marcaSlug, tipo), entra.
 *
 * Roda toda vez que o servidor sobe e não faz nada depois da primeira.
 */
async function ajustarBasesPorMarca() {
  // Só faz sentido com banco de verdade do outro lado. No servidor de teste o
  // mongoose está de mentira e não existe `db`: chamar a coleção crua ali
  // deixaria o comando na fila para sempre, e o servidor nunca subiria.
  const db = mongoose.connection && mongoose.connection.db;
  if (!db) return;

  const col = db.collection('bases');
  try {
    const indices = await col.indexes();
    if (indices.some((i) => i.name === 'tipo_1')) await col.dropIndex('tipo_1');
  } catch (e) {
    console.warn('[bases] não consegui conferir os índices:', e.message);
  }
  try {
    await col.updateMany({ marcaSlug: { $in: [null, ''] } }, { $set: { marcaSlug: 'maxprint' } });
    await col.createIndex({ marcaSlug: 1, tipo: 1 }, { unique: true });
  } catch (e) {
    console.warn('[bases] não consegui ajustar por marca:', e.message);
  }
}

async function iniciar() {
  await mongoose.connect(MONGO);
  await ajustarBasesPorMarca();
  await Config.carregar();
  // O HOST importa: sem ele o Node escuta em 0.0.0.0 e o sistema passa a
  // responder direto em IP:3001, driblando o HTTPS do Nginx. Escutando só no
  // loopback, a única porta de entrada é o Nginx — que é o desenho pretendido.
  app.listen(PORTA, HOST, () => {
    console.log(`Catálogos Ativação no ar em http://${HOST}:${PORTA}`);
  });
}

if (require.main === module) {
  iniciar().catch((e) => {
    console.error('Não subiu:', e.message);
    process.exit(1);
  });
}

module.exports = { app, iniciar };
