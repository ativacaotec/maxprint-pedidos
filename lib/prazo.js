'use strict';

/**
 * Regras de prazo de pagamento e formação de preço.
 *
 * Combinado com o Marcelo em 28/07/2026:
 *
 *   Condição      Prazo médio    Ajuste sobre o custo
 *   ---------------------------------------------------
 *   À vista       0 dias         nenhum
 *   30            30 dias        nenhum
 *   30/60         45 dias        +1%
 *   60            60 dias        +2%
 *   30/60/90      60 dias        +2%
 *
 * A regra virou fórmula para que qualquer condição nova caia certa sozinha,
 * sem precisar mexer no código:
 *
 *   prazo médio <= 30 .........  acréscimo = 0
 *   30 < prazo médio <= 60 ....  acréscimo = 2% x (prazoMedio - 30) / 30
 *   prazo médio > 60 ..........  não fecha, abre negociação com o representante
 */

const PRAZO_MAXIMO_DIAS = 60;
const ACRESCIMO_NO_TETO = 0.02; // 2% no prazo médio de 60 dias

/** Condições oferecidas ao cliente na tela de fechamento. */
const CONDICOES = [
  { id: 'a_vista', rotulo: 'À vista', parcelas: [0] },
  { id: '30', rotulo: '30 dias', parcelas: [30] },
  { id: '30_60', rotulo: '30/60', parcelas: [30, 60] },
  { id: '60', rotulo: '60 dias', parcelas: [60] },
  { id: '30_60_90', rotulo: '30/60/90', parcelas: [30, 60, 90] },
];

/** Média simples das parcelas. 30/60/90 dá 60. */
function prazoMedio(parcelas) {
  if (!Array.isArray(parcelas) || parcelas.length === 0) return 0;
  const soma = parcelas.reduce((a, b) => a + Number(b || 0), 0);
  return soma / parcelas.length;
}

/**
 * Aceita tanto o id de uma condição cadastrada quanto um texto livre
 * ("30/60/90"), para o caso de o Marcelo negociar uma condição fora da lista.
 */
function interpretarCondicao(entrada) {
  if (!entrada) return null;
  const achada = CONDICOES.find((c) => c.id === entrada);
  if (achada) return { ...achada, prazoMedio: prazoMedio(achada.parcelas) };

  const texto = String(entrada).trim().toLowerCase();
  if (/^(a\s*vista|à\s*vista|avista)$/.test(texto)) {
    return { id: 'a_vista', rotulo: 'À vista', parcelas: [0], prazoMedio: 0 };
  }

  const parcelas = texto
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 365);

  if (!parcelas.length) return null;
  return {
    id: parcelas.join('_'),
    rotulo: parcelas.join('/'),
    parcelas,
    prazoMedio: prazoMedio(parcelas),
  };
}

/**
 * Fator multiplicador do acréscimo por prazo.
 * Retorna { fator, acrescimo, negociar, prazoMedio }.
 * `negociar: true` significa que o pedido NÃO fecha sozinho.
 */
function fatorPrazo(condicao) {
  const c = typeof condicao === 'object' && condicao !== null
    ? condicao
    : interpretarCondicao(condicao);

  if (!c) return { fator: 1, acrescimo: 0, negociar: false, prazoMedio: 0, rotulo: '' };

  const pm = c.prazoMedio !== undefined ? c.prazoMedio : prazoMedio(c.parcelas);

  if (pm > PRAZO_MAXIMO_DIAS) {
    return { fator: 1, acrescimo: 0, negociar: true, prazoMedio: pm, rotulo: c.rotulo };
  }
  if (pm <= 30) {
    return { fator: 1, acrescimo: 0, negociar: false, prazoMedio: pm, rotulo: c.rotulo };
  }

  const acrescimo = ACRESCIMO_NO_TETO * ((pm - 30) / 30);
  return {
    fator: 1 + acrescimo,
    acrescimo,
    negociar: false,
    prazoMedio: pm,
    rotulo: c.rotulo,
  };
}

/**
 * Preço final de uma unidade para um cliente, numa condição de pagamento.
 *
 *   base ............ Preço c/ IPI da tabela Maxprint
 *   descontoCliente . fração cadastrada na ficha (0.12 = 12%)
 *   condicao ........ id da condição ou texto livre
 *
 * A conta acontece SEMPRE no servidor. O desconto do cliente nunca é enviado
 * ao navegador dele — senão a margem fica visível no código da página.
 */
function precoUnitario(base, descontoCliente, condicao) {
  const b = Number(base || 0);
  const d = Math.min(Math.max(Number(descontoCliente || 0), 0), 0.95);
  const { fator, negociar, acrescimo, prazoMedio: pm } = fatorPrazo(condicao);

  const comDesconto = b * (1 - d);
  const final = comDesconto * fator;

  return {
    base: arredondar(b),
    comDesconto: arredondar(comDesconto),
    preco: arredondar(final),
    acrescimo,
    prazoMedio: pm,
    negociar,
  };
}

function arredondar(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

module.exports = {
  CONDICOES,
  PRAZO_MAXIMO_DIAS,
  ACRESCIMO_NO_TETO,
  prazoMedio,
  interpretarCondicao,
  fatorPrazo,
  precoUnitario,
  arredondar,
};
