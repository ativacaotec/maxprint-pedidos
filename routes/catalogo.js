'use strict';

const express = require('express');
const { requireLogin, requireCliente } = require('../middleware/auth');
const { montarCatalogo } = require('../lib/catalogoServico');

const router = express.Router();

router.use(requireLogin, requireCliente);

/**
 * GET /api/catalogo?condicao=30
 * Devolve o catálogo já precificado para o cliente logado.
 * O desconto dele NÃO vai junto: só o preço final.
 */
router.get('/', async (req, res) => {
  try {
    const condicao = String(req.query.condicao || '30');
    const dados = await montarCatalogo(req.session.usuario, condicao);
    res.json(dados);
  } catch (e) {
    console.error('[catalogo]', e);
    res.status(500).json({ erro: 'Não consegui montar o catálogo agora.' });
  }
});

module.exports = router;
