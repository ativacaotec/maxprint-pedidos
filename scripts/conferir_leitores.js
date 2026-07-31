'use strict';

/**
 * Conferência das peças que leem o mundo lá fora: nome de produto, trava de
 * foto repetida e os leitores de página dos sites da Maxprint e da Logitech.
 *
 * Estas peças não têm tela, então não aparecem no conferir_telas. E são
 * exatamente as que já erraram feio: foto trocada entre códigos, cabeçalho de
 * tabela virando nome de produto, sufixo de arquivo derrubando foto boa.
 * Cada checagem aqui guarda um erro que já aconteceu de verdade.
 *
 * Roda sem rede e sem banco: só HTML de mentira, montado com os trechos reais
 * que os sites publicam.
 *
 *   node scripts/conferir_leitores.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { nomeSuspeito, ehCabecalhoDeTabela, ehSobraDeDescricao } = require('../lib/nomeDeProduto');
const { criarTravaDeFotos, aplicarAcao } = require('../lib/travaDeFotos');
const { fotosDaPagina, coresDaPagina } = require('../lib/buscarFotosMaxprint');
const { lerPaginaDeProduto, produtosDaLista } = require('../lib/buscarFotosLogitech');

const resultados = [];
function conferir(oQue, passou, detalhe) {
  resultados.push({ oQue, passou, detalhe });
  console.log(`  ${passou ? '✓' : '✗'} ${oQue}${passou ? '' : `  → ${detalhe || ''}`}`);
}

/* ------------------------------------------------------------------ *
 * 1. Nome de produto
 * ------------------------------------------------------------------ */
console.log('\nNome de produto:');

// Os três casos que foram para o ar em 30/07/2026.
conferir('o cabeçalho da tabela de etiquetas não é nome',
  nomeSuspeito('CÓD. MODELO FORM. DA ETIQ. QTDE. POR EMB.'));
conferir('sobra de descrição em minúscula não é nome',
  nomeSuspeito('bidestro para maior conforto e longas horas de uso.'));
conferir('linha de embalagem colada na descrição não é nome',
  nomeSuspeito('classe 4 TIPO DE EMBALAGEM: CAIXA'));

// E o que NÃO pode ser derrubado junto.
for (const bom of [
  'MOUSE SEM FIO M110 PRETO',
  'ETIQUETA INK MAXPRINT A4363 38.1MM X 99MM 100 FOLHAS BRANCA',
  'TECLADO MULTIMÍDIA SLIM',
  'CANETA MARCA TEXTO MAXPRINT NEEDS LARANJA',
  'MODELO EXCLUSIVO GAMER RGB',
]) {
  conferir(`"${bom.slice(0, 34)}..." continua valendo como nome`, !nomeSuspeito(bom), bom);
}

conferir('exige três rótulos para chamar de cabeçalho',
  !ehCabecalhoDeTabela('CAIXA COM 12 UNIDADES'), 'CAIXA COM 12 UNIDADES');
conferir('nome em maiúscula nunca é sobra de descrição',
  !ehSobraDeDescricao('CANETA NEEDS'));

/* ------------------------------------------------------------------ *
 * 2. Trava de foto repetida
 * ------------------------------------------------------------------ */
console.log('\nTrava de foto repetida:');

