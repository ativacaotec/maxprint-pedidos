'use strict';

/**
 * Aviso de pedido novo por e-mail.
 *
 * Usa um serviço dedicado de envio (Resend por padrão, Brevo como alternativa)
 * em vez do SMTP do domínio. Motivo: aviso que cai no spam não é aviso. Os dois
 * têm plano gratuito suficiente para o volume de pedidos.
 *
 * Se a chave não estiver configurada, o sistema NÃO quebra: o pedido é gravado
 * normalmente e o envio fica registrado como pendente. Aviso é importante, mas
 * não pode ser a razão de um pedido se perder.
 */

const PROVEDOR = (process.env.EMAIL_PROVEDOR || 'resend').toLowerCase();
const CHAVE = process.env.EMAIL_API_KEY || '';
const REMETENTE = process.env.EMAIL_REMETENTE || 'pedidos@ativacaorep.tech';
const NOME_REMETENTE = process.env.EMAIL_NOME || 'Pedidos Maxprint';

function configurado() {
  return Boolean(CHAVE);
}

function dinheiro(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function montarHtml(pedido, urlPainel) {
  const linhas = (pedido.itens || [])
    .slice(0, 25)
    .map(
      (i) => `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#666">${i.codigoOriginal || i.codigo}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${escapar(i.nome)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;text-align:center">${i.quantidade}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;text-align:right">${dinheiro(i.total)}</td>
      </tr>`
    )
    .join('');

  const sobra = (pedido.itens || []).length - 25;

  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:640px;margin:0 auto;background:#fff">
    <div style="background:#000;padding:18px 24px">
      <div style="color:#fff;font-size:18px;font-weight:bold">Pedido novo nº ${pedido.numero}</div>
      <div style="color:#EB8704;font-size:13px;margin-top:2px">${escapar(pedido.razaoSocial)}</div>
    </div>
    <div style="padding:20px 24px">
      <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
        <tr><td style="font-size:13px;color:#666;padding:3px 0">Total</td>
            <td style="font-size:20px;font-weight:bold;color:#EB8704;text-align:right">${dinheiro(pedido.total)}</td></tr>
        <tr><td style="font-size:13px;color:#666;padding:3px 0">Condição</td>
            <td style="font-size:13px;text-align:right">${escapar(pedido.condicaoRotulo)}</td></tr>
        <tr><td style="font-size:13px;color:#666;padding:3px 0">Itens / peças</td>
            <td style="font-size:13px;text-align:right">${(pedido.itens || []).length} itens · ${pedido.pecas} peças</td></tr>
        <tr><td style="font-size:13px;color:#666;padding:3px 0">Frete</td>
            <td style="font-size:13px;text-align:right">${escapar(pedido.frete || '-')}</td></tr>
        ${pedido.totalProgramado > 0
          ? `<tr><td style="font-size:13px;color:#666;padding:3px 0">Programado</td>
               <td style="font-size:13px;text-align:right">${dinheiro(pedido.totalProgramado)}</td></tr>`
          : ''}
      </table>

      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:#f4f4f5">
          <th style="padding:6px 8px;text-align:left;font-size:11px;color:#666">CÓDIGO</th>
          <th style="padding:6px 8px;text-align:left;font-size:11px;color:#666">PRODUTO</th>
          <th style="padding:6px 8px;text-align:center;font-size:11px;color:#666">QTD</th>
          <th style="padding:6px 8px;text-align:right;font-size:11px;color:#666">TOTAL</th>
        </tr></thead>
        <tbody>${linhas}</tbody>
      </table>
      ${sobra > 0 ? `<p style="font-size:12px;color:#666">e mais ${sobra} itens.</p>` : ''}

      <p style="margin-top:22px">
        <a href="${urlPainel}" style="background:#EB8704;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-size:14px;display:inline-block">Abrir o pedido no painel</a>
      </p>
    </div>
    <div style="padding:14px 24px;background:#f4f4f5;font-size:11px;color:#8D8E8E">
      Ativação Group · representação Maxprint
    </div>
  </div></body></html>`;
}

function escapar(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function enviarAvisoPedido(pedido, destinatarios, urlPainel) {
  if (!configurado()) {
    return { enviado: false, motivo: 'EMAIL_API_KEY não configurada' };
  }
  const para = (destinatarios || []).filter(Boolean);
  if (!para.length) return { enviado: false, motivo: 'nenhum destinatário cadastrado' };

  const assunto = `Pedido ${pedido.numero} · ${pedido.razaoSocial} · ${dinheiro(pedido.total)}`;
  const html = montarHtml(pedido, urlPainel);

  try {
    if (PROVEDOR === 'brevo') {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': CHAVE, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: REMETENTE, name: NOME_REMETENTE },
          to: para.map((email) => ({ email })),
          subject: assunto,
          htmlContent: html,
        }),
      });
      if (!r.ok) throw new Error(`Brevo respondeu ${r.status}: ${await r.text()}`);
      return { enviado: true };
    }

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${CHAVE}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: `${NOME_REMETENTE} <${REMETENTE}>`,
        to: para,
        subject: assunto,
        html,
      }),
    });
    if (!r.ok) throw new Error(`Resend respondeu ${r.status}: ${await r.text()}`);
    return { enviado: true };
  } catch (e) {
    return { enviado: false, motivo: e.message };
  }
}

module.exports = { enviarAvisoPedido, configurado };
