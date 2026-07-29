'use strict';

const express = require('express');
const { requireLogin, requireCliente } = require('../middleware/auth');
const { montarCatalogo } = require('../lib/catalogoServico');
const { podeAcessarMarca, carregarMarca } = require('../lib/marcas');

const router = express.Router();

router.use(requireLogin, requireCliente);

/**
 * GET /api/catalogo?condicao=30&marca=samsonite
 * Devolve o catálogo já precificado para o cliente logado, na marca pedida.
 * `marca` é opcional e cai em 'maxprint' por compatibilidade com quem
 * chamava esta rota antes de existir multimarca. O desconto do cliente NÃO
 * vai junto: só o preço final.
 */
router.get('/', async (req, res) => {
  try {
    const marcaSlug = String(req.query.marca || 'maxprint').toLowerCase();
    if (!podeAcessarMarca(req.session.usuario, marcaSlug)) {
      return res.status(403).json({ erro: 'Você não tem acesso a essa marca.' });
    }
    const marca = await carregarMarca(marcaSlug);
    if (!marca || !marca.ativa) {
      return res.status(404).json({ erro: 'Marca não encontrada ou desativada.' });
    }
    const condicao = String(req.query.condicao || '30');
    const dados = await montarCatalogo(req.session.usuario, condicao, marca);
    res.json(dados);
  } catch (e) {
    console.error('[catalogo]', e);
    res.status(500).json({ erro: 'Não consegui montar o catálogo agora.' });
  }
});

module.exports = router;
