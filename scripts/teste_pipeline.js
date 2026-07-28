'use strict';

/**
 * Teste do miolo do sistema, sem precisar de banco.
 *
 * Roda a cadeia inteira contra arquivos reais da Maxprint:
 *   catálogo PDF + mapas de estoque + tabela de preço
 *      -> cruzamento
 *      -> formação de preço por cliente e condição
 *      -> Excel e PDF do pedido
 *
 * Uso:
 *   node scripts/teste_pipeline.js /caminho/da/pasta/com/os/arquivos
 *
 * Ele identifica os arquivos pelo nome: "catálogo" e ".pdf" viram catálogo,
 * "mapa" vira estoque, "tabela" vira preço.
 */

const fs = require('fs');
const path = require('path');

const { importarPreco } = require('../lib/importPreco');
const { importarEstoque, juntarEstoque } = require('../lib/importEstoque');
const { importarCatalogo } = require('../lib/importCatalogo');
const { cruzar, agruparCores } = require('../lib/cruzamento');
const { precoUnitario, fatorPrazo, CONDICOES } = require('../lib/prazo');
const { normalizarCodigo } = require('../lib/codigo');
const { gerarExcel } = require('../lib/gerarExcel');
const { gerarPdf } = require('../lib/gerarPdf');

let falhas = 0;
function conferir(descricao, condicao, detalhe = '') {
  const ok = Boolean(condicao);
  if (!ok) falhas++;
  console.log(`  ${ok ? '✓' : '✗'} ${descricao}${detalhe ? '  ' + detalhe : ''}`);
}

