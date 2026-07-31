'use strict';

/**
 * Reconhecer nome de produto que não é nome de produto.
 *
 * POR QUE ISSO EXISTE
 * Medido em produção em 30/07/2026: 39 itens da Maxprint estavam no ar com o
 * texto errado no lugar do nome, e o cliente lia isso no catálogo.
 *
 *   37 etiquetas ... "CÓD. MODELO FORM. DA ETIQ. QTDE. POR EMB."
 *   910007599 ...... "bidestro para maior conforto e longas horas de uso."
 *   62000151 ....... "classe 4 TIPO DE EMBALAGEM: CAIXA"
 *
 * O leitor do catálogo em PDF escolhe como nome "a linha de maior corpo de
 * letra". Nas páginas de etiqueta o cabeçalho da tabela tem o mesmo corpo do
 * nome, e nas páginas com descrição longa a frase quebra e a sobra vira uma
 * linha solta. As duas passavam.
 *
 * As regras daqui são usadas em dois lugares: no leitor do PDF, para não criar
 * o problema de novo; e no buscador do site, para saber quais nomes vale a
 * pena trocar pelo título que a fábrica publica.
 */

/** Texto sem acento e em caixa alta, para comparar rótulo de layout. */
function seco(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

/**
 * Rótulos de coluna que aparecem nas tabelas dos catálogos da Maxprint.
 * "POR", "DA" e "DE" entram porque compõem "QTDE. POR EMB." e "FORM. DA
 * ETIQ." — sem elas a proporção nunca fecharia.
 */
const ROTULOS_DE_COLUNA = [
  'COD', 'CODIGO', 'MODELO', 'FORM', 'ETIQ', 'ETIQUETA', 'QTDE', 'QTD', 'EMB',
  'EMBALAGEM', 'TIPO', 'CAIXA', 'MASTER', 'INNER', 'MEDIDAS', 'DIMENSOES',
  'PESO', 'NCM', 'EAN', 'REF', 'UNID', 'FOLHAS', 'POR', 'DA', 'DE',
];

/**
 * A linha é o cabeçalho de uma tabela, e não o nome de um produto?
 *
 * O jeito de reconhecer é que ela é feita SÓ de rótulo de coluna. Nome de
 * produto tem palavra de produto no meio. Exijo três rótulos para não derrubar
 * um nome legítimo que por acaso comece com "MODELO".
 */
function ehCabecalhoDeTabela(texto) {
  const tokens = seco(texto).split(/[\s.:/]+/).filter((t) => t.length > 1);
  if (tokens.length < 3) return false;
  const rotulos = tokens.filter((t) => ROTULOS_DE_COLUNA.includes(t)).length;
  return rotulos >= 3 && rotulos / tokens.length >= 0.7;
}

/**
 * Sobra de descrição que vazou para dentro do card.
 *
 * Nome de produto no catálogo da Maxprint começa em maiúscula. Linha que
 * começa em minúscula é continuação de uma frase de outro lugar da página.
 */
function ehSobraDeDescricao(texto) {
  return /^[a-zà-ÿ]/.test(String(texto || '').trim());
}

/**
 * Vale a pena trocar este nome pelo que a fábrica publica no site?
 *
 * Conservador de propósito: só diz "sim" para o que é claramente lixo. Nome
 * bom não se mexe, porque o do site às vezes é da família e o do catálogo é do
 * item exato.
 */
function nomeSuspeito(nome) {
  const t = String(nome || '').trim();
  if (t.length < 8) return true;
  if (ehCabecalhoDeTabela(t)) return true;
  if (ehSobraDeDescricao(t)) return true;
  if (/QTDE?\.?\s*POR\s*EMB|TIPO DE EMBALAGEM/i.test(t)) return true;
  return false;
}

module.exports = { seco, ehCabecalhoDeTabela, ehSobraDeDescricao, nomeSuspeito, ROTULOS_DE_COLUNA };
