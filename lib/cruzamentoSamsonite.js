'use strict';

/**
 * Casa a base Samsonite (lib/importSamsonite.js) com as fotos por cor tiradas
 * dos catálogos em PDF (lib/importCatalogoSamsonite.js).
 *
 * As duas fontes falam de coisas diferentes e não têm uma chave em comum:
 *
 *   base .......  vem do HTML da própria Samsonite. Cor em nome em inglês
 *                 ("CHARCOAL BLACK", "SPACE BLUE", "GREY MELANGE"). Código é
 *                 o SKU completo, com o dígito de embalagem grudado no fim
 *                 ("15507210411U", "146203D1101U").
 *
 *   catálogo ...  vem dos PDFs. Tem DOIS formatos de página, cada um com sua
 *                 própria chave de casamento:
 *
 *     - "grade" (catálogo BTS, linha Xtrem): cada item já traz o código de
 *       barras impresso na página, sem o dígito de embalagem. Ali o casamento
 *       é exato: basta comparar dígito a dígito.
 *
 *     - "ficha" (catálogo Samsonite/American Tourister): não tem código
 *       nenhum impresso, só o nome comercial (materialGroup + materialDescription)
 *       e as amostras de cor lidas do próprio desenho da página, em hexadecimal.
 *       Ali não existe casamento exato: é preciso aproximar texto com texto e
 *       cor com cor.
 *
 * Por isso o módulo trabalha em duas etapas independentes, cada uma com sua
 * confiança própria, e devolve os itens sem foto junto com o motivo — para o
 * admin conseguir completar a mão pela aba Produtos e fotos, do jeito que já
 * funciona para a Maxprint.
 */

/* ------------------------------------------------------------------ *
 * Texto
 * ------------------------------------------------------------------ */

