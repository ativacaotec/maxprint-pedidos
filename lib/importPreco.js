'use strict';

const XLSX = require('xlsx');
const { normalizarCodigo, codigoPlausivel } = require('./codigo');

/**
 * Importador da "Tabela Maxprint" — o arquivo de preços.
 *
 * A planilha tem nove abas de produto mais uma aba PEDIDO (que é o formulário
 * que o Marcelo preenchia à mão e que este sistema substitui). As abas de
 * produto têm o cabeçalho na linha 5 e os dados a partir da linha 6:
 *
 *   Código | Produto | CURVA A | EAN | NCM | CX MASTER | ST |
 *   Preço s/ IPI | Preço c/ IPI | IPI | QTD | Desconto% | ...
 *
 * A aba OUTLET é diferente: só tem Código, Produto e "Preço Promocional
 * (c/ IPI)", sem IPI separado.
 *
 * Decisões combinadas:
 *  - o preço é SEMPRE por unidade
 *  - a base do cliente é o "Preço c/ IPI"
 *  - a coluna ST (substituição tributária) NÃO entra no cálculo, igual à
 *    planilha atual. Fica guardada só como informação.
 */

const ABA_PEDIDO = 'PEDIDO';
const ABA_OUTLET = 'OUTLET';

/** Nomes de coluna aceitos, já sem espaços e sem acento, em minúsculas. */
const COLUNAS = {
  codigo: ['codigo'],
  produto: ['produto'],
  curvaA: ['curvaa'],
  ean: ['ean', 'ean(codbarras)', 'eancodbarras'],
  ncm: ['ncm'],
  cxMaster: ['cxmaster'],
  st: ['st'],
  precoSemIpi: ['precosemipi', 'precos/ipi'],
  precoComIpi: ['precocomipi', 'precoc/ipi'],
  ipi: ['ipi'],
  precoPromocional: ['precopromocional(c/ipi)', 'precopromocionalc/ipi', 'precopromocional'],
};

function chave(txt) {
  return String(txt || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function acharColuna(cabecalho, alvos) {
  for (let i = 0; i < cabecalho.length; i++) {
    const c = chave(cabecalho[i]);
    if (!c) continue;
    if (alvos.includes(c)) return i;
  }
  return -1;
}

function numero(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[R$\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Acha a linha de cabeçalho procurando a linha que contém "Código" e "Produto".
 * Não fixo a linha 5 de propósito: se a Maxprint acrescentar um título em cima,
 * o importador continua achando sozinho.
 */
function acharCabecalho(linhas) {
  for (let i = 0; i < Math.min(linhas.length, 15); i++) {
    const l = (linhas[i] || []).map(chave);
    if (l.includes('codigo') && l.includes('produto')) return i;
  }
  return -1;
}

function importarPreco(caminhoOuBuffer) {
  const wb = typeof caminhoOuBuffer === 'string'
    ? XLSX.readFile(caminhoOuBuffer, { cellDates: false })
    : XLSX.read(caminhoOuBuffer, { type: 'buffer', cellDates: false });

  const itens = [];
  const avisos = [];
  const porAba = {};

  for (const nomeAba of wb.SheetNames) {
    if (chave(nomeAba) === chave(ABA_PEDIDO)) continue;

    const ws = wb.Sheets[nomeAba];
    const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    const iCab = acharCabecalho(linhas);
    if (iCab < 0) {
      avisos.push(`Aba "${nomeAba}" ignorada: não achei o cabeçalho com Código e Produto.`);
      continue;
    }

    const cab = linhas[iCab] || [];
    const col = {};
    for (const [nome, alvos] of Object.entries(COLUNAS)) col[nome] = acharColuna(cab, alvos);

    const ehOutlet = chave(nomeAba) === chave(ABA_OUTLET);
    let n = 0;

    for (let i = iCab + 1; i < linhas.length; i++) {
      const l = linhas[i] || [];
      const codBruto = col.codigo >= 0 ? l[col.codigo] : null;
      const nome = col.produto >= 0 ? l[col.produto] : null;
      if (!codBruto || !nome) continue;

      const codigo = normalizarCodigo(codBruto);
      if (!codigoPlausivel(codigo)) continue;

      const precoComIpi = ehOutlet
        ? numero(col.precoPromocional >= 0 ? l[col.precoPromocional] : l[3])
        : numero(col.precoComIpi >= 0 ? l[col.precoComIpi] : null);

      if (precoComIpi === null || precoComIpi <= 0) {
        avisos.push(`Aba "${nomeAba}", código ${codigo}: sem preço, item ignorado.`);
        continue;
      }

      itens.push({
        codigo,
        codigoOriginal: String(codBruto).trim(),
        nome: String(nome).trim(),
        categoria: nomeAba.trim(),
        outlet: ehOutlet,
        curvaA: col.curvaA >= 0 && /curva/i.test(String(l[col.curvaA] || '')),
        ean: col.ean >= 0 && l[col.ean] ? String(l[col.ean]).trim() : '',
        ncm: col.ncm >= 0 && l[col.ncm] ? String(l[col.ncm]).trim() : '',
        cxMaster: col.cxMaster >= 0 ? numero(l[col.cxMaster]) : null,
        st: col.st >= 0 ? numero(l[col.st]) : null,
        precoSemIpi: col.precoSemIpi >= 0 ? numero(l[col.precoSemIpi]) : null,
        precoComIpi,
        ipi: col.ipi >= 0 ? numero(l[col.ipi]) : null,
      });
      n++;
    }

    porAba[nomeAba.trim()] = n;
  }

  // O mesmo código pode aparecer em mais de uma aba. O OUTLET vence, porque o
  // preço promocional é o que vale enquanto a promoção estiver no ar.
  const mapa = new Map();
  for (const it of itens) {
    const anterior = mapa.get(it.codigo);
    if (!anterior) { mapa.set(it.codigo, it); continue; }
    if (it.outlet && !anterior.outlet) {
      mapa.set(it.codigo, { ...it, categoriaOriginal: anterior.categoria });
    } else if (!it.outlet && anterior.outlet) {
      mapa.set(it.codigo, { ...anterior, categoriaOriginal: it.categoria });
    }
  }

  return {
    itens: [...mapa.values()],
    porAba,
    avisos,
    duplicados: itens.length - mapa.size,
    abas: Object.keys(porAba),
  };
}

module.exports = { importarPreco };
