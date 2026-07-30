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

    const navegador = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });

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
    await p.click('#tapa', { position: { x: 5, y: 5 } });
    await p.waitForTimeout(400);

    // --- troca de senha do cliente ---
    // Miro no cliente descartável: trocar a senha de qualquer outro derrubaria
    // os logins que os testes seguintes usam.
    await p.evaluate(() => {
      const linha = [...document.querySelectorAll('tbody tr')]
        .find((tr) => tr.textContent.includes('ZZ Cliente Descartavel'));
      linha.querySelector('[data-senha]').click();
    });
    await p.waitForTimeout(600);
    const temCampoSenha = await p.$('#s-nova');
    conferir('a tela de nova senha deixa escolher a senha', !!temCampoSenha);
    if (temCampoSenha) {
      await p.click('#s-sortear');
      await p.waitForTimeout(700);
      const sorteada = await p.inputValue('#s-nova');
      conferir('e o botão sorteia uma senha', /^[a-z]{4}-[0-9]{4}$/.test(sorteada), sorteada);
      await foto(p, '07-nova-senha');

      await p.fill('#s-nova', 'abc');
      await p.click('#s-salvar');
      await p.waitForTimeout(600);
      const erroCurta = await p.$eval('#s-erro', (e) => e.style.display !== 'none' ? e.textContent : '').catch(() => '');
      conferir('senha curta demais é recusada', /6 caracteres/.test(erroCurta), JSON.stringify(erroCurta));

      await p.fill('#s-nova', 'senhaescolhida123');
      await p.click('#s-salvar');
      await p.waitForTimeout(900);
      const confirmou = await p.textContent('#janela');
      conferir('senha escolhida é aceita e mostrada de volta',
        /Senha trocada/.test(confirmou) && /senhaescolhida123/.test(confirmou));
      await p.click('#tapa', { position: { x: 5, y: 5 } });
      await p.waitForTimeout(300);
    }

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

    // --- item sem saldo e sem previsão continua visível, marcado ---
    // Procuro o card pelo nome, sem depender da busca: o que importa é que o
    // item zerado ESTEJA na tela, não como se chega até ele.
    const zerado = await c.evaluate(() => {
      const card = [...document.querySelectorAll('.card')]
        .find((el) => (el.querySelector('.nome') || {}).textContent === 'ZERADO SPINNER 55');
      if (!card) return null;
      return {
        selo: (card.querySelector('.selo.sem') || {}).textContent || '',
        temCampoQtd: !!card.querySelector('input[data-qtd]'),
        temAviso: !!card.querySelector('.aviso-sem-estoque'),
        esmaecido: card.classList.contains('sem-estoque'),
      };
    });
    conferir('item sem estoque APARECE no catálogo da Samsonite', !!zerado,
      zerado === null ? 'nao achei o card' : '');
    if (zerado) {
      conferir('e sai marcado como SEM ESTOQUE', zerado.selo.trim() === 'SEM ESTOQUE', JSON.stringify(zerado.selo));
      conferir('sem campo de quantidade (nao da para pedir)', !zerado.temCampoQtd);
      conferir('com o aviso "Sem estoque no momento"', zerado.temAviso);
      conferir('e com a foto esmaecida', zerado.esmaecido);
      await foto(c, '15-sem-estoque');
    }

    // --- "só com saldo" precisa esconder a COR sem saldo, não só o card ---
    // O erro que isto guarda: o filtro olhava se ALGUMA cor da linha tinha
    // saldo e deixava o card passar inteiro, abrindo na primeira cor — que
    // muitas vezes está zerada. Dava filtro ligado com "SEM ESTOQUE" na tela.
    await c.fill(BAHIA, '0');
    await c.waitForTimeout(600);
    await c.click('#chip-disponivel');
    await c.waitForTimeout(900);

    const comFiltro = await c.evaluate(() => {
      const cards = [...document.querySelectorAll('.card')];
      return {
        zeradoNaTela: cards.some((el) => (el.querySelector('.nome') || {}).textContent === 'ZERADO SPINNER 55'),
        selosSemEstoque: document.querySelectorAll('.card .selo.sem').length,
        avisosSemEstoque: document.querySelectorAll('.card .aviso-sem-estoque').length,
        coresDaBahia: (() => {
          const card = cards.find((el) => /BAHIA LITE/.test((el.querySelector('.nome') || {}).textContent || ''));
          return card ? card.querySelectorAll('.cores .cor').length : -1;
        })(),
      };
    });
    conferir('com "só com saldo" o item zerado some da grade', !comFiltro.zeradoNaTela);
    conferir('nenhum card fica marcado SEM ESTOQUE com o filtro ligado',
      comFiltro.selosSemEstoque === 0 && comFiltro.avisosSemEstoque === 0,
      `${comFiltro.selosSemEstoque} selos, ${comFiltro.avisosSemEstoque} avisos`);
    conferir('a cor sem saldo sai do seletor de cores (BAHIA: 3 → 2)',
      comFiltro.coresDaBahia === 2, 'achei ' + comFiltro.coresDaBahia);

    const tituloJanela = await (async () => {
      await c.click('.card .ver-cores');
      await c.waitForTimeout(700);
      const t = await c.textContent('#janela .sub');
      await c.keyboard.press('Escape');
      await c.waitForTimeout(400);
      return t || '';
    })();
    conferir('a janela de cores respeita o filtro', /2 cores/.test(tituloJanela), JSON.stringify(tituloJanela.trim()));
    await foto(c, '16-so-com-saldo');

    await c.click('#chip-disponivel');
    await c.waitForTimeout(900);
    const semFiltro = await c.$$eval('.card .selo.sem', (e) => e.length);
    conferir('desligando o filtro, o item sem estoque volta', semFiltro > 0);

    // --- separar a linha Logitech da Maxprint, marcando um, o outro ou os dois ---
    // A base da Maxprint carrega a Logitech junto. O filtro é de múltipla
    // escolha: marcar os dois tem que dar o mesmo resultado de não marcar nada.
    await c.click('.abas-marca button[data-marca="maxprint"]');
    await c.waitForTimeout(1400);

    const chips = await c.$$eval('#f-fabricante .chip-fab', (e) => e.map((x) => x.textContent.trim()));
    conferir('a Maxprint mostra o filtro de fabricante com os dois nomes',
      chips.length === 2 && chips.some((t) => /^Maxprint/.test(t)) && chips.some((t) => /^Logitech/.test(t)),
      JSON.stringify(chips));

    const nomesNaGrade = () => c.$$eval('.card .nome', (e) => e.map((x) => x.textContent.trim()));
    const todosOsNomes = await nomesNaGrade();

    await c.click('#f-fabricante .chip-fab[data-fab="Logitech"]');
    await c.waitForTimeout(800);
    const soLogitech = await nomesNaGrade();
    conferir('marcando Logitech, a grade fica só com a Logitech',
      soLogitech.length > 0 && soLogitech.every((n) => /LOGITECH/i.test(n)),
      JSON.stringify(soLogitech));

    const menuComLogitech = await c.$$eval('#menu a', (e) => e.map((x) => x.textContent.trim()));
    conferir('e o menu esconde as categorias que ficaram vazias',
      !menuComLogitech.some((t) => /Periféricos|Áudio/.test(t)), JSON.stringify(menuComLogitech));

    await c.click('#f-fabricante .chip-fab[data-fab="Maxprint"]');
    await c.waitForTimeout(800);
    const osDois = await nomesNaGrade();
    conferir('marcando os dois, volta o catálogo inteiro',
      osDois.length === todosOsNomes.length, `${osDois.length} de ${todosOsNomes.length}`);
    conferir('e os chips voltam a ficar apagados',
      (await c.$$eval('#f-fabricante .chip-fab.ativo', (e) => e.length)) === 0);
    await foto(c, '17-filtro-fabricante');

    await c.click('.abas-marca button[data-marca="samsonite"]');
    await c.waitForTimeout(1400);

    // --- busca por código, nome e cor, dentro do catálogo de cada marca ---
    // O que isto guarda: procurar o código de UMA cor mostrava o card inteiro
    // aberto na primeira cor da linha, e quem procurou achava que tinha achado
    // outro item. E procurar com uma categoria aberta no menu não achava nada
    // que estivesse fora dela, sem explicar por quê.
    const buscar = async (texto) => {
      await c.fill('#busca', texto);
      await c.waitForTimeout(700);
      return c.evaluate(() => ({
        cards: [...document.querySelectorAll('.card .nome')].map((e) => e.textContent.trim()),
        cores: [...document.querySelectorAll('.card')].map((el) => el.querySelectorAll('.cores .cor').length),
        titulo: (document.getElementById('titulo') || {}).textContent,
      }));
    };

    const porCor = await buscar('146203D1102');
    conferir('procurar o código de uma cor traz só aquela cor',
      porCor.cards.length === 1 && porCor.cores[0] <= 1,
      `${porCor.cards.length} cards, ${porCor.cores[0]} cores`);
    conferir('e o título diz que é uma busca', /Busca:/.test(porCor.titulo || ''), JSON.stringify(porCor.titulo));

    const porNome = await buscar('bahia');
    conferir('procurar pelo nome da linha traz o card com as cores',
      porNome.cards.length === 1 && porNome.cores[0] === 3,
      `${porNome.cards.length} cards, ${porNome.cores[0]} cores`);

    const porCorNome = await buscar('navy');
    conferir('procurar pelo nome da cor acha o item',
      porCorNome.cards.length === 1, `${porCorNome.cards.length} cards`);

    // Ordem invertida de propósito: "exp aspen" tem que dar o mesmo que
    // "aspen exp". E a BAHIA, que também é EXP, fica de fora porque não é
    // Aspen — as duas palavras valem juntas, não uma ou outra.
    const duasPalavras = await buscar('exp aspen');
    conferir('duas palavras filtram juntas, em qualquer ordem',
      duasPalavras.cards.length === 2 && duasPalavras.cards.every((n) => /ASPEN/.test(n)),
      JSON.stringify(duasPalavras.cards));

    // com uma categoria aberta, a busca tem que sair dela
    await c.fill('#busca', '');
    await c.waitForTimeout(500);
    await c.evaluate(() => {
      const a = [...document.querySelectorAll('#menu a')].find((x) => /Xtrem/.test(x.textContent));
      if (a) a.click();
    });
    await c.waitForTimeout(700);
    const foraDaCategoria = await buscar('aspen');
    conferir('com categoria aberta, a busca procura no catálogo inteiro',
      foraDaCategoria.cards.length >= 2, `${foraDaCategoria.cards.length} cards`);
    await foto(c, '18-busca');

    await c.fill('#busca', '');
    await c.waitForTimeout(600);
    await c.evaluate(() => {
      const a = [...document.querySelectorAll('#menu a')].find((x) => /Todos os produtos/.test(x.textContent));
      if (a) a.click();
    });
    await c.waitForTimeout(700);

    // --- anexar foto: opção só para a equipe, não para o cliente ---
    const botaoFotoCliente = await c.$$eval('.subir-foto', (e) => e.length);
    conferir('cliente não vê a opção de anexar foto', botaoFotoCliente === 0);

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
