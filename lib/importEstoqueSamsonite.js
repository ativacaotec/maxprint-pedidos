'use strict';

const XLSX = require('xlsx');
const path = require('path');
const { normalizarCodigo } = require('./codigo');

/**
 * Importador do "Sortimento Produtos Wholesale" da Samsonite.
 *
 * É a planilha que a Samsonite manda com o saldo atualizado. Apesar do nome
 * sugerir só estoque, ela é uma base COMPLETA: SKU, marca, linha, cor, tipo,
 * preço de tabela e saldo — 1.558 itens, todos com preço.
 *
 * Por isso este importador faz duas coisas:
 *   1. atualiza o saldo de quem já está no catálogo;
 *   2. cria quem ainda não está (a planilha cobre mais itens que o HTML).
 *
 * ATENÇÃO AO PREÇO. Conferido contra a base do HTML nos 1.546 itens em comum:
 * o "PREÇO WHOLESALE" da planilha é sempre o preço CHEIO, nunca o promocional.
 * Um item com 40% de desconto aparece aqui pelos R$ 382,30 cheios, não pelos
 * R$ 229,38 que o cliente deveria pagar. Se este importador sobrescrevesse o
 * preço às cegas, toda promoção sumiria na primeira atualização de estoque —
 * e ninguém perceberia, porque o preço "certo" continuaria parecendo certo.
 *
 * Então a regra é: item em promoção tem o preço PRESERVADO, e o relatório
 * diz quantos foram. Item fora de promoção acompanha a planilha.
 *
 * Sobre o formato do arquivo: são duas abas ("Representantes" e "BTS_27"),
 * cabeçalho na segunda linha, e a aba Representantes tem uma coluna de marca
 * SEM nome no cabeçalho — por isso a marca é lida pela posição (coluna 1),
 * que é onde ela está nas duas abas, e não pelo nome.
 */

const MARCA_SLUG = 'samsonite';

/** A planilha abrevia o nome da marca; o cliente precisa ver o nome inteiro. */
const NOMES_DE_MARCA = {
  'AMERICAN T': 'American Tourister',
  'SAMMIES BY': 'Sammies by Samsonite',
  RED: 'Samsonite Red',
  SAMSONITE: 'Samsonite',
  XTREM: 'Xtrem',
};

