'use strict';

const ExcelJS = require('exceljs');

/**
 * Gera o Excel do pedido no MESMO formato da aba PEDIDO da planilha "Tabela
 * Maxprint" que o Marcelo usa hoje. Isso não é capricho: é o formato que ele já
 * encaixa no fluxo de digitação no portal da indústria. Mudar o layout obrigaria
 * a mudar o hábito, e o sistema existe para tirar trabalho, não para criar.
 *
 * Cabeçalho: Razão Social, CNPJ, Endereço | Prazo, Frete, Obs. | Telefone,
 * Vendedor, E-mail, e o Total do Pedido.
 * Linhas: Código, Produto, QTD, Preço c/ Desconto (c/IPI), Total.
 *
 * A única coisa que acrescentei é a coluna "Entrega", que separa o que sai do
 * pronto entrega do que é pedido programado. Sem ela, o pedido misturaria o que
 * sai hoje com o que só chega em agosto.
 */

const LARANJA = 'FFEB8704';
const PRETO = 'FF000000';
const CINZA = 'FFF4F4F5';

async function gerarExcel(pedido) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Ativação Group';
  wb.created = new Date();

  const ws = wb.addWorksheet('PEDIDO', {
    views: [{ state: 'frozen', ySplit: 8 }],
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  ws.columns = [
    { width: 3 },   // A
    { width: 16 },  // B - Código
    { width: 58 },  // C - Produto
    { width: 10 },  // D - QTD
    { width: 20 },  // E - Preço
    { width: 18 },  // F - Total
    { width: 16 },  // G - Entrega
  ];

  const rotulo = (cel, texto) => {
    ws.getCell(cel).value = texto;
    ws.getCell(cel).font = { bold: true, size: 10 };
  };
  const valor = (cel, texto) => {
    ws.getCell(cel).value = texto || '';
    ws.getCell(cel).font = { size: 10 };
  };

  ws.mergeCells('B1:G1');
  ws.getCell('B1').value = `PEDIDO Nº ${pedido.numero}  ·  ATIVAÇÃO GROUP  ·  MAXPRINT`;
  ws.getCell('B1').font = { bold: true, size: 13, color: { argb: PRETO } };
  ws.getCell('B1').alignment = { vertical: 'middle' };
  ws.getRow(1).height = 24;

  rotulo('B2', 'Razão Social'); valor('C2', pedido.razaoSocial);
  rotulo('E2', 'Prazo');        valor('F2', pedido.condicaoRotulo);
  rotulo('B3', 'CNPJ');         valor('C3', pedido.cnpj);
  rotulo('E3', 'Frete');        valor('F3', pedido.frete);
  rotulo('B4', 'Endereço');     valor('C4', pedido.endereco);
  rotulo('E4', 'Obs.');         valor('F4', pedido.observacoes);
  rotulo('B5', 'Telefone');     valor('C5', pedido.telefone);
  rotulo('E5', 'Vendedor');     valor('F5', pedido.vendedor);
  rotulo('B6', 'E-mail');       valor('C6', pedido.email);
  rotulo('E6', 'Transportadora'); valor('F6', pedido.transportadora);

  ws.getCell('E7').value = 'Total do Pedido:';
  ws.getCell('E7').font = { bold: true, size: 11 };
  ws.getCell('F7').value = Number(pedido.total || 0);
  ws.getCell('F7').numFmt = 'R$ #,##0.00';
  ws.getCell('F7').font = { bold: true, size: 12, color: { argb: LARANJA } };

  const cabecalho = ws.getRow(8);
  cabecalho.values = ['', 'Código', 'Produto', 'QTD', 'Preço c/ Desconto (c/IPI)', 'Total c/ Desconto (c/IPI)', 'Entrega'];
  cabecalho.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
  cabecalho.height = 22;
  for (let c = 2; c <= 7; c++) {
    const cel = cabecalho.getCell(c);
    cel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PRETO } };
    cel.alignment = { vertical: 'middle', horizontal: c === 3 ? 'left' : 'center', wrapText: true };
  }

  let linha = 9;
  const ordenados = [...(pedido.itens || [])].sort((a, b) => {
    if (a.natureza !== b.natureza) return a.natureza === 'pronta' ? -1 : 1;
    return String(a.codigo).localeCompare(String(b.codigo));
  });

  for (const it of ordenados) {
    const r = ws.getRow(linha);
    r.getCell(2).value = it.codigoOriginal || it.codigo;
    r.getCell(3).value = it.nome;
    r.getCell(4).value = it.quantidade;
    r.getCell(5).value = Number(it.precoUnitario || 0);
    r.getCell(6).value = Number(it.total || 0);
    r.getCell(7).value = it.natureza === 'programado'
      ? `Programado${it.mesChegada ? ' ' + it.mesChegada : ''}`
      : 'Pronta entrega';

    r.getCell(5).numFmt = 'R$ #,##0.0000';
    r.getCell(6).numFmt = 'R$ #,##0.00';
    r.getCell(4).alignment = { horizontal: 'center' };
    r.getCell(7).alignment = { horizontal: 'center' };
    r.font = { size: 10 };

    if (linha % 2 === 0) {
      for (let c = 2; c <= 7; c++) {
        r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CINZA } };
      }
    }
    if (it.natureza === 'programado') {
      r.getCell(7).font = { size: 10, bold: true, color: { argb: LARANJA } };
    }
    linha++;
  }

  // Totais
  linha++;
  const somar = (rotuloTexto, valorNum, negrito) => {
    const r = ws.getRow(linha);
    r.getCell(5).value = rotuloTexto;
    r.getCell(5).font = { bold: !!negrito, size: 10 };
    r.getCell(5).alignment = { horizontal: 'right' };
    r.getCell(6).value = Number(valorNum || 0);
    r.getCell(6).numFmt = 'R$ #,##0.00';
    r.getCell(6).font = { bold: !!negrito, size: negrito ? 12 : 10 };
    linha++;
  };

  if (pedido.totalProgramado > 0) {
    somar('Pronta entrega', pedido.totalPronta, false);
    somar('Programado', pedido.totalProgramado, false);
  }
  somar('TOTAL DO PEDIDO', pedido.total, true);
  ws.getRow(linha - 1).getCell(6).font = { bold: true, size: 12, color: { argb: LARANJA } };

  linha++;
  ws.getCell(`C${linha}`).value =
    `${pedido.pecas} peças  ·  ${(pedido.itens || []).length} itens  ·  ` +
    `condição ${pedido.condicaoRotulo}` +
    (pedido.acrescimoPrazo ? `  ·  acréscimo de prazo ${(pedido.acrescimoPrazo * 100).toFixed(2)}%` : '');
  ws.getCell(`C${linha}`).font = { size: 9, italic: true, color: { argb: 'FF8D8E8E' } };

  return wb.xlsx.writeBuffer();
}

module.exports = { gerarExcel };
