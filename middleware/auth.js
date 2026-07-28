'use strict';

/**
 * Checagens de acesso.
 *
 * A parede que mais importa é a `requireInterno`: o cliente externo NÃO pode
 * alcançar nada do painel. Ele tem login no mesmo sistema, então a separação
 * precisa ser explícita em toda rota interna, não só na tela.
 */

function requireLogin(req, res, next) {
  if (req.session && req.session.usuario) return next();
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(401).json({ erro: 'Sessão expirada. Entre de novo.' });
  }
  return res.redirect('/login');
}

function requireInterno(req, res, next) {
  const u = req.session && req.session.usuario;
  if (u && (u.perfil === 'admin' || u.perfil === 'interno')) return next();
  return res.status(403).json({ erro: 'Acesso restrito à equipe.' });
}

function requireAdmin(req, res, next) {
  const u = req.session && req.session.usuario;
  if (u && u.perfil === 'admin') return next();
  return res.status(403).json({ erro: 'Só o administrador pode fazer isso.' });
}

function requireCliente(req, res, next) {
  const u = req.session && req.session.usuario;
  if (!u) return res.status(401).json({ erro: 'Sessão expirada. Entre de novo.' });
  if (u.perfil !== 'cliente') return next(); // interno também pode ver o catálogo
  if (u.catalogoStatus !== 'live') {
    return res.status(423).json({
      erro: 'Seu catálogo ainda não foi liberado. Fale com o representante.',
    });
  }
  return next();
}

module.exports = { requireLogin, requireInterno, requireAdmin, requireCliente };
