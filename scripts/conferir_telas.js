'use strict';

/**
 * Abre o sistema num navegador de verdade, passa pelas telas e tira foto de
 * cada uma. É assim que eu confiro que as telas funcionam antes de publicar,
 * em vez de só olhar o código e torcer.
 *
 *   node scripts/conferir_telas.js
 *   → fotos em /tmp/telas/
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORTA = 3999;
const BASE = `http://127.0.0.1:${PORTA}`;
const SAIDA = '/tmp/telas';

// Tudo que o navegador reclamar (erro de JS, 404, exceção) é coletado aqui:
// tela que "parece certa" mas quebrou no console não passa no teste.
const problemas = [];
const checagens = [];

/** Uma afirmação sobre o comportamento da tela, conferida no navegador. */
function conferir(oQue, passou, detalhe) {
  checagens.push({ oQue, passou, detalhe });
  console.log(`  ${passou ? '✓' : '✗'} ${oQue}${detalhe && !passou ? '  → ' + detalhe : ''}`);
}

async function esperarNoAr(tentativas = 40) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(`${BASE}/api/saude`);
      if (r.ok) return true;
    } catch (_) { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('o servidor de teste não subiu a tempo');
}

async function foto(pagina, nome) {
  await pagina.screenshot({ path: path.join(SAIDA, `${nome}.png`), fullPage: true });
  console.log('  · ' + nome);
}

async function entrar(pagina, usuario, senha) {
  await pagina.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await pagina.fill('#usuario', usuario);
  await pagina.fill('#senha', senha);
  await pagina.click('button[type=submit], #entrar, button.primaria');
  await pagina.waitForLoadState('networkidle');
}

