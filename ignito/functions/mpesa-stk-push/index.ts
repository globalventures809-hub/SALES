/// <reference path="../deno-shims.d.ts" />
import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

/**
 * mpesa-stk-push (Supabase Edge Function)
 * - Expects JSON { order_id, phone, amount, description }
 * - Initiates real Safaricom M-Pesa STK Push (sandbox or production depending on env)
 * - Updates `orders` via SUPABASE_SERVICE_ROLE with `payment_status: 'pending'` and checkout IDs
 */

serve(async (req: Request) => {
  try {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
    const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE') || '';

    const MPESA_ENV = (Deno.env.get('MPESA_ENVIRONMENT') || 'sandbox').toLowerCase();
    const MPESA_CONSUMER_KEY = Deno.env.get('MPESA_CONSUMER_KEY') || '';
    const MPESA_CONSUMER_SECRET = Deno.env.get('MPESA_CONSUMER_SECRET') || '';
    const MPESA_SHORTCODE = Deno.env.get('MPESA_SHORTCODE') || '';
    const MPESA_PASSKEY = Deno.env.get('MPESA_PASSKEY') || '';

    const body = await req.json();
    const { order_id, phone, amount, description } = body;
    if (!order_id || !phone || !amount) {
      return new Response(JSON.stringify({ success: false, error: 'order_id, phone and amount are required' }), { status: 400 });
    }

    if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET || !MPESA_SHORTCODE || !MPESA_PASSKEY) {
      return new Response(JSON.stringify({ success: false, error: 'Missing MPESA credentials in environment' }), { status: 500 });
    }

    const base = MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

    // 1) obtain access token
    const basic = btoa(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`);
    const tokenResp = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${basic}` }
    });

    if (!tokenResp.ok) {
      const txt = await tokenResp.text();
      return new Response(JSON.stringify({ success: false, error: 'failed to obtain access token', detail: txt }), { status: 502 });
    }

    const tokenJson = await tokenResp.json();
    const accessToken = tokenJson.access_token;

    // 2) prepare STK payload
    const pad = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const password = btoa(MPESA_SHORTCODE + MPESA_PASSKEY + timestamp);

    let msisdn = phone.replace(/\s+/g, '');
    if (msisdn.startsWith('+')) msisdn = msisdn.slice(1);
    if (msisdn.startsWith('0')) msisdn = '254' + msisdn.slice(1);

    const callbackUrl = Deno.env.get('MPESA_CALLBACK_URL') || `${Deno.env.get('BASE_URL') || ''}/ignito/functions/mpesa-callback`;

    const payload = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: msisdn,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: msisdn,
      CallBackURL: callbackUrl,
      AccountReference: `order-${order_id}`,
      TransactionDesc: description || `Payment for order ${order_id}`
    };

    const stkResp = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const stkJson = await stkResp.json();

    if (!stkResp.ok || stkJson.ResponseCode !== '0') {
      return new Response(JSON.stringify({ success: false, error: stkJson.errorMessage || stkJson.error || stkJson.ResponseDescription || 'STK push failed', detail: stkJson }), { status: 502 });
    }

    const merchantRequestId = stkJson.MerchantRequestID;
    const checkoutRequestId = stkJson.CheckoutRequestID;

    // 3) update order in Supabase (server-side)
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${order_id}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify({ payment_status: 'pending', mpesa_checkout_id: checkoutRequestId, mpesa_merchant_request_id: merchantRequestId, mpesa_phone: msisdn })
    });

    return new Response(JSON.stringify({ success: true, checkout_request_id: checkoutRequestId, merchant_request_id: merchantRequestId }), { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ success: false, error: message }), { status: 500 });
  }
});
