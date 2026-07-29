'use strict';

const mongoose = require('mongoose');

/**
 * Login do sistema. Três perfis, no mesmo desenho que já funciona no painel de
 * faturamento da Ativação:
 *
 *  - 'admin'    acesso total, inclusive à aba de usuários e às importações
 *  - 'interno'  equipe do escritório: vê pedidos e catálogo, não mexe em cadastro
 *  - 'cliente'  login externo, entregue ao comprador. NÃO enxerga nada do painel
 *               (ver requireInterno em middleware/auth.js). Só o catálogo.
 *
 * O desconto do cliente mora aqui e NUNCA é enviado ao navegador dele. O preço
 * sai calculado do servidor. Se o desconto trafegasse, a margem ficaria visível
 * no código da página.
 */
const UsuarioSchema = new mongoose.Schema(
  {
    nome: { type: String, required: true, trim: true },
    usuario: { type: String, required: true, unique: true, lowercase: true, trim: true },
    senhaHash: { type: String, required: true },
    perfil: { type: String, enum: ['admin', 'interno', 'cliente'], required: true },
    ativo: { type: Boolean, default: true },
    email: { type: String, default: '', trim: true },

    /* ------------ campos usados só quando perfil === 'cliente' ------------ */

    razaoSocial: { type: String, default: '' },
    cnpj: { type: String, default: '' },
    endereco: { type: String, default: '' },
    telefone: { type: String, default: '' },
    vendedor: { type: String, default: '' },
    transportadora: { type: String, default: '' },

    /**
     * Desconto do cliente sobre o "Preço c/ IPI" da tabela, como fração.
     * 0.12 = 12%. Informação interna.
     */
    desconto: { type: Number, default: 0, min: 0, max: 0.95 },

    /**
     * Trava de acesso ao catálogo, controlada pelo admin:
     *  - 'travado' (padrão): o login funciona, mas o cliente vê um aviso e não
     *    entra. É o estado enquanto a base e o desconto estão sendo preparados.
     *  - 'live': o cliente acessa e envia pedido.
     */
    catalogoStatus: { type: String, enum: ['travado', 'live'], default: 'travado' },

    /** Deixa o cliente ver a seção Outlet. Ligado por padrão. */
    verOutlet: { type: Boolean, default: true },

    /** Deixa o cliente reservar item sem saldo, contra a previsão de chegada. */
    permitirProgramado: { type: Boolean, default: true },

    /**
     * Quais marcas (abas) esse cliente enxerga no catálogo. Escolhido pelo
     * admin no cadastro do cliente. Default `['maxprint']` de propósito: todo
     * cliente que já existia antes do sistema virar multimarca continua
     * vendo exatamente o que via antes, sem precisar de migração de dados.
     */
    marcasPermitidas: { type: [String], default: ['maxprint'] },

    ultimoAcesso: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Usuario', UsuarioSchema);
