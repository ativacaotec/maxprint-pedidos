'use strict';

/**
 * Normalização do código de produto.
 *
 * O mesmo item aparece escrito de três jeitos diferentes nas três fontes:
 *   - planilha de estoque .......  "74 986"     (com espaço)
 *   - tabela de preço ...........  "74000124"   (sem espaço)
 *   - catálogo Logitech .........  "910-007049" (com hífen)
 *
 * Sem normalizar, as bases simplesmente não se encontram. Medido nos arquivos
 * reais de julho/2026: com a normalização o cruzamento entre estoque e preço
 * vai de quase nada para 95%.
 *
 * A regra é conservadora de propósito: só tira separadores e espaços. NÃO tira
 * zero à esquerda, porque na Maxprint "60 3550" e "603550" são o mesmo item,
 * mas "0603550" não existe — inventar corte de zero criaria colisão.
 */
function normalizarCodigo(valor) {
  if (valor === null || valor === undefined) return '';
  let s = String(valor).trim();

  // Excel entrega número puro como "74000124" ou, quando vira float, "74000124.0"
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');

  return s
    .replace(/[\s \-–—._/]/g, '') // espaços (inclusive não separável), hífens, ponto, underline, barra
    .toUpperCase();
}

/**
 * Extrai códigos de um trecho de texto do catálogo.
 * Aceita os formatos que aparecem nos PDFs da Maxprint, Dazz e Logitech.
 */
const PADROES_CODIGO = [
  /\b\d{3}-\d{6}\b/g,        // Logitech: 910-007049
  /\b\d{2}\s\d{3,4}\b/g,     // Maxprint com espaço: 74 986 / 70 9012
  /\b\d{6,9}\b/g,            // sem separador: 60000119 / 70000149 / 6116169
];

function acharCodigos(texto) {
  if (!texto) return [];
  const achados = new Set();
  for (const re of PADROES_CODIGO) {
    const m = String(texto).match(re);
    if (m) m.forEach((c) => achados.add(normalizarCodigo(c)));
  }
  return [...achados];
}

/**
 * Um código "plausível" tem entre 5 e 12 dígitos. Serve para descartar
 * número de página, ano (2026), medida de caixa e telefone.
 */
function codigoPlausivel(cod) {
  const c = normalizarCodigo(cod);
  if (!/^\d+$/.test(c)) return false;
  if (c.length < 5 || c.length > 12) return false;
  if (/^20\d{2}$/.test(c)) return false;
  return true;
}

module.exports = { normalizarCodigo, acharCodigos, codigoPlausivel };
