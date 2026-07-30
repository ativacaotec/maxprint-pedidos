'use strict';

/**
 * De quem é o produto, dentro da base de uma marca.
 *
 * A base da Maxprint não é só Maxprint: ela distribui a linha Logitech, e no
 * catálogo do cliente os dois aparecem misturados. Quem vende pediu para
 * separar — e para poder marcar um, o outro ou os dois ao mesmo tempo.
 *
 * A separação é calculada na hora de montar o catálogo, e não gravada no
 * produto, de propósito: assim ela vale para a base que já está no ar, sem
 * depender de reimportar nada, e um fabricante novo entra aqui numa linha.
 *
 * O reconhecimento olha a CATEGORIA e o NOME. Na base de julho/2026 os 29
 * itens Logitech vêm todos na categoria "LOGITECH" e todos têm "LOGITECH" no
 * nome — as duas pistas concordam. O nome fica no teste porque é o que
 * sobrevive a uma troca de categoria na planilha da fábrica.
 */

const CONHECIDOS = [
  { nome: 'Logitech', teste: /\bLOGITECH\b/i },
];

/** O fabricante do item, ou o padrão da marca quando nenhum outro aparece. */
function fabricanteDoProduto(p, padrao) {
  const texto = `${p.categoria || ''} ${p.nome || ''} ${p.subMarca || ''}`;
  for (const f of CONHECIDOS) {
    if (f.teste.test(texto)) return f.nome;
  }
  return padrao;
}

/**
 * Filtro de banco que pega só os itens de um fabricante conhecido.
 * Serve ao buscador de fotos, que precisa varrer a loja certa.
 */
function filtroDeFabricante(nome) {
  const f = CONHECIDOS.find((x) => x.nome.toLowerCase() === String(nome || '').toLowerCase());
  if (!f) return null;
  const re = new RegExp(f.teste.source, 'i');
  return { $or: [{ categoria: re }, { nome: re }, { subMarca: re }] };
}

module.exports = { fabricanteDoProduto, filtroDeFabricante, CONHECIDOS };
