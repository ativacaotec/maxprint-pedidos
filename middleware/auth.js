'use strict';

/**
 * Checagens de acesso.
 *
 * A parede que mais importa é a `requireInterno`: o cliente externo NÃO pode
 * alcançar nada do painel. Ele tem login no mesmo sistema, então a separação
 * precisa ser explícita em toda rota interna, não só na tela.
 */

const Usuario = require('../models/Usuario');

/**
 * A sessão precisa envelhecer.
 *
 * Antes ela era um retrato do usuário no instante do login — perfil,
 * catalogoStatus e marcasPermitidas ficavam congelados por 12 horas. Isso
 * significava que desligar alguém não tinha efeito nenhum sobre a aba que ele
 * já tinha aberta: um interno demitido seguia podendo apagar pedido de vez, e
 * tirar uma marca de um cliente não tirava o catálogo dela da tela dele.
 *
 * Agora o usuário é relido do banco, com um respiro de meio minuto para não
 * virar uma consulta a cada clique. Meio minuto é o atraso máximo entre o
 * admin salvar e a mudança valer — e é curto o bastante para ele conferir na
 * hora, sem transformar cada requisição em ida ao banco.
 */
const RESPIRO_MS = 30 * 1000;
const cache = new Map();   // id -> { quando, usuario }

async function usuarioDeVerdade(id) {
  const guardado = cache.get(String(id));
  if (guardado && Date.now() - guardado.quando < RESPIRO_MS) return guardado.usuario;

  const u = await Usuario.findById(id)
    .select('nome usuario perfil ativo catalogoStatus marcasPermitidas')
    .lean()
    .catch(() => null);

  cache.set(String(id), { quando: Date.now(), usuario: u });
  // O cache é da vida do processo; um teto evita crescer sem fim num sistema
  // com muitos logins.
  if (cache.size > 500) {
    for (const [k, v] of cache) { if (Date.now() - v.quando > RESPIRO_MS) cache.delete(k); }
  }
  return u;
}

/** Esquece o que está guardado de alguém — usado quando o cadastro muda. */
function esquecerUsuario(id) {
  cache.delete(String(id));
}

/**
 * Esta requisição espera JSON?
 *
 * Antes a decisão saía só do cabeçalho `Accept`, e quem não manda `Accept`
 * (a maioria dos `fetch`) caía no ramo do HTML: a tela recebia a página de
 * login inteira no lugar de um erro, e mostrava "Deu erro" sem dizer que a
 * sessão tinha caído. Endereço que começa com /api sempre responde JSON.
 */
function querJson(req) {
  if (String(req.originalUrl || req.url || '').startsWith('/api')) return true;
  return !!(req.accepts('json') && !req.accepts('html'));
}

async function requireLogin(req, res, next) {
  const sessao = req.session && req.session.usuario;
  if (!sessao) {
    if (querJson(req)) return res.status(401).json({ erro: 'Sessão expirada. Entre de novo.' });
    return res.redirect('/login');
  }

  const atual = await usuarioDeVerdade(sessao.id);

  // Apagado ou desativado desde o login: a sessão morre agora.
  if (!atual || atual.ativo === false) {
    req.session.destroy(() => {});
    if (querJson(req)) {
      return res.status(401).json({ erro: 'Seu acesso foi encerrado. Fale com o representante.' });
    }
    return res.redirect('/login');
  }

  // O que vale é o cadastro de agora, não o do momento do login.
  req.session.usuario = {
    ...sessao,
    perfil: atual.perfil,
    catalogoStatus: atual.catalogoStatus,
    marcasPermitidas: atual.marcasPermitidas,
    nome: atual.nome,
  };
  return next();
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

module.exports = { requireLogin, requireInterno, requireAdmin, requireCliente, esquecerUsuario };
