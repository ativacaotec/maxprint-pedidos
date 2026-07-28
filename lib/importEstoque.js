'use strict';

const XLSX = require('xlsx');
const { normalizarCodigo, codigoPlausivel } = require('./codigo');

/**
 * Importador das planilhas "Mapa de chegadas" — o estoque de pronto entrega.
 *
 * São três arquivos e eles NÃO têm o mesmo formato:
 *
 *   Papelaria / Pilhas / Suprimentos ... MARCA preenchida, previsão JUL a OUT
 *   Informática e Gamer ................ idem, mais uma segunda aba com lixo
 *   Logitech ........................... MARCA vazia, previsão só de AGOSTO
 *
 * Detalhes que o importador precisa engolir sem reclamar:
 *  - o cabeçalho fica na linha 7 e os dados começam na 8
 *  - o arquivo de Informática tem uma aba "Planilha1" com dados velhos e
 *    células com erro #VALUE!, que precisa ser ignorada
 *  - uma linha traz a marca gravada como "," em vez de "MAX"
 *  - as colunas de previsão são nomeadas pelo mês (JUL, AGO, SET, OUT) ou
 *    escritas por extenso (AGOSTO)
 */

const MESES = {
  jan: 1, janeiro: 1, fev: 2, fevereiro: 2, mar: 3, marco: 3, abr: 4, abril: 4,
  mai: 5, maio: 5, jun: 6, junho: 6, jul: 7, julho: 7, ago: 8, agosto: 8,
  set: 9, setembro: 9, out: 10, outubro: 10, nov: 11, novembro: 11,
  dez: 12, dezembro: 12,
};

function chave(txt) {
  return String(txt || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function numero(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function acharCabecalho(linhas) {
  for (let i = 0; i < Math.min(linhas.length, 20); i++) {
    const l = (linhas[i] || []).map(chave);
    if (l.some((c) => c === 'codigoproduto') && l.some((c) => c.startsWith('estoqueatual'))) {
      return i;
    }
  }
  return -1;
}

function importarEstoque(caminhoOuBuffer, nomeArquivo = '') {
  const wb = typeof caminhoOuBuffer === 'string'
    ? XLSX.readFile(caminhoOuBuffer, { cellDates: false })
    : XLSX.read(caminhoOuBuffer, { type: 'buffer', cellDates: false });

  // Só a primeira aba. A segunda aba do arquivo de Informática tem dados
  // antigos e fórmulas quebradas — ler ela criaria produto fantasma.
  const nomeAba = wb.SheetNames[0];
  const ws = wb.Sheets[nomeAba];
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  const iCab = acharCabecalho(linhas);
  if (iCab < 0) {
    return {
      itens: [], avisos: [`Arquivo "${nomeArquivo || nomeAba}": não achei o cabeçalho esperado (Codigo produto / Estoque atual).`],
      aba: nomeAba, abasIgnoradas: wb.SheetNames.slice(1),
    };
  }

  const cab = linhas[iCab] || [];
  const idx = {};
  cab.forEach((c, i) => { const k = chave(c); if (k && idx[k] === undefined) idx[k] = i; });

  const cMarca = idx['marca'];
  const cLinha = idx['linhadeprodutos'];
  const cCodigo = idx['codigoproduto'];
  const cDesc = idx['produtocodigodescricao'] !== undefined ? idx['produtocodigodescricao'] : idx['descricao'];
  const cStatus = idx['status'];
  const cEstoque = Object.entries(idx).find(([k]) => k.startsWith('estoqueatual'))?.[1];

  // Colunas de previsão de chegada: tudo que tem nome de mês.
  const colunasMes = [];
  cab.forEach((c, i) => {
    const k = chave(c);
    if (MESES[k]) colunasMes.push({ col: i, mes: MESES[k], rotulo: String(c).trim() });
  });

  // Coluna de observação: a primeira coluna de texto depois das de mês.
  const ultimoMes = colunasMes.length ? Math.max(...colunasMes.map((m) => m.col)) : cEstoque;
  const cObs = ultimoMes + 1;

  const itens = [];
  const avisos = [];
  const marcasVistas = new Set();

  for (let i = iCab + 1; i < linhas.length; i++) {
    const l = linhas[i] || [];
    const codBruto = cCodigo !== undefined ? l[cCodigo] : null;
    if (!codBruto) continue;

    const codigo = normalizarCodigo(codBruto);
    if (!codigoPlausivel(codigo)) continue;

    let marca = cMarca !== undefined && l[cMarca] ? String(l[cMarca]).trim().toUpperCase() : '';
    // Correção do registro que veio com "," no lugar da marca.
    if (marca && !/^[A-Z]{2,10}$/.test(marca)) {
      avisos.push(`Código ${codigo}: marca gravada como "${marca}", tratada como vazia.`);
      marca = '';
    }
    if (marca) marcasVistas.add(marca);

    const chegadas = colunasMes
      .map((m) => ({ mes: m.mes, rotulo: m.rotulo, quantidade: numero(l[m.col]) || 0 }))
      .filter((c) => c.quantidade > 0);

    itens.push({
      codigo,
      codigoOriginal: String(codBruto).trim(),
      marca,
      linhaProduto: cLinha !== undefined && l[cLinha] ? String(l[cLinha]).trim() : '',
      descricao: cDesc !== undefined && l[cDesc] ? String(l[cDesc]).trim() : '',
      status: cStatus !== undefined && l[cStatus] ? String(l[cStatus]).trim().toUpperCase() : '',
      estoque: Math.max(0, Math.round(numero(l[cEstoque]) || 0)),
      chegadas,
      previstoTotal: chegadas.reduce((a, c) => a + c.quantidade, 0),
      observacao: l[cObs] && typeof l[cObs] === 'string' ? String(l[cObs]).trim() : '',
      origem: nomeArquivo || nomeAba,
    });
  }

  return {
    itens,
    avisos,
    aba: nomeAba,
    abasIgnoradas: wb.SheetNames.slice(1),
    marcas: [...marcasVistas],
    mesesPrevisao: colunasMes.map((m) => m.rotulo),
  };
}

/** Junta vários arquivos de estoque numa base só, com o último upload vencendo. */
function juntarEstoque(resultados) {
  const mapa = new Map();
  const avisos = [];
  for (const r of resultados) {
    avisos.push(...(r.avisos || []));
    for (const it of r.itens) {
      const anterior = mapa.get(it.codigo);
      if (!anterior) { mapa.set(it.codigo, it); continue; }
      // Mesmo código em dois arquivos: soma o saldo e junta as chegadas.
      mapa.set(it.codigo, {
        ...anterior,
        estoque: anterior.estoque + it.estoque,
        chegadas: [...anterior.chegadas, ...it.chegadas],
        previstoTotal: anterior.previstoTotal + it.previstoTotal,
      });
      avisos.push(`Código ${it.codigo} apareceu em mais de um arquivo de estoque; os saldos foram somados.`);
    }
  }
  return { itens: [...mapa.values()], avisos };
}

module.exports = { importarEstoque, juntarEstoque };