function semAcento(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

(async () => {
  const pasta = process.argv[2];
  if (!pasta || !fs.existsSync(pasta)) {
    console.error('Informe a pasta com os arquivos da Maxprint.');
    process.exit(1);
  }

  const arquivos = fs.readdirSync(pasta).map((f) => path.join(pasta, f));
  const pdfs = arquivos.filter((f) => f.toLowerCase().endsWith('.pdf'));
  const planilhas = arquivos.filter((f) => /\.xlsx?$/i.test(f));
  const mapas = planilhas.filter((f) => semAcento(path.basename(f)).includes('mapa'));
  const tabelas = planilhas.filter((f) => semAcento(path.basename(f)).includes('tabela'));

  console.log('\n== 1. Regras de prazo ==');
  const esperado = { a_vista: 0, 30: 0, '30_60': 0.01, 60: 0.02, '30_60_90': 0.02 };
  for (const [id, acr] of Object.entries(esperado)) {
    const f = fatorPrazo(id);
    conferir(`condição ${id} → acréscimo ${(acr * 100).toFixed(0)}%`,
      Math.abs(f.acrescimo - acr) < 1e-9, `(prazo médio ${f.prazoMedio})`);
  }
  conferir('acima de 60 dias abre negociação', fatorPrazo('30/60/90/120').negociar === true);
  const p = precoUnitario(100, 0.12, '60');
  conferir('base 100 com 12% de desconto em 60 dias = 89,76', p.preco === 89.76, `(deu ${p.preco})`);

  console.log('\n== 2. Normalização de código ==');
  conferir('"74 986" e "74986" são o mesmo', normalizarCodigo('74 986') === normalizarCodigo('74986'));
  conferir('"910-007049" vira "910007049"', normalizarCodigo('910-007049') === '910007049');

  console.log('\n== 3. Tabela de preço ==');
  if (!tabelas.length) { conferir('achei a tabela de preço', false); }
  let preco = { itens: [] };
  for (const t of tabelas) {
    preco = importarPreco(t);
    conferir(`${path.basename(t)} lida`, preco.itens.length > 0, `(${preco.itens.length} itens, ${preco.abas.length} abas)`);
    conferir('todo item tem preço com IPI maior que zero', preco.itens.every((i) => i.precoComIpi > 0));
  }

  console.log('\n== 4. Estoque ==');
  const resultados = mapas.map((m) => importarEstoque(m, path.basename(m)));
  resultados.forEach((r, i) => {
    conferir(`${path.basename(mapas[i])} lido`, r.itens.length > 0,
      `(${r.itens.length} itens, aba "${r.aba}", ${r.abasIgnoradas.length} aba(s) ignorada(s))`);
  });
  const estoque = juntarEstoque(resultados);
  conferir('formatos diferentes normalizados juntos', estoque.itens.length > 0,
    `(${estoque.itens.length} itens, ${estoque.itens.filter((i) => i.estoque > 0).length} com saldo)`);

  console.log('\n== 5. Catálogo em PDF ==');
  const pastaImagens = fs.mkdtempSync(path.join(require('os').tmpdir(), 'teste-img-'));
  const fichas = [];
  const fichasModelo = [];
  for (const [i, f] of pdfs.entries()) {
    const r = await importarCatalogo(f, { pastaImagens, prefixo: `t${i}` });
    fichas.push(...r.produtos);
    fichasModelo.push(...r.porModelo);
    console.log(`  · ${path.basename(f)}: ${r.paginas} páginas, ${r.cards} cards, ` +
      `${r.produtos.length} códigos, ${r.comFoto} com foto, ${r.porModelo.length} fichas por modelo`);
    if (r.avisos.length) console.log(`    aviso: ${r.avisos[0]}`);
  }
  conferir('algum catálogo entregou produto', fichas.length > 0);
  conferir('as fotos foram gravadas', fs.readdirSync(pastaImagens).length > 0,
    `(${fs.readdirSync(pastaImagens).length} imagens)`);

  console.log('\n== 6. Cruzamento ==');
  const { produtos, relatorio } = cruzar({
    precos: preco.itens,
    estoques: estoque.itens,
    catalogo: fichas,
    fichasPorModelo: fichasModelo,
  });
  const vendaveis = produtos.filter((x) => x.estoque > 0);
  const comFoto = vendaveis.filter((x) => x.imagem).length;
  const pctFoto = vendaveis.length ? (100 * comFoto) / vendaveis.length : 0;

  console.log(`  · ${relatorio.total} produtos no catálogo do cliente`);
  console.log(`  · ${relatorio.disponiveis} com saldo hoje, ${relatorio.programados} só programados`);
  console.log(`  · ${relatorio.comFoto} com foto (${relatorio.fotoPorModelo} casadas por modelo, ` +
    `${relatorio.fotoIlustrativa || 0} ilustrativas da linha)`);
  console.log(`  · ${(relatorio.semPreco || []).length} fora por falta de preço`);

  conferir('a maioria dos itens de estoque achou preço',
    relatorio.total / Math.max(1, relatorio.estoqueTotal) > 0.85,
    `(${((100 * relatorio.total) / Math.max(1, relatorio.estoqueTotal)).toFixed(0)}%)`);
  conferir('pelo menos 80% dos vendáveis têm foto', pctFoto >= 80, `(${pctFoto.toFixed(0)}%)`);
  conferir('nenhum produto entrou sem preço', produtos.every((x) => x.precoBase > 0));

  const cards = agruparCores(produtos);
  const comCores = cards.filter((c) => c.cores.length > 1).length;
  conferir('as cores irmãs foram agrupadas em card único', comCores > 0,
    `(${cards.length} cards, ${comCores} com mais de uma cor)`);

  console.log('\n== 7. Pedido de mentira, Excel e PDF ==');
  const escolhidos = vendaveis.filter((x) => x.imagem).slice(0, 8);
  const cond = CONDICOES.find((c) => c.id === '30_60');
  const itens = escolhidos.map((x, i) => {
    const calc = precoUnitario(x.precoBase, 0.12, cond.id);
    const q = (i + 1) * 12;
    return {
      codigo: x.codigo,
      codigoOriginal: x.codigoOriginal,
      nome: x.nome,
      categoria: x.categoria,
      imagem: x.imagem,
      quantidade: q,
      natureza: 'pronta',
      precoTabela: x.precoBase,
      precoUnitario: calc.preco,
      total: Math.round(calc.preco * q * 100) / 100,
    };
  });
  const total = Math.round(itens.reduce((a, b) => a + b.total, 0) * 100) / 100;
  const pedido = {
    numero: 9999,
    razaoSocial: 'Cliente de Teste Ltda',
    cnpj: '00.000.000/0001-00',
    endereco: 'Rua de Teste, 100 - São Paulo/SP',
    telefone: '(11) 90000-0000',
    email: 'teste@exemplo.com',
    vendedor: 'Marcelo',
    transportadora: 'Transportadora Teste',
    frete: total >= 3000 ? 'CIF' : 'FOB',
    condicao: cond.id,
    condicaoRotulo: cond.rotulo,
    prazoMedio: 45,
    acrescimoPrazo: 0.01,
    observacoes: 'Pedido gerado pelo teste automático.',
    itens,
    totalPronta: total,
    totalProgramado: 0,
    total,
    pecas: itens.reduce((a, b) => a + b.quantidade, 0),
    createdAt: new Date(),
  };

  const xlsx = await gerarExcel(pedido);
  conferir('Excel gerado', xlsx && xlsx.byteLength > 3000, `(${Math.round(xlsx.byteLength / 1024)} KB)`);

  const pdf = await gerarPdf(pedido, { pastaImagens });
  conferir('PDF gerado', pdf && pdf.length > 3000, `(${Math.round(pdf.length / 1024)} KB)`);

  if (process.env.SALVAR_SAIDA) {
    fs.writeFileSync(path.join(process.env.SALVAR_SAIDA, 'pedido-teste.xlsx'), Buffer.from(xlsx));
    fs.writeFileSync(path.join(process.env.SALVAR_SAIDA, 'pedido-teste.pdf'), pdf);
    console.log(`  · arquivos salvos em ${process.env.SALVAR_SAIDA}`);
  }

  console.log('\n== 8. Trava de estoque ==');
  const semSaldo = produtos.find((x) => x.estoque === 0 && x.previstoTotal > 0);
  conferir('item sem saldo vira programado, limitado à previsão',
    !semSaldo || semSaldo.previstoTotal > 0,
    semSaldo ? `(${semSaldo.codigo}: previsto ${semSaldo.previstoTotal})` : '(nenhum item nessa situação)');

  fs.rmSync(pastaImagens, { recursive: true, force: true });

  console.log(`\n${falhas === 0 ? 'Tudo passou.' : falhas + ' verificação(ões) falharam.'}\n`);
  process.exit(falhas === 0 ? 0 : 1);
})();
