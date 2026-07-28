'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

/**
 * PDF do pedido, com foto pequena de cada item e as informações completas.
 *
 * Serve para duas coisas: o cliente confere o que pediu olhando o produto, e o
 * Marcelo confere o pedido sem precisar abrir o catálogo do lado.
 */

const LARANJA = '#EB8704';
const PRETO = '#111111';
const CINZA = '#8D8E8E';
const CINZA_CLARO = '#F4F4F5';

const MARGEM = 36;
const ALTURA_LINHA = 46;

function dinheiro(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function gerarPdf(pedido, opcoes = {}) {
  const pastaImagens = opcoes.pastaImagens || path.join(__dirname, '..', 'public', 'img');
  const logo = opcoes.logo || path.join(__dirname, '..', 'public', 'logos', 'ativacao.png');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGEM, bufferPages: true });
    const pedacos = [];
    doc.on('data', (d) => pedacos.push(d));
    doc.on('end', () => resolve(Buffer.concat(pedacos)));
    doc.on('error', reject);

    const larguraUtil = doc.page.width - MARGEM * 2;

    /* ---------------------------- cabeçalho ---------------------------- */
    let y = MARGEM;
    if (fs.existsSync(logo)) {
      try { doc.image(logo, MARGEM, y, { height: 26 }); } catch (_) { /* segue sem logo */ }
    }
    doc.font('Helvetica-Bold').fontSize(16).fillColor(PRETO)
      .text(`PEDIDO Nº ${pedido.numero}`, MARGEM, y + 2, { width: larguraUtil, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor(CINZA)
      .text(`Maxprint · emitido em ${new Date(pedido.createdAt || Date.now()).toLocaleString('pt-BR')}`,
        MARGEM, y + 22, { width: larguraUtil, align: 'right' });

    y += 44;
    doc.moveTo(MARGEM, y).lineTo(doc.page.width - MARGEM, y).strokeColor(LARANJA).lineWidth(2).stroke();
    y += 14;

    /* ------------------------- dados do pedido ------------------------- */
    const col = larguraUtil / 2;
    const par = (rotulo, valor, x, yy) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(CINZA).text(rotulo.toUpperCase(), x, yy);
      doc.font('Helvetica').fontSize(10).fillColor(PRETO)
        .text(valor || '-', x, yy + 10, { width: col - 12 });
    };

    par('Cliente', pedido.razaoSocial, MARGEM, y);
    par('CNPJ', pedido.cnpj, MARGEM + col, y);
    y += 30;
    par('Endereço de entrega', pedido.endereco, MARGEM, y);
    par('Transportadora / frete', `${pedido.transportadora || '-'} · ${pedido.frete || '-'}`, MARGEM + col, y);
    y += 30;
    par('Condição de pagamento', pedido.condicaoRotulo, MARGEM, y);
    par('Vendedor', pedido.vendedor, MARGEM + col, y);
    y += 30;
    if (pedido.observacoes) {
      par('Observações', pedido.observacoes, MARGEM, y);
      y += 30;
    }

    y += 4;

    /* --------------------------- lista de itens ------------------------ */
    const colFoto = 42;
    const xFoto = MARGEM;
    const xNome = MARGEM + colFoto + 8;
    const larguraNome = larguraUtil - colFoto - 8 - 190;
    const xQtd = doc.page.width - MARGEM - 190;
    const xUnit = doc.page.width - MARGEM - 130;
    const xTotal = doc.page.width - MARGEM - 60;

    const cabecalhoTabela = (yy) => {
      doc.rect(MARGEM, yy, larguraUtil, 18).fill(PRETO);
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF');
      doc.text('PRODUTO', xNome, yy + 6, { width: larguraNome });
      doc.text('QTD', xQtd, yy + 6, { width: 50, align: 'center' });
      doc.text('UNIT.', xUnit, yy + 6, { width: 60, align: 'right' });
      doc.text('TOTAL', xTotal, yy + 6, { width: 60, align: 'right' });
      return yy + 24;
    };

    y = cabecalhoTabela(y);

    const itens = [...(pedido.itens || [])].sort((a, b) => {
      if (a.natureza !== b.natureza) return a.natureza === 'pronta' ? -1 : 1;
      return String(a.codigo).localeCompare(String(b.codigo));
    });

    let listrada = false;
    for (const it of itens) {
      if (y + ALTURA_LINHA > doc.page.height - MARGEM - 90) {
        doc.addPage();
        y = MARGEM;
        y = cabecalhoTabela(y);
      }

      if (listrada) doc.rect(MARGEM, y - 4, larguraUtil, ALTURA_LINHA).fill(CINZA_CLARO);
      listrada = !listrada;

      const arq = it.imagem ? path.join(pastaImagens, it.imagem) : '';
      if (arq && fs.existsSync(arq)) {
        try {
          doc.image(arq, xFoto, y - 2, { fit: [colFoto, ALTURA_LINHA - 6], align: 'center', valign: 'center' });
        } catch (_) { /* item sem foto não trava o PDF */ }
      } else {
        doc.rect(xFoto, y - 2, colFoto, ALTURA_LINHA - 6).fill('#E7E7E9');
      }

      doc.font('Helvetica-Bold').fontSize(9).fillColor(PRETO)
        .text(String(it.nome || '').slice(0, 90), xNome, y, { width: larguraNome, height: 22, ellipsis: true });
      doc.font('Helvetica').fontSize(7.5).fillColor(CINZA)
        .text(
          `cód. ${it.codigoOriginal || it.codigo}` +
          (it.categoria ? `  ·  ${it.categoria}` : '') +
          (it.natureza === 'programado' ? `  ·  PROGRAMADO${it.mesChegada ? ' ' + it.mesChegada : ''}` : ''),
          xNome, y + 22, { width: larguraNome }
        );

      doc.font('Helvetica-Bold').fontSize(10).fillColor(PRETO)
        .text(String(it.quantidade), xQtd, y + 8, { width: 50, align: 'center' });
      doc.font('Helvetica').fontSize(9).fillColor(PRETO)
        .text(dinheiro(it.precoUnitario), xUnit, y + 9, { width: 60, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(PRETO)
        .text(dinheiro(it.total), xTotal, y + 9, { width: 60, align: 'right' });

      y += ALTURA_LINHA;
    }

    /* ------------------------------ totais ----------------------------- */
    y += 8;
    if (y > doc.page.height - MARGEM - 90) { doc.addPage(); y = MARGEM; }

    doc.moveTo(MARGEM, y).lineTo(doc.page.width - MARGEM, y).strokeColor('#DDDDDD').lineWidth(1).stroke();
    y += 10;

    const totalLinha = (rotulo, valor, destaque) => {
      doc.font(destaque ? 'Helvetica-Bold' : 'Helvetica').fontSize(destaque ? 12 : 10)
        .fillColor(destaque ? PRETO : CINZA)
        .text(rotulo, xQtd - 120, y, { width: 220, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(destaque ? 13 : 10)
        .fillColor(destaque ? LARANJA : PRETO)
        .text(dinheiro(valor), xTotal - 60, y - 1, { width: 120, align: 'right' });
      y += destaque ? 20 : 15;
    };

    if (pedido.totalProgramado > 0) {
      totalLinha('Pronta entrega', pedido.totalPronta, false);
      totalLinha('Programado', pedido.totalProgramado, false);
    }
    totalLinha('TOTAL DO PEDIDO', pedido.total, true);

    doc.font('Helvetica').fontSize(8).fillColor(CINZA).text(
      `${pedido.pecas} peças em ${(pedido.itens || []).length} itens  ·  condição ${pedido.condicaoRotulo}` +
      (pedido.acrescimoPrazo ? `  ·  acréscimo de prazo ${(pedido.acrescimoPrazo * 100).toFixed(2)}%` : '') +
      (pedido.frete ? `  ·  frete ${pedido.frete}` : ''),
      MARGEM, y + 4, { width: larguraUtil, align: 'right' }
    );

    /* ---------------------------- rodapé ------------------------------- */
    const paginas = doc.bufferedPageRange();
    for (let i = 0; i < paginas.count; i++) {
      doc.switchToPage(paginas.start + i);
      doc.font('Helvetica').fontSize(7.5).fillColor(CINZA).text(
        `Ativação Group · representação Maxprint · pedido ${pedido.numero} · página ${i + 1} de ${paginas.count}`,
        MARGEM, doc.page.height - 28, { width: larguraUtil, align: 'center' }
      );
    }

    doc.end();
  });
}

module.exports = { gerarPdf };
