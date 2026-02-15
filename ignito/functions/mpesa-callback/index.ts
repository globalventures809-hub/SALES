/// <reference path="../deno-shims.d.ts" />
import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

/**
 * mpesa-callback
 * - Accepts M-Pesa STK callback, verifies IP, updates order status
 */

serve(async (req: Request) => {
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
    const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE') || '';
    const allowed = (Deno.env.get('MPESA_CALLBACK_IPS') || '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const remote = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || '';

    if (allowed.length && !allowed.includes(remote)) {
      return new Response('Forbidden', { status: 403 });
    }

    const body = await req.json();

    // Safaricom STK callback structure: Body.stkCallback
    const stk = body?.Body?.stkCallback || body?.stkCallback || null;
    if (!stk) {
      return new Response('Bad Request - missing stkCallback', { status: 400 });
    }

    const checkoutRequestID = stk.CheckoutRequestID;
    const merchantRequestID = stk.MerchantRequestID;
    const resultCode = stk.ResultCode;
    const resultDesc = stk.ResultDesc || '';

    // find order by checkoutRequestID (we stored it earlier on initiation)
    const status = (resultCode === 0 || resultCode === '0') ? 'completed' : 'failed';

    // try to extract receipt and amount from CallbackMetadata
    let mpesaReceipt = null;
    let mpesaAmount: number | null = null;
    let mpesaTransactionDate: string | null = null;

    const metaItems = stk.CallbackMetadata?.Item || [];
    for (const item of metaItems) {
      const name = item.Name || item.name;
      if (!name) continue;
      if (name.toLowerCase().includes('receipt') || name.toLowerCase().includes('mpesareceiptnumber')) mpesaReceipt = item.Value;
      if (name.toLowerCase().includes('amount')) mpesaAmount = Number(item.Value);
      if (name.toLowerCase().includes('transactiondate')) mpesaTransactionDate = String(item.Value);
    }

    await fetch(`${SUPABASE_URL}/rest/v1/orders?mpesa_checkout_id=eq.${encodeURIComponent(checkoutRequestID)}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ payment_status: status, mpesa_receipt: mpesaReceipt, mpesa_amount: mpesaAmount, mpesa_transaction_date: mpesaTransactionDate, mpesa_result_code: resultCode, mpesa_result_desc: resultDesc })
    });

    return new Response('OK', { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(message, { status: 500 });
  }
});