function normalizarTexto(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/["“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * O SKU "de verdade", sem o indicador de unidade/embalagem.
 *
 * O arquivo da Samsonite grava cada linha como "<sku>  <U>" (dois espaços e
 * uma letra solta). O SKU em si pode ter letra NO MEIO ("146203D1101"), então
 * não dá para simplesmente pegar os dígitos do começo — cortaria no primeiro
 * "D". A referência confiável é o espaço que separa as duas partes, por isso
 * esta função trabalha sobre o texto ORIGINAL (antes de normalizarCodigo
 * juntar tudo) e usa só o primeiro pedaço.
 *
 * O código impresso no catálogo em PDF já vem só com o SKU, sem esse sufixo,
 * então o mesmo texto serve para comparar os dois lados.
 */
function skuSemSufixo(codigoOriginal) {
  const primeiro = String(codigoOriginal || '').trim().split(/\s+/)[0] || '';
  return primeiro.toUpperCase();
}

/** Interseção de palavras entre dois textos já normalizados, 0 a 1. */
function sobreposicaoDePalavras(a, b) {
  const pa = new Set(a.split(' ').filter((w) => w.length > 1));
  const pb = new Set(b.split(' ').filter((w) => w.length > 1));
  if (!pa.size || !pb.size) return 0;
  let comuns = 0;
  for (const w of pa) if (pb.has(w)) comuns++;
  return comuns / Math.max(pa.size, pb.size);
}

/**
 * O quanto `desc` (a descrição do catálogo) "contém" `alvo` (o tipo de peça
 * da base). Cobre os dois formatos que a Samsonite usa na mesma coluna:
 *   "BAILHANDLE 15.6" CHARCOAL BLACK"  (tipo + cor grudados)
 *   "LPT BACKPACK 15.6""               (só o tipo)
 */
function pontuarTipo(tipoBase, materialDescription) {
  const a = normalizarTexto(tipoBase);
  const b = normalizarTexto(materialDescription);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.startsWith(a) || a.startsWith(b)) return 0.9;
  return sobreposicaoDePalavras(a, b) * 0.8;
}

/* ------------------------------------------------------------------ *
 * Cor: nome em inglês -> RGB aproximado
 * ------------------------------------------------------------------ */

// Cobre o vocabulário visto nas 715 linhas não-Xtrem da base real.
//
// Dividido em dois grupos, e isso importa: quando um nome de cor junta uma
// palavra "de tom genérico" (BLACK, BLUE, RED...) com uma palavra "de tom
// com nome próprio" (NAVY, WINE, CHARCOAL, TEAL...), como em "NAVY BLUE" ou
// "WINE RED", quem carrega o significado é o nome próprio — o genérico ali
// é só reforço redundante ("blue" depois de "navy" só confirma a família,
// não é uma segunda cor). Achatar os dois numa média (como a primeira
// versão fazia) produzia um tom mais claro e saturado que nenhum dos dois
// originais — foi assim que uma mala clara e fotografada como preta acabou
// mais perto do dicionário genérico BLACK do que do "NAVY BLUE" borrado.
// Só quando NENHUM nome próprio aparece é que caio para os genéricos, e aí
// sim posso combinar mais de um ("BLACK/BLUE" bicolor).
const CORES_ESPECIFICAS = {
  SILVER: [180, 182, 185], CHARCOAL: [60, 62, 66], NAVY: [25, 38, 68],
  'SPACE BLUE': [35, 55, 95], TEAL: [20, 110, 110], TURQUOISE: [40, 170, 165], DENIM: [60, 95, 140],
  OLIVE: [80, 90, 50], MINT: [140, 210, 175], KHAKI: [150, 140, 95],
  WINE: [95, 25, 35], BURGUNDY: [95, 25, 40], CORAL: [230, 110, 95], GOLD: [180, 150, 70],
  FUCHSIA: [190, 30, 130], LILAC: [180, 155, 200],
  CAMEL: [170, 130, 85], BEIGE: [205, 190, 165], SAND: [200, 180, 145],
  IVORY: [230, 225, 205], CREAM: [235, 225, 200], INK: [30, 35, 55],
  BEAR: [150, 110, 70], CAT: [140, 210, 175], TIGER: [225, 150, 60],
};

const CORES_GENERICAS = {
  BLACK: [20, 20, 22], WHITE: [245, 245, 245], GREY: [130, 130, 132], GRAY: [130, 130, 132],
  BLUE: [40, 90, 170], GREEN: [45, 120, 70], RED: [190, 30, 40],
  ORANGE: [230, 120, 30], YELLOW: [225, 195, 40],
  PINK: [225, 150, 175], PURPLE: [95, 55, 120],
  BROWN: [90, 60, 40], MULTI: [140, 140, 140],
};

// Modificadores: deslocam luminância (positivo clareia, negativo escureia) e
// no caso de "melange"/"matte" só reduzem um pouco a saturação, na prática
// puxando a cor um pouco em direção ao cinza.
const MODIFICADORES = {
  DEEP: -30, DARK: -30, LIGHT: 35, SOFT: 20, DUSTY: -10, PASTEL: 25,
  MIDNIGHT: -35, MATTE: -8, MELANGE: -8, BRIGHT: 15,
};

function ajustarLuminancia([r, g, b], delta) {
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + delta)));
  return [f(r), f(g), f(b)];
}

function mediaDeCores(lista) {
  return lista
    .reduce((acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]], [0, 0, 0])
    .map((v) => v / lista.length);
}

/**
 * Procura palavras de `palavras` num dicionário de cores, testando pares
 * consecutivos primeiro (cor composta, ex. "SPACE BLUE" vale mais que
 * "SPACE" e "BLUE" soltos) e depois palavras isoladas. Devolve as cores
 * encontradas e a lista de palavras com as já usadas apagadas, para o
 * dicionário seguinte não tentar casar de novo em cima delas.
 */
function buscarCores(palavras, dicionario) {
  const restantes = palavras.slice();
  const encontradas = [];

  for (let i = 0; i < restantes.length - 1; i++) {
    if (!restantes[i] || !restantes[i + 1]) continue;
    const par = `${restantes[i]} ${restantes[i + 1]}`;
    if (dicionario[par]) { encontradas.push(dicionario[par]); restantes[i] = ''; restantes[i + 1] = ''; }
  }
  for (let i = 0; i < restantes.length; i++) {
    const p = restantes[i];
    if (!p) continue;
    if (dicionario[p]) { encontradas.push(dicionario[p]); restantes[i] = ''; }
  }

  return { encontradas, restantes };
}

