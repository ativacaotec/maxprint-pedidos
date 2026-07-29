'use strict';

/**
 * Regras de prazo de pagamento e formação de preço.
 *
 * Nasceu só para a Maxprint (combinado com o Marcelo em 28/07/2026):
 *
 *   Condição      Prazo médio    Ajuste sobre o custo
 *   ---------------------------------------------------
 *   À vista       0 dias         nenhum
 *   30            30 dias        nenhum
 *   30/60         45 dias        +1%
 *   60            60 dias        +2%
 *   30/60/90      60 dias        +2%
 *
 * A regra virou fórmula para que qualquer condição nova caia certa sozinha:
 *
 *   prazo médio <= 30 .........  acréscimo = 0
 *   30 < prazo médio <= 60 ....  acréscimo = 2% x (prazoMedio - 30) / 30
 *   prazo médio > 60 ..........  não fecha, abre negociação com o representante
 *
 * Quando o sistema virou multimarca (29/07/2026), a Samsonite trouxe uma
 * tabela DIFERENTE (30, 30/60, 60, 30/60/90 sempre; 60/90, 90, 60/90/120 só
 * acima de R$ 15.000) e, ao contrário da Maxprint, SEM acréscimo de preço
 * por prazo — o prazo escolhido só muda a condição, não o valor.
 *
 * Em vez de duplicar este arquivo por marca, toda função aqui aceita um
 * parâmetro opcional de regras. Chamado sem esse parâmetro, o comportamento
 * é EXATAMENTE o de antes (as constantes da Maxprint) — por isso nenhuma
 * rota existente precisou mudar quando isto foi generalizado. `regrasDaMarca`
 * é o único lugar novo que uma rota multimarca precisa chamar.
 */

const PRAZO_MAXIMO_DIAS = 60;
const ACRESCIMO_NO_TETO = 0.02; // 2% no prazo médio de 60 dias

/** Condições oferecidas ao cliente Maxprint na tela de fechamento. */
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
 *
 * @param {string} entrada
 * @param {object[]} condicoes  lista de condições da marca; default = Maxprint
 */
function interpretarCondicao(entrada, condicoes = CONDICOES) {
  if (!entrada) return null;
  const achada = condicoes.find((c) => c.id === entrada);
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
 *
 * @param {string|object} condicao
 * @param {object} [regras]
 * @param {object[]} [regras.condicoes]         default = Maxprint
 * @param {boolean} [regras.aplicarAcrescimo]    default = true (Maxprint)
 * @param {number} [regras.prazoMaximoDias]      default = 60
 * @param {number} [regras.acrescimoNoTeto]      default = 0.02
 */
function fatorPrazo(condicao, regras = {}) {
  const {
    condicoes = CONDICOES,
    aplicarAcrescimo = true,
    prazoMaximoDias = PRAZO_MAXIMO_DIAS,
    acrescimoNoTeto = ACRESCIMO_NO_TETO,
  } = regras;

  const c = typeof condicao === 'object' && condicao !== null
    ? condicao
    : interpretarCondicao(condicao, condicoes);

  if (!c) return { fator: 1, acrescimo: 0, negociar: false, prazoMedio: 0, rotulo: '' };

  const pm = c.prazoMedio !== undefined ? c.prazoMedio : prazoMedio(c.parcelas);

  // Marcas sem acréscimo por prazo (Samsonite): o preço não muda com o prazo
  // escolhido, só a disponibilidade da condição varia com o valor do pedido
  // (ver condicoesDisponiveis). Ainda assim devolvo prazoMedio/rotulo, que o
  // pedido grava para referência.
  if (!aplicarAcrescimo) {
    return { fator: 1, acrescimo: 0, negociar: false, prazoMedio: pm, rotulo: c.rotulo };
  }

  if (pm > prazoMaximoDias) {
    return { fator: 1, acrescimo: 0, negociar: true, prazoMedio: pm, rotulo: c.rotulo };
  }
  if (pm <= 30) {
    return { fator: 1, acrescimo: 0, negociar: false, prazoMedio: pm, rotulo: c.rotulo };
  }

  const acrescimo = acrescimoNoTeto * ((pm - 30) / 30);
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
 *   base ............ Preço c/ IPI da tabela (ou preço já promocional, na Samsonite)
 *   descontoCliente . fração cadastrada na ficha (0.12 = 12%)
 *   condicao ........ id da condição ou texto livre
 *   regras .......... ver fatorPrazo; default = regras da Maxprint
 *
 * A conta acontece SEMPRE no servidor. O desconto do cliente nunca é enviado
 * ao navegador dele — senão a margem fica visível no código da página.
 */
function precoUnitario(base, descontoCliente, condicao, regras = {}) {
  const b = Number(base || 0);
  const d = Math.min(Math.max(Number(descontoCliente || 0), 0), 0.95);
  const { fator, negociar, acrescimo, prazoMedio: pm } = fatorPrazo(condicao, regras);

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

/**
 * Condições que o cliente pode escolher AGORA, dado o total do pedido até o
 * momento. A maioria das marcas devolve sempre a mesma lista; a Samsonite
 * libera um segundo patamar de prazos mais longos quando o pedido passa de
 * um valor mínimo (condicoesAcimaDeValor).
 */
function condicoesDisponiveis(regras = {}, totalPedido = 0) {
  const base = (regras.condicoes && regras.condicoes.length) ? regras.condicoes : CONDICOES;
  const extra = regras.condicoesAcimaDeValor;
  if (extra && extra.valorMinimo > 0 && (extra.condicoes || []).length && totalPedido >= extra.valorMinimo) {
    return [...base, ...extra.condicoes];
  }
  return base;
}

/**
 * Converte um documento Marca (ou objeto plano com o mesmo formato) no
 * pacote de regras que fatorPrazo/precoUnitario/condicoesDisponiveis
 * entendem. Sem marca (ou marca 'maxprint' sem condições cadastradas), cai
 * nas constantes de cima — mantém o comportamento de antes do multimarca.
 */
function regrasDaMarca(marca) {
  if (!marca) {
    return {
      condicoes: CONDICOES,
      condicoesAcimaDeValor: null,
      aplicarAcrescimo: true,
      prazoMaximoDias: PRAZO_MAXIMO_DIAS,
      acrescimoNoTeto: ACRESCIMO_NO_TETO,
    };
  }
  return {
    condicoes: (marca.condicoesPagamento && marca.condicoesPagamento.length) ? marca.condicoesPagamento : CONDICOES,
    condicoesAcimaDeValor: (marca.condicoesAcimaDeValor && marca.condicoesAcimaDeValor.valorMinimo > 0)
      ? marca.condicoesAcimaDeValor
      : null,
    aplicarAcrescimo: marca.aplicarAcrescimoPrazo !== undefined ? !!marca.aplicarAcrescimoPrazo : true,
    prazoMaximoDias: marca.prazoMaximoDias || PRAZO_MAXIMO_DIAS,
    acrescimoNoTeto: marca.acrescimoNoTeto !== undefined ? marca.acrescimoNoTeto : ACRESCIMO_NO_TETO,
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
  condicoesDisponiveis,
  regrasDaMarca,
  arredondar,
};
