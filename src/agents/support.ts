/** Support Agent (section 14): returns intake, standard replies, escalation rules. */
import { db, one } from '../db/pool.js';
import { requestApproval, raiseAlert } from '../services/alerts.js';
import { logAction } from '../services/audit.js';
import { toSek } from '../services/fx.js';
import { ctx } from './context.js';

export type Intent = 'WHERE_IS_MY_ORDER' | 'RETURN_REQUEST' | 'REFUND_STATUS' | 'PRODUCT_QUESTION' | 'CANCEL_REQUEST' | 'OTHER';

/** Must escalate to owner — never auto-handled (legal, disputes, chargebacks, threats, account/policy). */
const ESCALATE = /(chargeback|återbetalningskrav|a-?to-?z|garantie|dispute|tvist|lawyer|advokat|anwalt|rechtsanwalt|court|domstol|gericht|polis|police|polizei|konsumentverket|arn\b|verbraucherzentrale|fraud|bedrägeri|betrug|scam|injur|skad|verletz|fire|brand|burn|allergic|policy violation|account warning|trading standards)/i;

export function classifyMessage(text: string): { intent: Intent; escalate: boolean; reason?: string } {
  const t = text.toLowerCase();
  const esc = t.match(ESCALATE);
  let intent: Intent = 'OTHER';
  if (/(where|var är|wo ist|tracking|spårning|sendungsverfolgung|not arrived|inte kommit|nicht angekommen)/.test(t)) intent = 'WHERE_IS_MY_ORDER';
  else if (/(return|retur|rücksend|zurücksenden|ångra|widerruf)/.test(t)) intent = 'RETURN_REQUEST';
  else if (/(refund|återbetal|erstattung|rückerstattung)/.test(t)) intent = 'REFUND_STATUS';
  else if (/(cancel|avbryt|stornieren|avbeställ)/.test(t)) intent = 'CANCEL_REQUEST';
  else if (/\?/.test(t)) intent = 'PRODUCT_QUESTION';
  return esc ? { intent, escalate: true, reason: `escalation keyword "${esc[0]}"` } : { intent, escalate: intent === 'OTHER' || intent === 'PRODUCT_QUESTION' };
}

/** Templates contain only facts from our DB (tracking, dates). Product questions are escalated (never invent specs). */
export const TEMPLATES: Record<string, Record<string, string>> = {
  sv: {
    WHERE_IS_MY_ORDER: 'Hej! Din order {order} skickades {shipped} med {carrier}. Spårningsnummer: {tracking} ({url}). Vänliga hälsningar',
    RETURN_REQUEST: 'Hej! Du har 14 dagars ångerrätt. Vi har registrerat din returförfrågan för order {order} och återkommer med returinstruktioner. Vänliga hälsningar',
    REFUND_STATUS: 'Hej! Återbetalningen för order {order} har status: {refund_status}. Vänliga hälsningar',
  },
  de: {
    WHERE_IS_MY_ORDER: 'Hallo! Ihre Bestellung {order} wurde am {shipped} mit {carrier} versendet. Sendungsnummer: {tracking} ({url}). Viele Grüße',
    RETURN_REQUEST: 'Hallo! Sie haben ein 14-tägiges Widerrufsrecht. Wir haben Ihre Rücksendeanfrage für Bestellung {order} registriert und senden Ihnen die Rücksendeinformationen. Viele Grüße',
    REFUND_STATUS: 'Hallo! Die Erstattung für Bestellung {order} hat den Status: {refund_status}. Viele Grüße',
  },
};

export async function runReturns() {
  const c = await ctx();
  let n = 0;
  for (const mp of c.marketplaces) {
    const a = c.reg.marketplaces.get(mp.code);
    if (!a) continue;
    for (const r of await a.fetchReturns(new Date(Date.now() - 14 * 864e5))) {
      const o = await one(`SELECT id, order_total_sek FROM orders WHERE marketplace_code=$1 AND external_order_id=$2`, [mp.code, r.externalOrderId]);
      if (!o) continue;
      const amountSek = r.refundAmount != null ? await toSek(r.refundAmount, mp.currency) : Number(o.order_total_sek);
      const needsOwner = amountSek > c.s.MAX_REFUND_WITHOUT_APPROVAL_SEK || !c.caps.refunds || ESCALATE.test(r.reason);
      const ins = await db().query(`INSERT INTO returns(order_id, external_return_id, reason, status, refund_amount_sek, requires_owner) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
        [o.id, r.externalReturnId, r.reason.slice(0, 500), r.status, amountSek, needsOwner]);
      if (!ins.rowCount) continue;
      n++;
      await logAction({ agent: 'support', action: 'RETURN_RECEIVED', subjectType: 'order', subjectId: o.id, decision: needsOwner ? 'ESCALATED' : 'AUTO', data: { amountSek, reason: r.reason } });
      if (needsOwner) await requestApproval('REFUND', `${mp.code}:${r.externalReturnId}`, { order: r.externalOrderId, amountSek, reason: r.reason });
      await raiseAlert({ severity: 'INFO', category: 'RETURN', title: `Return ${r.externalReturnId} on ${mp.code}`, dedupeKey: `return:${r.externalReturnId}` });
    }
  }
  return { newReturns: n };
}
