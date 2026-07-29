'use strict';

/**
 * Banco de mentira, em memória, para conseguir rodar o sistema inteiro sem
 * MongoDB instalado.
 *
 * Serve para UM propósito só: testar as telas de verdade num navegador antes
 * de publicar. Não é usado em produção, não é importado pelo server.js e não
 * tem nenhuma pretensão de ser um Mongo completo — implementa exatamente os
 * métodos que este sistema usa, e nada mais.
 *
 * Uso: `require('./scripts/mongo_falso').instalar()` ANTES de carregar o
 * server.js. Depois disso todo Model do mongoose responde da memória.
 */

const mongoose = require('mongoose');

/* ---------------------------- consultas ---------------------------- */

function pegar(doc, caminho) {
  return String(caminho).split('.').reduce((o, k) => (o == null ? o : o[k]), doc);
}

/** Um subconjunto de operadores do Mongo: o que este sistema realmente usa. */
function casaCondicao(valor, cond) {
  if (cond instanceof RegExp) return cond.test(String(valor ?? ''));

  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    const chaves = Object.keys(cond);
    if (chaves.some((k) => k.startsWith('$'))) {
      return chaves.every((op) => {
        const alvo = cond[op];
        switch (op) {
          case '$eq': return valor === alvo;
          case '$ne': return valor !== alvo;
          case '$gt': return Number(valor) > Number(alvo);
          case '$gte': return Number(valor) >= Number(alvo);
          case '$lt': return Number(valor) < Number(alvo);
          case '$lte': return Number(valor) <= Number(alvo);
          case '$in': return (alvo || []).some((x) => String(x) === String(valor));
          case '$nin': return !(alvo || []).some((x) => String(x) === String(valor));
          case '$exists': return (valor !== undefined) === !!alvo;
          case '$regex': return new RegExp(alvo, cond.$options || '').test(String(valor ?? ''));
          case '$options': return true; // tratado junto com $regex
          default: throw new Error(`mongo_falso: operador ${op} não implementado`);
        }
      });
    }
  }
  return String(valor) === String(cond);
}

function casa(doc, filtro) {
  if (!filtro || !Object.keys(filtro).length) return true;
  return Object.entries(filtro).every(([campo, cond]) => {
    if (campo === '$or') return (cond || []).some((f) => casa(doc, f));
    if (campo === '$and') return (cond || []).every((f) => casa(doc, f));
    return casaCondicao(pegar(doc, campo), cond);
  });
}

function ordenar(lista, sort) {
  if (!sort) return lista;
  const campos = Object.entries(sort);
  return [...lista].sort((a, b) => {
    for (const [campo, dir] of campos) {
      const va = pegar(a, campo), vb = pegar(b, campo);
      if (va === vb) continue;
      const menor = (va === undefined || va === null) ? true
        : (vb === undefined || vb === null) ? false
        : (typeof va === 'number' && typeof vb === 'number') ? va < vb
        : String(va) < String(vb);
      return (menor ? -1 : 1) * (dir < 0 ? -1 : 1);
    }
    return 0;
  });
}

/** Aplica `$set` e campos soltos, como o Mongo faz num update. */
function aplicar(doc, update) {
  const u = update || {};
  const set = u.$set || {};
  for (const [k, v] of Object.entries(set)) doc[k] = v;
  for (const [k, v] of Object.entries(u)) {
    if (k.startsWith('$')) continue;
    doc[k] = v;
  }
  return doc;
}

/* ---------------------- coleção e "query builder" ------------------- */

let sequencia = 1;
const colecoes = new Map();

function colecao(nome) {
  if (!colecoes.has(nome)) colecoes.set(nome, []);
  return colecoes.get(nome);
}

/**
 * O mongoose devolve um objeto encadeável (.select().sort().limit().lean())
 * que só executa quando alguém dá await. Reproduzo isso com um thenable.
 */
function consulta(executar) {
  const estado = { sort: null, limite: 0, pular: 0 };
  const q = {
    select() { return q; },      // projeção não muda nada num teste de tela
    lean() { return q; },
    populate() { return q; },
    sort(s) { estado.sort = s; return q; },
    limit(n) { estado.limite = n; return q; },
    skip(n) { estado.pular = n; return q; },
    then(resolver, rejeitar) {
      return Promise.resolve()
        .then(() => executar(estado))
        .then(resolver, rejeitar);
    },
    catch(f) { return q.then(undefined, f); },
  };
  return q;
}

/* -------------------------- documento vivo -------------------------- */

