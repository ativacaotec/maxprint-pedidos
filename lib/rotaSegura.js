'use strict';

/**
 * Rede de segurança para handler async que rejeita.
 *
 * POR QUE ISSO EXISTE
 * O Express 4 não sabe o que fazer com uma promise rejeitada dentro de um
 * handler `async`: ela vira "unhandledRejection", e no Node 20 isso DERRUBA O
 * PROCESSO. Não é hipótese — qualquer cliente logado conseguia fazer isso com
 * um endereço errado:
 *
 *     GET /api/pedidos/abc      -> Number("abc") = NaN
 *                               -> CastError do Mongoose
 *                               -> promise rejeitada sem dono
 *                               -> o servidor morre para todo mundo
 *
 * E não morria só o catálogo: as importações da Samsonite e da Yin's guardam o
 * progresso num Map em memória, então uma importação de 40 minutos sumia no
 * meio sem deixar recado.
 *
 * Aqui cada rota já registrada passa a ter o `.catch(next)` que faltava, e o
 * erro vai para o tratador do `server.js` como qualquer outro.
 */

function comCuidado(fn) {
  if (typeof fn !== 'function' || fn.length >= 4) return fn;   // tratador de erro fica como está
  const protegido = function (req, res, next) {
    let saida;
    try {
      saida = fn.call(this, req, res, next);
    } catch (e) {
      next(e);
      return undefined;
    }
    if (saida && typeof saida.then === 'function') saida.catch(next);
    return saida;
  };
  // Mantém o nome, que é o que aparece na pilha de erro.
  Object.defineProperty(protegido, 'name', { value: fn.name || 'rota' });
  return protegido;
}

/**
 * Protege as ROTAS de um router (não os middlewares soltos).
 *
 * De propósito não mexe em `express.json`, sessão e estáticos: eles não são
 * async e envolver middleware de terceiro é convite para efeito colateral.
 */
function protegerRotas(router) {
  for (const camada of (router && router.stack) || []) {
    if (camada.route && camada.route.stack) {
      for (const c of camada.route.stack) c.handle = comCuidado(c.handle);
    } else if (camada.handle && camada.handle.stack) {
      protegerRotas(camada.handle);
    }
  }
  return router;
}

module.exports = { comCuidado, protegerRotas };
