/// <reference path="../deno-shims.d.ts" />
import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

/**
 * pesapal-callback
 * - Verifies origin IP against PESAPAL_CALLBACK_IPS (env)
 * - Updates order status in Supabase
 */

serve(async (req: Request) => {
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
    const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE') || '';
    const allowed = (Deno.env.get('PESAPAL_CALLBACK_IPS') || '').split(',').map((s: string) => s.trim()).filter(Boolean);

    const remote = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || '';
    if (allowed.length && !allowed.includes(remote)) {
      return new Response('Forbidden', { status: 403 });
    }

    // Accept both JSON payloads and GET callbacks from PesaPal (merchant_reference + transaction id)
    let orderTrackingId: string | null = null;
    let transactionId: string | null = null;
    let newStatus: string | null = null;

    if (req.method === 'GET') {
      const u = new URL(req.url);
      orderTrackingId = u.searchParams.get('pesapal_merchant_reference');
      transactionId = u.searchParams.get('pesapal_transaction_tracking_id');
    } else {
      // try JSON first, then form-encoded
      const text = await req.text();
      try {
        const parsed = JSON.parse(text || '{}');
        orderTrackingId = parsed.order_tracking_id || parsed.merchant_reference || parsed.pesapal_merchant_reference || orderTrackingId;
        transactionId = parsed.transaction_id || parsed.pesapal_transaction_tracking_id || transactionId;
        newStatus = parsed.status || newStatus;
      } catch (e) {
        const params = new URLSearchParams(text);
        orderTrackingId = params.get('pesapal_merchant_reference') || orderTrackingId;
        transactionId = params.get('pesapal_transaction_tracking_id') || transactionId;
        newStatus = params.get('status') || newStatus;
      }
    }

    if (!orderTrackingId) return new Response('Bad Request', { status: 400 });

    const statusToSet = transactionId ? 'completed' : (newStatus || 'failed');

    await fetch(`${SUPABASE_URL}/rest/v1/orders?pesapal_tracking_id=eq.${encodeURIComponent(orderTrackingId)}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ payment_status: statusToSet, pesapal_transaction_id: transactionId })
    });

    // If it's a GET redirect from the customer, return a simple HTML or redirect
    if (req.method === 'GET') return new Response('OK', { status: 200 });
    return new Response('OK', { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(message, { status: 500 });
  }
});