function comMetodos(doc, nome) {
  if (!doc || doc.__comMetodos) return doc;
  Object.defineProperties(doc, {
    __comMetodos: { value: true, enumerable: false },
    save: {
      enumerable: false,
      value: async function salvar() {
        const lista = colecao(nome);
        const i = lista.findIndex((d) => String(d._id) === String(doc._id));
        if (i >= 0) lista[i] = doc; else lista.push(doc);
        return doc;
      },
    },
    toObject: { enumerable: false, value: () => ({ ...doc }) },
    toJSON: { enumerable: false, value: () => ({ ...doc }) },
  });
  return doc;
}

/* --------------------------- instalação ----------------------------- */

function instalar() {
  mongoose.connect = async () => mongoose;
  mongoose.disconnect = async () => mongoose;

  // Atenção: NÃO mexo em `readyState` aqui. Se ele já disser "conectado" na
  // hora de compilar o model, o mongoose tenta amarrar a coleção numa
  // conexão que não existe e quebra na hora. Quem quiser fingir conexão
  // pronta chama fingirConectado() DEPOIS de os models terem sido criados.

  const modelOriginal = mongoose.model.bind(mongoose);

  mongoose.model = function model(nome, schema) {
    if (!schema) return modelOriginal(nome);
    const M = modelOriginal(nome, schema);

    // Aplica os defaults do schema, para os documentos nascerem com os
    // mesmos campos que teriam num banco de verdade.
    const comDefaults = (dados) => {
      const doc = { ...dados };
      schema.eachPath((caminho, tipo) => {
        if (doc[caminho] !== undefined || caminho === '__v') return;
        const d = tipo.options && tipo.options.default;
        if (d === undefined) return;
        doc[caminho] = typeof d === 'function' ? d() : (Array.isArray(d) ? [...d] : d);
      });
      if (!doc._id) doc._id = `id${sequencia++}`;
      // `timestamps: true` é do mongoose, não do schema — sem reproduzir isso
      // aqui, toda tela que mostra data exibiria "Invalid Date" no teste e eu
      // ficaria caçando um defeito que só existe no banco de mentira.
      if (schema.options && schema.options.timestamps) {
        const agora = new Date();
        if (!doc.createdAt) doc.createdAt = agora;
        if (!doc.updatedAt) doc.updatedAt = agora;
      }
      return doc;
    };

    M.find = (filtro = {}) => consulta((e) => {
      let r = colecao(nome).filter((d) => casa(d, filtro));
      r = ordenar(r, e.sort);
      if (e.pular) r = r.slice(e.pular);
      if (e.limite) r = r.slice(0, e.limite);
      return r.map((d) => ({ ...d }));
    });

    M.findOne = (filtro = {}) => consulta((e) => {
      const r = ordenar(colecao(nome).filter((d) => casa(d, filtro)), e.sort)[0];
      return r ? comMetodos(r, nome) : null;
    });

    M.findById = (id) => consulta(() => {
      const r = colecao(nome).find((d) => String(d._id) === String(id));
      return r ? comMetodos(r, nome) : null;
    });

    M.countDocuments = async (filtro = {}) => colecao(nome).filter((d) => casa(d, filtro)).length;

    /**
     * Roda os `pre('validate')` do schema de verdade.
     *
     * Não é firula: a numeração do pedido (1001, 1002...) mora num hook
     * desses. Sem executá-lo, todo pedido criado no teste nasceria sem
     * número, e eu ficaria investigando um "defeito" que só existe porque o
     * banco de mentira não fez o que o mongoose faria.
     */
    const rodarPreValidate = (doc) => new Promise((resolve, reject) => {
      const hooks = schema.s && schema.s.hooks;
      if (!hooks || typeof hooks.execPre !== 'function') return resolve();
      // O hook usa `this` e `this.constructor.findOne(...)`.
      const contexto = Object.assign(Object.create({ constructor: M }), doc);
      hooks.execPre('validate', contexto, [], (erro) => {
        if (erro) return reject(erro);
        for (const [k, v] of Object.entries(contexto)) doc[k] = v;
        resolve();
      });
    });

    M.create = async (dados) => {
      const lista = Array.isArray(dados) ? dados : [dados];
      const criados = [];
      for (const d of lista) {
        const doc = comMetodos(comDefaults(d), nome);
        await rodarPreValidate(doc);
        colecao(nome).push(doc);
        criados.push(doc);
      }
      return Array.isArray(dados) ? criados : criados[0];
    };

    M.findOneAndUpdate = (filtro, update, opcoes = {}) => consulta(() => {
      const lista = colecao(nome);
      let doc = lista.find((d) => casa(d, filtro));
      if (!doc && opcoes.upsert) {
        doc = comMetodos(comDefaults({ ...filtro }), nome);
        lista.push(doc);
      }
      if (!doc) return null;
      aplicar(doc, update);
      return comMetodos(doc, nome);
    });

    M.findByIdAndUpdate = (id, update, opcoes = {}) =>
      M.findOneAndUpdate({ _id: id }, update, opcoes);

    M.updateOne = async (filtro, update) => {
      const doc = colecao(nome).find((d) => casa(d, filtro));
      if (doc) aplicar(doc, update);
      return { modifiedCount: doc ? 1 : 0 };
    };

    M.updateMany = async (filtro, update) => {
      const alvos = colecao(nome).filter((d) => casa(d, filtro));
      alvos.forEach((d) => aplicar(d, update));
      return { modifiedCount: alvos.length };
    };

    M.deleteOne = async (filtro = {}) => {
      const lista = colecao(nome);
      const i = lista.findIndex((d) => casa(d, filtro));
      if (i < 0) return { deletedCount: 0 };
      lista.splice(i, 1);
      return { deletedCount: 1 };
    };

    M.findByIdAndDelete = async (id) => M.deleteOne({ _id: id });

    M.deleteMany = async (filtro = {}) => {
      const lista = colecao(nome);
      const manter = lista.filter((d) => !casa(d, filtro));
      const removidos = lista.length - manter.length;
      colecoes.set(nome, manter);
      return { deletedCount: removidos };
    };

    M.bulkWrite = async (operacoes) => {
      for (const op of operacoes || []) {
        if (!op.updateOne) continue;
        const { filter, update, upsert } = op.updateOne;
        const lista = colecao(nome);
        let doc = lista.find((d) => casa(d, filter));
        if (!doc && upsert) {
          doc = comMetodos(comDefaults({ ...filter }), nome);
          lista.push(doc);
        }
        if (doc) aplicar(doc, update);
      }
      return { ok: 1 };
    };

    /** Só o formato de agregação que routes/importacao.js usa: $match + $group. */
    M.aggregate = async (etapas) => {
      let docs = colecao(nome).map((d) => ({ ...d }));
      for (const etapa of etapas || []) {
        if (etapa.$match) docs = docs.filter((d) => casa(d, etapa.$match));
        else if (etapa.$group) {
          const g = etapa.$group;
          const grupos = new Map();
          for (const d of docs) {
            const chave = typeof g._id === 'string' && g._id.startsWith('$')
              ? pegar(d, g._id.slice(1)) : g._id;
            if (!grupos.has(chave)) grupos.set(chave, { _id: chave, __itens: [] });
            grupos.get(chave).__itens.push(d);
          }
          docs = [...grupos.values()].map((grupo) => {
            const saida = { _id: grupo._id };
            for (const [campo, expr] of Object.entries(g)) {
              if (campo === '_id') continue;
              if (expr.$sum !== undefined) {
                saida[campo] = grupo.__itens.reduce((soma, d) => {
                  if (expr.$sum === 1) return soma + 1;
                  if (expr.$sum && expr.$sum.$cond) {
                    const [teste, sim, nao] = expr.$sum.$cond;
                    return soma + (avaliar(teste, d) ? sim : nao);
                  }
                  return soma + Number(pegar(d, String(expr.$sum).slice(1)) || 0);
                }, 0);
              }
            }
            return saida;
          });
        }
      }
      return docs;
    };

    return M;
  };

  return { colecoes, colecao };
}

/** Avalia $eq/$and dentro de um $cond de agregação. */
function avaliar(expr, doc) {
  if (expr && expr.$and) return expr.$and.every((e) => avaliar(e, doc));
  if (expr && expr.$or) return expr.$or.some((e) => avaliar(e, doc));
  if (expr && expr.$eq) {
    const [a, b] = expr.$eq;
    const va = typeof a === 'string' && a.startsWith('$') ? pegar(doc, a.slice(1)) : a;
    const vb = typeof b === 'string' && b.startsWith('$') ? pegar(doc, b.slice(1)) : b;
    return va === vb;
  }
  return !!expr;
}

/** Faz o /api/saude responder "banco de pé". Só depois dos models prontos. */
function fingirConectado() {
  Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });
}

module.exports = { instalar, fingirConectado, colecao, colecoes };
