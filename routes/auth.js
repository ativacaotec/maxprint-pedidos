'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const Usuario = require('../models/Usuario');

const router = express.Router();

router.post('/login', async (req, res) => {
  const usuario = String(req.body.usuario || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');

  if (!usuario || !senha) {
    return res.status(400).json({ erro: 'Preencha usuário e senha.' });
  }

  const u = await Usuario.findOne({ usuario });
  // Mensagem igual para usuário inexistente e senha errada, de propósito:
  // dizer "usuário não existe" entrega quais logins são válidos.
  if (!u || !u.ativo || !bcrypt.compareSync(senha, u.senhaHash)) {
    return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
  }

  u.ultimoAcesso = new Date();
  await u.save();

  req.session.usuario = {
    id: String(u._id),
    nome: u.nome,
    usuario: u.usuario,
    perfil: u.perfil,
    catalogoStatus: u.catalogoStatus,
    marcasPermitidas: Array.isArray(u.marcasPermitidas) && u.marcasPermitidas.length ? u.marcasPermitidas : ['maxprint'],
  };

  return res.json({
    ok: true,
    perfil: u.perfil,
    destino: u.perfil === 'cliente' ? '/catalogo' : '/painel',
    catalogoStatus: u.catalogoStatus,
  });
});

router.post('/sair', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/eu', (req, res) => {
  if (!req.session || !req.session.usuario) return res.status(401).json({ erro: 'sem sessão' });
  res.json(req.session.usuario);
});

/** Troca da própria senha. Vale para qualquer perfil. */
router.post('/minha-senha', async (req, res) => {
  if (!req.session || !req.session.usuario) return res.status(401).json({ erro: 'sem sessão' });
  const atual = String(req.body.atual || '');
  const nova = String(req.body.nova || '');
  if (nova.length < 6) return res.status(400).json({ erro: 'A senha nova precisa de pelo menos 6 caracteres.' });

  const u = await Usuario.findById(req.session.usuario.id);
  if (!u || !bcrypt.compareSync(atual, u.senhaHash)) {
    return res.status(401).json({ erro: 'A senha atual não confere.' });
  }
  u.senhaHash = bcrypt.hashSync(nova, 10);
  await u.save();
  res.json({ ok: true });
});

module.exports = router;
