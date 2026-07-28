'use strict';

/**
 * Cria o primeiro usuário administrador. Roda uma vez só, na instalação.
 * Depois disso, novos usuários saem da aba "Clientes" do próprio painel.
 *
 *   npm run create-admin
 */

require('dotenv').config();
const readline = require('readline');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Usuario = require('../models/Usuario');

const MONGO = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/maxprint_pedidos';

function perguntar(rl, texto, escondido = false) {
  return new Promise((resolve) => {
    if (!escondido) return rl.question(texto, resolve);
    const stdin = process.stdin;
    const aoDigitar = (char) => {
      if (['\n', '\r', ''].includes(String(char))) stdin.removeListener('data', aoDigitar);
      else process.stdout.write('\x1B[2K\x1B[200D' + texto + '*'.repeat(rl.line.length));
    };
    stdin.on('data', aoDigitar);
    rl.question(texto, (v) => { process.stdout.write('\n'); resolve(v); });
  });
}

(async () => {
  await mongoose.connect(MONGO);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const jaTem = await Usuario.countDocuments({ perfil: 'admin' });
    if (jaTem) {
      console.log(`\nJá existem ${jaTem} administrador(es). Se perdeu a senha, crie outro usuário aqui mesmo.\n`);
    }

    const nome = (await perguntar(rl, 'Seu nome: ')).trim();
    const usuario = (await perguntar(rl, 'Usuário (login): ')).trim().toLowerCase();
    const senha = await perguntar(rl, 'Senha (mínimo 6 caracteres): ', true);

    if (!nome || !usuario) throw new Error('Nome e usuário são obrigatórios.');
    if (senha.length < 6) throw new Error('A senha precisa de pelo menos 6 caracteres.');

    const existe = await Usuario.findOne({ usuario });
    if (existe) throw new Error(`Já existe um usuário "${usuario}".`);

    await Usuario.create({
      nome,
      usuario,
      senhaHash: bcrypt.hashSync(senha, 10),
      perfil: 'admin',
      ativo: true,
    });

    console.log(`\nPronto. Entre em /login com o usuário "${usuario}".\n`);
  } catch (e) {
    console.error('\n' + e.message + '\n');
    process.exitCode = 1;
  } finally {
    rl.close();
    await mongoose.disconnect();
  }
})();
