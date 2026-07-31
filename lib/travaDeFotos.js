'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Quem fica com a foto quando mais de um código aponta para a mesma imagem.
 *
 * POR QUE ISSO EXISTE
 * A regra antiga era dura: dividiu foto, ninguém fica com ela. Ela nasceu do
 * desastre do recorte de PDF, em que UM recorte de seção inteira virou a foto
 * de 77 produtos ao mesmo tempo. Contra isso ela está certa.
 *
 * Só que no site da fábrica aparece outro caso, medido em 30/07/2026: a busca
 * na Maxprint achou 65 fotos e jogou TODAS fora, porque eram 42 pares de
 * códigos irmãos — etiquetas do mesmo modelo que mudam só o formato ou a
 * quantidade por embalagem (493400/493416, 494355/494393...). A foto é
 * legitimamente a mesma para os dois, e a regra dura deixava 84 itens sem foto
 * à toa.
 *
 * A REGRA DE HOJE
 *   1 código  -> foto dele, sem ressalva;
 *   2 códigos -> os dois ficam, marcados como "foto ilustrativa da linha" — o
 *                aviso que o catálogo já sabe mostrar. É honesto: a foto é da
 *                linha, não daquele formato exato;
 *   3 ou mais -> ninguém fica. Imagem que serve a três códigos é imagem de
 *                seção, banner ou embalagem genérica.
 *
 * O corte em dois não é gosto: é onde "irmão" vira "genérico". Foto errada
 * continua sendo pior que foto faltando.
 */

const MAXIMO_IRMAOS = 2;

function criarTravaDeFotos({ pastaImagens, aviso = () => {}, maximoIrmaos = MAXIMO_IRMAOS } = {}) {
  // digital do conteúdo -> { arquivo, codigos: [], descartado }
  const porConteudo = new Map();

  return {
    /**
     * Oferece uma foto já convertida. Grava o arquivo quando for o caso e
     * devolve o que o chamador precisa aplicar no banco.
     *
     * @returns {object[]} ações: { tipo: 'gravar'|'apagar', codigo, arquivo, ilustrativa }
     */
    oferecer({ codigo, arquivo, buffer }) {
      const digital = crypto.createHash('sha1').update(buffer).digest('hex');
      const grupo = porConteudo.get(digital);

      /* ---- primeira vez que esta imagem aparece ---- */
      if (!grupo) {
        fs.writeFileSync(path.join(pastaImagens, arquivo), buffer);
        porConteudo.set(digital, { arquivo, codigos: [codigo], descartado: false });
        return [{ tipo: 'gravar', codigo, arquivo, ilustrativa: false }];
      }

      /* ---- a imagem já morreu numa rodada anterior ---- */
      if (grupo.descartado) {
        grupo.codigos.push(codigo);
        return [];
      }

      /* ---- ainda cabe irmão: os dois passam a ser ilustrativos ---- */
      if (grupo.codigos.length < maximoIrmaos) {
        const anteriores = [...grupo.codigos];
        grupo.codigos.push(codigo);
        aviso(`${codigo} usa a mesma foto de ${anteriores.join(', ')} — os dois ficam, marcados como foto da linha.`);
        // O primeiro já entrou sem ressalva; ele é regravado agora com a marca.
        return [
          ...anteriores.map((c) => ({ tipo: 'gravar', codigo: c, arquivo: grupo.arquivo, ilustrativa: true })),
          { tipo: 'gravar', codigo, arquivo: grupo.arquivo, ilustrativa: true },
        ];
      }

      /* ---- passou do limite: é imagem genérica, ninguém fica ---- */
      grupo.descartado = true;
      const caem = [...grupo.codigos, codigo];
      grupo.codigos.push(codigo);
      aviso(`A mesma foto serve a ${caem.length} códigos (${caem.slice(0, 5).join(', ')}) — imagem genérica, ninguém fica com ela.`);
      try { fs.unlinkSync(path.join(pastaImagens, grupo.arquivo)); } catch (_) {}
      return caem.map((c) => ({ tipo: 'apagar', codigo: c }));
    },

    /** Números para o relatório. */
    contas() {
      let sozinhas = 0, irmas = 0, descartadas = 0;
      for (const g of porConteudo.values()) {
        if (g.descartado) descartadas += g.codigos.length;
        else if (g.codigos.length > 1) irmas += g.codigos.length;
        else sozinhas++;
      }
      return { fotosProprias: sozinhas, fotosDeLinha: irmas, fotosGenericasDescartadas: descartadas };
    },
  };
}

/**
 * Aplica no banco (via callbacks do buscador) o que a trava decidiu.
 *
 * Fica aqui, e não em cada buscador, porque os três buscadores precisam
 * exatamente do mesmo cuidado: regravar o primeiro irmão com a marca de foto
 * de linha, e desfazer no banco o que já tinha sido gravado quando a imagem se
 * revela genérica.
 */
async function aplicarAcao(acao, { resultados, origemDe, aoBaixar, aoDescartar, aviso = () => {} }) {
  const posicao = resultados.findIndex((r) => r.codigo === acao.codigo);

  if (acao.tipo === 'gravar') {
    const achado = {
      codigo: acao.codigo,
      arquivo: acao.arquivo,
      ilustrativa: !!acao.ilustrativa,
      origem: (origemDe && origemDe.get(acao.codigo)) || '',
    };
    if (posicao >= 0) resultados[posicao] = achado;
    else resultados.push(achado);
    if (aoBaixar) {
      try { await aoBaixar(achado); }
      catch (e) { aviso(`Falhou ao gravar a foto de ${acao.codigo}: ${e.message}`); }
    }
    return;
  }

  if (posicao >= 0) resultados.splice(posicao, 1);
  if (aoDescartar) {
    try { await aoDescartar(acao.codigo); }
    catch (e) { aviso(`Não consegui desfazer a foto de ${acao.codigo}: ${e.message}`); }
  }
}

module.exports = { criarTravaDeFotos, aplicarAcao, MAXIMO_IRMAOS };