/**
 * Aproxima o RGB de um nome de cor em inglês, possivelmente composto
 * ("GREY MELANGE", "BLACK/BLUE", "NAVY BLUE"). Retorna null quando nenhuma
 * palavra reconhecida aparece — melhor não casar do que casar errado.
 */
function corDoNome(nomeCor) {
  const todas = normalizarTexto(nomeCor).split(/[\s/]+/).filter(Boolean);
  if (!todas.length) return null;

  let deltaTotal = 0;
  const palavras = todas.filter((p) => {
    if (MODIFICADORES[p] !== undefined) { deltaTotal += MODIFICADORES[p]; return false; }
    return true;
  });

  // Nome próprio primeiro (NAVY, WINE, CHARCOAL...) — se aparecer, ele é
  // quem define a cor, mesmo que um tom genérico apareça do lado.
  const especificas = buscarCores(palavras, CORES_ESPECIFICAS);
  if (especificas.encontradas.length) {
    return ajustarLuminancia(mediaDeCores(especificas.encontradas), deltaTotal);
  }

  // Sem nome próprio: cai para os tons genéricos, combinando mais de um se
  // for o caso (ex. bicolor "BLACK/BLUE").
  const genericas = buscarCores(palavras, CORES_GENERICAS);
  if (!genericas.encontradas.length) return null;
  return ajustarLuminancia(mediaDeCores(genericas.encontradas), deltaTotal);
}

/* ------------------------------------------------------------------ *
 * Distância de cor em Lab (perceptual), mesma ideia usada no recorte das
 * fotos — preto, cinza e azul-marinho se confundem demais em RGB puro.
 * ------------------------------------------------------------------ */