(async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'trava-'));
  const trava = criarTravaDeFotos({ pastaImagens: pasta });
  const resultadosFoto = [];
  const origemDe = new Map([['A', 'site'], ['B', 'site'], ['C', 'site'], ['D', 'site']]);
  const apagados = [];
  const ctx = { resultados: resultadosFoto, origemDe, aoBaixar: null, aoDescartar: async (c) => apagados.push(c) };

  const fotoUm = Buffer.from('imagem-um'.repeat(60));
  const fotoDois = Buffer.from('imagem-dois'.repeat(60));
  const aplicar = async (codigo, arquivo, buffer) => {
    for (const acao of trava.oferecer({ codigo, arquivo, buffer })) await aplicarAcao(acao, ctx);
  };

  await aplicar('A', 'a.jpg', fotoUm);
  await aplicar('B', 'b.jpg', fotoDois);
  conferir('foto única fica com o dono, sem ressalva',
    resultadosFoto.length === 2 && resultadosFoto.every((r) => !r.ilustrativa),
    JSON.stringify(resultadosFoto.map((r) => r.codigo + (r.ilustrativa ? '*' : ''))));

  await aplicar('C', 'c.jpg', fotoUm);
  const a = resultadosFoto.find((r) => r.codigo === 'A');
  const c = resultadosFoto.find((r) => r.codigo === 'C');
  conferir('dois códigos irmãos ficam os dois, marcados como foto da linha',
    !!a && !!c && a.ilustrativa && c.ilustrativa && a.arquivo === c.arquivo,
    JSON.stringify(resultadosFoto.map((r) => r.codigo + (r.ilustrativa ? '*' : ''))));

  await aplicar('D', 'd.jpg', fotoUm);
  conferir('a partir do terceiro é imagem genérica e ninguém fica',
    !resultadosFoto.some((r) => ['A', 'C', 'D'].includes(r.codigo)),
    JSON.stringify(resultadosFoto.map((r) => r.codigo)));
  conferir('e o que já tinha sido gravado é desfeito no banco',
    ['A', 'C', 'D'].every((x) => apagados.includes(x)), apagados.join(', '));
  conferir('e o arquivo genérico sai do disco',
    !fs.existsSync(path.join(pasta, 'a.jpg')), fs.readdirSync(pasta).join(', '));
  conferir('a foto que não repetiu continua de pé',
    resultadosFoto.some((r) => r.codigo === 'B') && fs.existsSync(path.join(pasta, 'b.jpg')));

  fs.rmSync(pasta, { recursive: true, force: true });

  /* ---------------------------------------------------------------- *
   * 3. Leitor da página da Maxprint
   * ---------------------------------------------------------------- */
  console.log('\nLeitor do site da Maxprint:');

  const variacoes = JSON.stringify([
    { sku: '70000132', attributes: { attribute_pa_color: 'laranja' },
      image: { src: 'https://www.maxprint.com.br/wp-content/uploads/a/70000132-2-1-700x700.jpg',
               full_src: 'https://www.maxprint.com.br/wp-content/uploads/a/70000132-2-1.jpg' } },
    { sku: '70000134', attributes: { attribute_pa_color: 'rosa' },
      image: { src: 'https://www.maxprint.com.br/wp-content/uploads/a/70000134-2-1-700x700.jpg' } },
  ]).replace(/"/g, '&quot;');

  const pagina = `<h1>Caneta Marca Texto Maxprint Needs</h1>
    <form data-product_variations="${variacoes}"></form>
    <img src="https://www.maxprint.com.br/wp-content/uploads/a/603579-4.jpg">
    <img src="https://www.maxprint.com.br/wp-content/uploads/a/60000046-300x300.jpg">
    <img src="https://www.maxprint.com.br/wp-content/uploads/a/FUNDO_SITE.png">`;

  const cores = coresDaPagina(pagina);
  conferir('lê o SKU e a foto de cada cor da variação',
    cores.length === 2 && cores.map((x) => x.codigo).join(',') === '70000132,70000134',
    JSON.stringify(cores.map((x) => x.codigo)));
  conferir('e prefere o arquivo original ao redimensionado',
    cores.every((x) => !/-\d+x\d+\./.test(x.url)),
    JSON.stringify(cores.map((x) => x.url.split('/').pop())));
  conferir('e traz a cor para montar o nome',
    cores[0].cor === 'Laranja' && cores[1].cor === 'Rosa',
    JSON.stringify(cores.map((x) => x.cor)));

  const todas = fotosDaPagina(pagina);
  conferir('aceita sufixo empilhado no nome do arquivo (70000134-2-1)',
    todas.some((f) => f.codigo === '70000134' && /70000134-2-1\.jpg$/.test(f.url)),
    JSON.stringify(todas.map((f) => f.url.split('/').pop())));
  conferir('a foto da variação vem antes da achada pelo nome',
    Math.min(...todas.map((f) => f.ordem)) === -1);
  conferir('miniatura e fundo de página ficam de fora',
    !todas.some((f) => /300x300|FUNDO/i.test(f.url)),
    JSON.stringify(todas.map((f) => f.url.split('/').pop())));
  conferir('página sem variação não quebra o leitor',
    coresDaPagina('<form data-product_variations="false"></form>').length === 0);

  /* ---------------------------------------------------------------- *
   * 4. Leitor da loja da Logitech
   * ---------------------------------------------------------------- */
  console.log('\nLeitor da loja da Logitech:');

  const logi = `<body class="catalog_product_view catalog_product_view_sku_981-000014">
    <div data-product-sku="981-000014"></div>
    <meta property="og:image"
      content="https://www.logitechstore.com.br/media/catalog/product/cache/5a006326031173eae4a26debfef96900/h/3/h390.png" />`;
  const lido = lerPaginaDeProduto(logi);
  conferir('lê o part number da página', lido && lido.sku === '981-000014', JSON.stringify(lido));
  conferir('e chega no arquivo original, sem o trecho de cache do Magento',
    lido && lido.imagem === 'https://www.logitechstore.com.br/media/catalog/product/h/3/h390.png',
    lido && lido.imagem);

  const conflito = lerPaginaDeProduto(logi.replace('catalog_product_view_sku_981-000014', 'catalog_product_view_sku_910-004053'));
  conferir('código que aparece de dois jeitos na mesma página é recusado',
    conflito && conflito.conflito === true, JSON.stringify(conflito));

  conferir('página sem código é ignorada em vez de chutar',
    lerPaginaDeProduto('<html><body>sem sku aqui</body></html>') === null);

  const lista = produtosDaLista(`<a class="product-item-link"
      href="https://www.logitechstore.com.br/mouse-m170/">Mouse</a>
      <a href="https://www.logitechstore.com.br/institucional/">Sobre</a>`);
  conferir('a listagem devolve só link de produto',
    lista.length === 1 && /mouse-m170/.test(lista[0]), JSON.stringify(lista));

  /* ------------------------------ fim ---------------------------- */
  const falharam = resultados.filter((r) => !r.passou);
  console.log('\n===================== resultado =====================');
  console.log(`${resultados.length - falharam.length}/${resultados.length} checagens passaram`);
  falharam.forEach((r) => console.log(`  ✗ ${r.oQue}  → ${r.detalhe || ''}`));
  process.exit(falharam.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
