'use strict';

const express = require('express');
const { requireLogin } = require('../middleware/auth');
const { listarMarcasVisiveis } = require('../lib/marcas');

const router = express.Router();
router.use(requireLogin);

/**
 * GET /api/marcas
 * As abas que o usuário logado pode ver — cliente vê só as marcas
 * liberadas na ficha dele, equipe do escritório vê todas as ativas.
 * É a partir daqui que a tela do cliente monta as abas de marca.
 */
router.get('/', async (req, res) => {
  try {
    const lista = await listarMarcasVisiveis(req.session.usuario);
    res.json(
      lista.map((m) => ({
        slug: m.slug,
        nome: m.nome,
        corPrimaria: m.corPrimaria,
        corSecundaria: m.corSecundaria,
        logoClara: m.logoClara,
        logoEscura: m.logoEscura,
        subMarcas: m.subMarcas || [],
      }))
    );
  } catch (e) {
    console.error('[marcas]', e);
    res.status(500).json({ erro: 'Não consegui carregar as marcas agora.' });
  }
});

module.exports = router;