function rgbParaLab(r, g, b) {
  const conv = (c) => {
    c /= 255;
    return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
  };
  const rl = conv(r), gl = conv(g), bl = conv(b);
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  const y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722) / 1.0;
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function hexParaRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function distanciaCor(rgbA, rgbB) {
  if (!rgbA || !rgbB) return Infinity;
  const [l1, a1, b1] = rgbParaLab(...rgbA);
  const [l2, a2, b2] = rgbParaLab(...rgbB);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/**
 * Casamento um-para-um entre N cores da base e M cores do catálogo, por menor
 * distância total. Os conjuntos são pequenos (a Samsonite raramente passa de
 * 5 ou 6 cores por produto), então força bruta nas permutações do lado menor
 * é rápido e exato — o mesmo caminho que o extrator de fotos já usa.
 */
// Acima disso, em distância Lab, duas cores já não têm por que ser a mesma —
// é o piso que evita forçar a única foto disponível numa cor errada só
// porque "é a menos distante das ruins" (ver comentário em casarPorFicha).
const DISTANCIA_MAXIMA_COR = 32;

function casarCores(coresBase, coresCatalogo, distanciaMaxima = DISTANCIA_MAXIMA_COR) {
  const resultado = new Array(coresBase.length).fill(-1);
  if (!coresCatalogo.length) return resultado;

  const usados = new Set();
  // Guloso por menor distância global é suficiente aqui: como o valor de
  // cada aresta já é uma distância perceptual bem separada (cores diferentes
  // de verdade ficam longe em Lab), o guloso quase sempre bate com o ótimo,
  // e evita explosão combinatória quando um produto tem muitas cores.
  const pares = [];
  coresBase.forEach((cb, i) => {
    coresCatalogo.forEach((cc, j) => {
      pares.push({ i, j, d: distanciaCor(cb, cc) });
    });
  });
  pares.sort((a, b) => a.d - b.d);

  const baseUsada = new Set();
  for (const par of pares) {
    if (baseUsada.has(par.i) || usados.has(par.j)) continue;
    if (!Number.isFinite(par.d) || par.d > distanciaMaxima) continue;
    resultado[par.i] = par.j;
    baseUsada.add(par.i);
    usados.add(par.j);
  }
  return resultado;
}

/* ------------------------------------------------------------------ *
 * Etapa 1 — Xtrem (formato "grade" do BTS): casamento exato por código.
 * ------------------------------------------------------------------ */

function casarPorCodigo(baseItens, itensGrade, avisos) {
  const porSku = new Map();
  for (const p of baseItens) {
    const s = skuSemSufixo(p.codigoOriginal);
    if (s) porSku.set(s, p);
  }

  let casados = 0;
  for (const item of itensGrade) {
    const s = String(item.codigo || '').trim().toUpperCase();
    const p = s && porSku.get(s);
    if (!p) {
      avisos.push(`Código ${item.codigo || '(vazio)'} do catálogo BTS não achou produto correspondente na base.`);
      continue;
    }
    const foto = item.cores[0] && item.cores[0].arquivoImagem
      ? item.cores[0].arquivoImagem
      : (item.imagens[0] && item.imagens[0].arquivo) || '';
    if (foto) {
      p.imagem = foto;
      p.imagemIlustrativa = false;
      p.fotoOrigem = `catálogo BTS, p.${item.pagina}, por código`;
      casados++;
    }
  }
  return casados;
}

/* ------------------------------------------------------------------ *
 * Etapa 2 — Samsonite / American Tourister (formato "ficha"): casamento
 * por texto (grupo + tipo) e depois por cor.
 * ------------------------------------------------------------------ */

function casarPorFicha(baseItens, itensFicha, avisos) {
  // Só entram nesta etapa os itens que a etapa 1 não resolveu.
  const semFoto = baseItens.filter((p) => !p.imagem);

  const porGrupo = new Map();
  for (const p of semFoto) {
    const chave = normalizarTexto(p.grupo);
    if (!chave) continue;
    if (!porGrupo.has(chave)) porGrupo.set(chave, []);
    porGrupo.get(chave).push(p);
  }

  const fichasPorGrupo = new Map();
  for (const item of itensFicha) {
    const chave = normalizarTexto(item.materialGroup || item.modelo);
    if (!chave) continue;
    if (!fichasPorGrupo.has(chave)) fichasPorGrupo.set(chave, []);
    fichasPorGrupo.get(chave).push(item);
  }

  let itensComFoto = 0;
  let coresComFoto = 0;
  let coresSemPar = 0;

  for (const [chaveGrupo, produtosDoGrupo] of porGrupo) {
    const fichas = fichasPorGrupo.get(chaveGrupo);
    if (!fichas || !fichas.length) {
      avisos.push(`Grupo "${produtosDoGrupo[0].grupo}" (${produtosDoGrupo.length} item(ns)) não apareceu em nenhum dos catálogos em PDF.`);
      continue;
    }

    // Dentro do grupo, cada "tipo de peça" (bailhandle, mochila, pasta...) é
    // uma linha de produto com suas próprias cores. Agrupo a base por tipo e
    // caso cada tipo com a ficha de texto mais parecido.
    const porTipo = new Map();
    for (const p of produtosDoGrupo) {
      const t = p.tipoProduto || '(sem tipo)';
      if (!porTipo.has(t)) porTipo.set(t, []);
      porTipo.get(t).push(p);
    }

    const fichasUsadas = new Set();
    for (const [tipo, produtosDoTipo] of porTipo) {
      let melhor = null;
      let melhorPontos = 0;
      fichas.forEach((f, idx) => {
        if (fichasUsadas.has(idx)) return;
        const pontos = pontuarTipo(tipo, f.materialDescription);
        if (pontos > melhorPontos) { melhorPontos = pontos; melhor = idx; }
      });

      if (melhor === null || melhorPontos < 0.3) {
        avisos.push(`"${produtosDoTipo[0].grupo} — ${tipo}" não achou uma ficha de catálogo parecida o bastante para confiar.`);
        continue;
      }
      fichasUsadas.add(melhor);
      const ficha = fichas[melhor];

      // Cor: aproximo o nome em inglês da base e caso com a cor MEDIDA em
      // cada foto de verdade (`imagens[].corDominante`) — não com a amostra
      // impressa (`cores[].hex`). A amostra é confiável quando o número de
      // fotos bate com o número de cores anunciadas, mas em muita página a
      // Samsonite anuncia 3 cores e mostra 1 foto só (fotografou uma unidade
      // e listou as outras variações por baixo). Nesse caso o extrator do
      // catálogo é obrigado a "casar" essa foto única com alguma amostra, e
      // às vezes acerta a mais parecida em vez da certa — foi assim que uma
      // mala preta (foto real ~#2c2b2b) ficou grudada na amostra "azul-marinho"
      // só porque era a menos distante das três impressas. A cor da própria
      // foto não tem essa ambiguidade: ou ela bate com o nome em inglês da
      // base, ou fica sem par — nunca herda o erro de um casamento alheio.
      const coresBaseRgb = produtosDoTipo.map((p) => corDoNome(p.cor));
      const fotosComCor = (ficha.imagens || []).filter((im) => im.corDominante);
      const coresFotoRgb = fotosComCor.map((im) => hexParaRgb(im.corDominante));
      const pares = casarCores(coresBaseRgb, coresFotoRgb);

      produtosDoTipo.forEach((p, i) => {
        const j = pares[i];
        if (j < 0 || !fotosComCor[j]) {
          coresSemPar++;
          return;
        }
        p.imagem = fotosComCor[j].arquivo;
        p.imagemIlustrativa = false;
        p.fotoOrigem = `catálogo ${ficha.materialGroup}, p.${ficha.pagina}, por texto + cor da foto`;
        coresComFoto++;
      });
      itensComFoto++;
    }
  }

  if (coresSemPar) {
    avisos.push(`${coresSemPar} cor(es) casaram o tipo de produto mas não tinham foto correspondente na ficha do catálogo.`);
  }

  return { itensComFoto, coresComFoto };
}

/* ------------------------------------------------------------------ *
 * Entrada pública
 * ------------------------------------------------------------------ */

/**
 * @param {object[]} baseItens    saída de importarSamsonite().produtos — é
 *   MUTADA in-place (recebe `imagem`, `imagemIlustrativa`, `fotoOrigem`),
 *   porque é exatamente isso que o chamador vai gravar no banco.
 * @param {object[]} catalogos    um array de resultados de
 *   importarCatalogoSamsonite() — normalmente dois: o catálogo Samsonite/AT
 *   (formato ficha) e o BTS (formato grade, linha Xtrem). A ordem não importa.
 */
function cruzarComFotos(baseItens, catalogos) {
  const avisos = [];
  const todosItens = catalogos.flatMap((c) => c.itens || []);
  // "Grade" (formato BTS): tem código de barras impresso e não tem tabela de
  // preço — é a marca registradora desse formato (ver importCatalogoSamsonite.js).
  const grade = todosItens.filter((i) => i.codigo && i.wholesale === null);
  const ficha = todosItens.filter((i) => !(i.codigo && i.wholesale === null));

  const casadosPorCodigo = casarPorCodigo(baseItens, grade, avisos);
  const { itensComFoto, coresComFoto } = casarPorFicha(baseItens, ficha, avisos);

  const totalComFoto = baseItens.filter((p) => p.imagem).length;

  return {
    relatorio: {
      totalBase: baseItens.length,
      totalComFoto,
      totalSemFoto: baseItens.length - totalComFoto,
      casadosPorCodigo,
      itensDeTextoCasados: itensComFoto,
      coresCasadasPorTexto: coresComFoto,
    },
    avisos,
  };
}

module.exports = {
  cruzarComFotos,
  // exportado para o script de teste e para eventual conferência manual
  normalizarTexto,
  skuSemSufixo,
  corDoNome,
  distanciaCor,
  hexParaRgb,
};
