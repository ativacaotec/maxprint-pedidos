'use strict';

require('dotenv').config();

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

const PORTA = Number(process.env.PORT || 3001);
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

async function iniciar() {
  await mongoose.connect(MONGO);
  await Config.carregar();
  app.listen(PORTA, () => {
    console.log(`Pedidos Maxprint no ar em http://localhost:${PORTA}`);
  });
}

if (require.main === module) {
  iniciar().catch((e) => {
    console.error('Não subiu:', e.message);
    process.exit(1);
  });
}

module.exports = { app, iniciar };