function texto(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function numero(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[R$\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function arredondar(v) {
  return Math.round(v * 100) / 100;
}

function nomeDaMarca(bruto) {
  const chave = texto(bruto).toUpperCase();
  if (NOMES_DE_MARCA[chave]) return NOMES_DE_MARCA[chave];
  // Marca nova que a Samsonite passe a mandar: entra com o nome que veio, em
  // vez de virar "(sem marca)" e sumir da navegação do cliente.
  return texto(bruto) || 'Samsonite';
}

/**
 * Acha a linha do cabeçalho. Normalmente é a segunda (a primeira traz um
 * total solto), mas procuro pela linha que tem "SKU" para não quebrar se a
 * Samsonite mudar o layout de cima.
 */
function acharCabecalho(linhas) {
  for (let i = 0; i < Math.min(10, linhas.length); i++) {
    const l = (linhas[i] || []).map((x) => texto(x).toUpperCase());
    if (l.includes('SKU')) return i;
  }
  return -1;
}

function lerAba(linhas, nomeAba, avisos) {
  const iCab = acharCabecalho(linhas);
  if (iCab < 0) {
    avisos.push(`Aba "${nomeAba}": não achei a linha de cabeçalho (nenhuma coluna chamada SKU). Ignorada.`);
    return [];
  }

  const cab = (linhas[iCab] || []).map((x) => texto(x).toUpperCase());
  const achar = (...nomes) => {
    for (const n of nomes) {
      const i = cab.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const col = {
    sku: achar('SKU'),
    grupo: achar('MATERIAL GROUP DESC.', 'MATERIAL GROUP DESC', 'MATERIAL GROUP'),
    cor: achar('VALUE DESCRIPTION'),
    tipo: achar('MATERIAL DESCRIPTION'),
    estoque: achar('ESTOQUE'),
    whole: achar('PREÇO WHOLESALE', 'PRECO WHOLESALE', 'WHOLESALE'),
    retail: achar('PREÇO RETAIL', 'PRECO RETAIL', 'RETAIL'),
    ncm: achar('NCM'),
  };

  const faltando = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => k);
  if (col.sku < 0 || col.estoque < 0 || col.whole < 0) {
    avisos.push(`Aba "${nomeAba}": faltam colunas essenciais (${faltando.join(', ')}). Ignorada.`);
    return [];
  }
  if (faltando.length) {
    avisos.push(`Aba "${nomeAba}": colunas não encontradas e ignoradas: ${faltando.join(', ')}.`);
  }

  // A marca vem na coluna 1 nas duas abas. Na "Representantes" ela não tem
  // nome no cabeçalho (o cabeçalho pula esse rótulo), então ler pela posição
  // é o que funciona nos dois casos.
  const colMarca = achar('MARCA') >= 0 ? achar('MARCA') : 1;

  const itens = [];
  for (const l of linhas.slice(iCab + 1)) {
    if (!l) continue;
    const skuOriginal = texto(l[col.sku]);
    if (!skuOriginal) continue;

    const codigo = normalizarCodigo(skuOriginal);
    if (!codigo) continue;

    const whole = numero(l[col.whole]);
    const estoque = Math.max(0, Math.round(numero(l[col.estoque]) || 0));

    itens.push({
      codigo,
      codigoOriginal: skuOriginal,
      subMarca: nomeDaMarca(l[colMarca]),
      grupo: col.grupo >= 0 ? texto(l[col.grupo]) : '',
      cor: col.cor >= 0 ? texto(l[col.cor]) : '',
      tipoProduto: col.tipo >= 0 ? texto(l[col.tipo]) : '',
      ncm: col.ncm >= 0 ? texto(l[col.ncm]) : '',
      // Arredondo aqui: a planilha traz o preço com 14 casas decimais
      // (286.60287081339715), fruto de uma conversão de moeda na origem.
      precoCheio: whole !== null && whole > 0 ? arredondar(whole) : 0,
      precoVarejo: col.retail >= 0 ? (numero(l[col.retail]) || 0) : 0,
      estoque,
      aba: nomeAba,
    });
  }

  return itens;
}

/**
 * @param {string} caminhoArquivo  o .xlsx do Sortimento
 * @returns {{ itens, relatorio, avisos }}
 */
function importarEstoqueSamsonite(caminhoArquivo) {
  const avisos = [];
  const wb = XLSX.readFile(caminhoArquivo);

  const todos = [];
  for (const nome of wb.SheetNames) {
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: true });
    todos.push(...lerAba(linhas, nome, avisos));
  }

  // SKU repetido entre abas: fica o primeiro, como no resto do sistema.
  const porCodigo = new Map();
  let duplicados = 0;
  for (const it of todos) {
    if (porCodigo.has(it.codigo)) { duplicados++; continue; }
    porCodigo.set(it.codigo, it);
  }
  const itens = [...porCodigo.values()];

  const semPreco = itens.filter((i) => !(i.precoCheio > 0));
  if (semPreco.length) {
    avisos.push(`${semPreco.length} item(ns) sem preço na planilha; entram no catálogo só se já tiverem preço gravado.`);
  }

  const porSubMarca = {};
  for (const i of itens) porSubMarca[i.subMarca] = (porSubMarca[i.subMarca] || 0) + 1;

  return {
    itens,
    avisos,
    relatorio: {
      arquivo: path.basename(caminhoArquivo),
      abas: wb.SheetNames,
      totalLido: todos.length,
      totalValido: itens.length,
      duplicados,
      comSaldo: itens.filter((i) => i.estoque > 0).length,
      semSaldo: itens.filter((i) => i.estoque <= 0).length,
      pecasEmEstoque: itens.reduce((a, i) => a + i.estoque, 0),
      semPreco: semPreco.length,
      porSubMarca,
    },
  };
}

module.exports = { importarEstoqueSamsonite, MARCA_SLUG };