(async () => {
  fs.mkdirSync(SAIDA, { recursive: true });

  const servidor = spawn('node', [path.join(__dirname, 'servidor_de_teste.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORTA) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stderr.on('data', (d) => problemas.push('servidor: ' + String(d).trim()));

  try {
    await esperarNoAr();
    console.log('Servidor de teste no ar.\n');

    const navegador = await chromium.launch();

    /* =================== painel do admin, em desktop =================== */
    const ctx = await navegador.newContext({ viewport: { width: 1400, height: 1000 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => problemas.push(`erro de JS: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') problemas.push(`console: ${m.text()}`); });
    p.on('response', (r) => {
      if (r.status() >= 400) problemas.push(`${r.status()} em ${r.url().replace(BASE, '')}`);
    });

    console.log('Painel do administrador:');
    await entrar(p, 'marcelo', 'teste123');
    await p.waitForTimeout(900);
    await foto(p, '01-painel-pedidos');

    for (const [aba, nome] of [
      ['importar', '02-painel-importar'],
      ['clientes', '03-painel-clientes'],
      ['marcas', '04-painel-marcas'],
      ['produtos', '05-painel-produtos'],
    ]) {
      await p.click(`.abas button[data-aba="${aba}"]`);
      await p.waitForTimeout(800);
      await foto(p, nome);
    }

    // O formulário do cliente é o que ganhou as marcas: abro para conferir.
    await p.click('.abas button[data-aba="clientes"]');
    await p.waitForTimeout(700);
    await p.click('#novo-cliente');
    await p.waitForTimeout(400);
    await foto(p, '06-form-cliente-marcas');

    /* ====================== catálogo do cliente ======================== */
    const ctx2 = await navegador.newContext({ viewport: { width: 1400, height: 1000 } });
    const c = await ctx2.newPage();
    c.on('pageerror', (e) => problemas.push(`erro de JS (catálogo): ${e.message}`));
    c.on('console', (m) => { if (m.type() === 'error') problemas.push(`console (catálogo): ${m.text()}`); });
    c.on('response', (r) => {
      if (r.status() >= 400) problemas.push(`${r.status()} em ${r.url().replace(BASE, '')}`);
    });

    console.log('\nCatálogo do cliente:');
    await entrar(c, 'cliente', 'teste123');
    await c.waitForTimeout(1400);
    await foto(c, '10-catalogo-maxprint');

    // --- as abas de marca existem e trocam de catálogo? ---
    const abas = await c.$$eval('.abas-marca button', (bs) => bs.map((b) => b.textContent.trim()));
    conferir('as duas abas de marca aparecem', abas.length === 2, abas.join(' / '));

    await c.click('.abas-marca button[data-marca="samsonite"]');
    await c.waitForTimeout(1400);
    await foto(c, '11-catalogo-samsonite');

    const tituloAba = await c.title();
    conferir('a aba muda o título da página', /Samsonite/.test(tituloAba), tituloAba);

    const corDaMarca = await c.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--laranja').trim());
    conferir('a cor da marca é aplicada na tela', corDaMarca.toLowerCase() === '#0b6bb3', corDaMarca);

    // --- a janela com todas as cores abre e mostra as três? ---
    const temVerCores = await c.$('[data-ver-cores]');
    conferir('produto com várias cores oferece "ver as cores"', !!temVerCores);
    if (temVerCores) {
      await temVerCores.click();
      await c.waitForTimeout(600);
      const itens = await c.$$eval('.cor-item', (n) => n.length);
      conferir('a janela mostra as 3 cores da linha', itens === 3, itens + ' cores');
      const nomes = await c.$$eval('.cor-item .nome-cor', (n) => n.map((x) => x.textContent.trim()));
      conferir('cada cor aparece com o nome dela', nomes.includes('NAVY BLUE'), nomes.join(', '));
      await foto(c, '12-janela-cores');
      await c.click('#j-fechar');
      await c.waitForTimeout(300);
    }

    // --- carrinho separado por marca ---
    // Miro no BAHIA LITE preto de propósito: é o item com saldo grande, o
    // único que permite chegar aos R$ 15.000 sem esbarrar no estoque.
    const BAHIA = '.card input[data-qtd="146203D1101"]';
    await c.fill(BAHIA, '2');
    await c.waitForTimeout(1200);
    const badgeSam = await c.textContent('#badge');
    await c.click('.abas-marca button[data-marca="maxprint"]');
    await c.waitForTimeout(1400);
    const badgeMax = await c.textContent('#badge');
    conferir('o carrinho da Samsonite não vaza para a Maxprint',
      badgeSam === '1' && badgeMax === '0', `samsonite=${badgeSam} maxprint=${badgeMax}`);
    await c.click('.abas-marca button[data-marca="samsonite"]');
    await c.waitForTimeout(1400);
    const badgeVolta = await c.textContent('#badge');
    conferir('e volta intacto ao retornar para a aba', badgeVolta === '1', 'badge=' + badgeVolta);

    // --- prazo longo da Samsonite só acima de R$ 15.000 ---
    const travadas = await c.$$eval('#condicao option[disabled]', (o) => o.map((x) => x.value));
    conferir('60/90, 90 e 60/90/120 ficam travados num pedido pequeno',
      travadas.length === 3, travadas.join(', '));

    // 20 unidades de R$ 1.099,90 com 12% de desconto passa dos R$ 15.000
    await c.fill(BAHIA, '20');
    await c.waitForTimeout(1600);
    const travadasDepois = await c.$$eval('#condicao option[disabled]', (o) => o.length);
    conferir('e liberam quando o pedido passa de R$ 15.000',
      travadasDepois === 0, travadasDepois + ' ainda travados');
    await foto(c, '13-prazo-liberado');

    // --- pedir mais do que existe avisa o cliente ---
    await c.fill(BAHIA, '9999');
    await c.waitForTimeout(1600);
    const avisoEstoque = await c.textContent('#avisos');
    conferir('pedir acima do saldo mostra aviso na tela',
      /estoque/i.test(avisoEstoque || ''), JSON.stringify(avisoEstoque));
    const marcouCampo = await c.$eval(BAHIA, (e) => e.classList.contains('excedeu'));
    conferir('e marca o campo de quantidade em vermelho', marcouCampo);
    await foto(c, '14-acima-do-saldo');
    await c.fill(BAHIA, '20');
    await c.waitForTimeout(1200);

    // --- cliente de uma marca só não vê a barra de abas ---
    const ctxSo = await navegador.newContext({ viewport: { width: 1400, height: 1000 } });
    const so = await ctxSo.newPage();
    await entrar(so, 'sominha', 'teste123');
    await so.waitForTimeout(1300);
    const abasVisiveis = await so.$eval('#abas-marca', (e) => getComputedStyle(e).display !== 'none');
    conferir('cliente com uma marca só não vê a barra de abas', !abasVisiveis);
    await ctxSo.close();

    /* ======================= catálogo no celular ======================= */
    const ctx3 = await navegador.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    });
    const m = await ctx3.newPage();
    m.on('pageerror', (e) => problemas.push(`erro de JS (celular): ${e.message}`));

    console.log('\nNo celular:');
    await entrar(m, 'cliente', 'teste123');
    await m.waitForTimeout(1400);
    await foto(m, '20-catalogo-celular');

    // Estar no HTML não basta: o que importa é estar VISÍVEL e clicável.
    // Foi assim que apareceu o caso das abas escondidas atrás do cabeçalho.
    const abaSam = await m.$('.abas-marca button[data-marca="samsonite"]');
    conferir('a aba de marca existe no celular', !!abaSam);
    if (abaSam) {
      const cx = await abaSam.boundingBox();
      const naFrente = cx ? await m.evaluate(({ x, y }) => {
        const alvo = document.elementFromPoint(x, y);
        return !!(alvo && alvo.closest('.abas-marca'));
      }, { x: cx.x + cx.width / 2, y: cx.y + cx.height / 2 }) : false;
      conferir('e está clicável, não escondida atrás do cabeçalho', naFrente);

      await abaSam.click();
      await m.waitForTimeout(1400);
      await foto(m, '22-samsonite-celular');

      const abriuSam = await m.$$eval('.card', (n) => n.length);
      conferir('trocar de marca no celular carrega o outro catálogo', abriuSam > 0, abriuSam + ' cards');

      // A janela de cores é o pedido central do Marcelo; precisa caber aqui.
      const verCores = await m.$('[data-ver-cores]');
      if (verCores) {
        await verCores.click();
        await m.waitForTimeout(600);
        await foto(m, '23-janela-cores-celular');
        const cabe = await m.$eval('.janela', (e) => e.getBoundingClientRect().width <= window.innerWidth);
        conferir('a janela de cores cabe na largura do celular', cabe);
        await m.click('#j-fechar');
      }
    }

    const ma = await ctx3.newPage();
    await entrar(ma, 'marcelo', 'teste123');
    await ma.waitForTimeout(900);
    await foto(ma, '21-painel-celular');

    await navegador.close();
  } finally {
    servidor.kill();
  }

  const falharam = checagens.filter((c) => !c.passou);
  console.log('\n===================== resultado =====================');
  console.log(`checagens: ${checagens.length - falharam.length}/${checagens.length} passaram`);
  falharam.forEach((c) => console.log(`  ✗ ${c.oQue}  → ${c.detalhe || ''}`));

  console.log('\nproblemas do navegador:');
  if (!problemas.length) console.log('  nenhum.');
  else [...new Set(problemas)].forEach((x) => console.log('  ! ' + x));

  console.log(`\nFotos em ${SAIDA}`);
  process.exit(falharam.length || problemas.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
