'use strict';

/**
 * Sobe o sistema INTEIRO (as rotas de verdade, as telas de verdade) sobre o
 * banco de mentira do mongo_falso.js, já com dados de exemplo das duas
 * marcas. Serve para abrir no navegador e conferir as telas antes de publicar.
 *
 *   node scripts/servidor_de_teste.js
 *   → http://127.0.0.1:3999   (marcelo / teste123 · cliente / teste123)
 *
 * Não vai para produção; é ferramenta de conferência.
 */

const path = require('path');
const bcrypt = require('bcryptjs');

/* 1. Banco de mentira, ANTES de qualquer model ser carregado. */
require('./mongo_falso').instalar();

/* 2. A sessão do sistema guarda no Mongo. Aqui troco por memória, senão o
 *    connect-mongo tenta abrir conexão de verdade e o servidor não sobe. */
const Module = require('module');
const requireOriginal = Module.prototype.require;
Module.prototype.require = function fingirConnectMongo(nome) {
  if (nome === 'connect-mongo') {
    return { create: () => undefined }; // undefined = express-session usa MemoryStore
  }
  return requireOriginal.apply(this, arguments);
};

process.env.PORT = process.env.PORT || '3999';
process.env.HOST = '127.0.0.1';
// Sem isto o servidor sorteia um segredo e avisa em voz alta — comportamento
// certo em produção, mas aqui só sujaria a saída do arranjo de teste.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'segredo-do-arranjo-de-teste';

const semear = require('./semente_de_teste');

semear()
  .then(async () => {
    // server.js carrega o resto dos models (Base, Importacao) ao subir as
    // rotas, e cada um só pode ser compilado enquanto a conexão ainda diz
    // "desconectada" — por isso o fingirConectado() vem DEPOIS desta linha.
    const { iniciar } = require('../server');
    require('./mongo_falso').fingirConectado();

    // O server.js só sobe sozinho quando é executado direto. Como aqui ele é
    // importado, quem chama o listen sou eu.
    await iniciar();

    console.log('\n  Servidor de teste: http://127.0.0.1:' + process.env.PORT);
    console.log('  admin ...... marcelo / teste123');
    console.log('  cliente .... cliente / teste123  (vê as duas marcas)');
    console.log('  cliente .... sominha / teste123  (vê só a Maxprint)\n');
  })
  .catch((e) => { console.error(e); process.exit(1); });
