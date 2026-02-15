/// <reference path="../deno-shims.d.ts" />
import { serve } from "https://deno.land/std@0.201.0/http/server.ts";

// Helper: percent-encode per RFC3986 for OAuth
function rfc3986Encode(str: string) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

async function hmacSha1Base64(key: string, data: string) {
  const enc = new TextEncoder();
  const keyBuf = enc.encode(key);
  const cryptoKey = await crypto.subtle.importKey('raw', keyBuf, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  const bytes = new Uint8Array(sig as ArrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

serve(async (req: Request) => {
  try {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
    const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE') || '';

    const PESAPAL_KEY = Deno.env.get('PESAPAL_KEY') || '';
    const PESAPAL_SECRET = Deno.env.get('PESAPAL_SECRET') || '';
    const PESAPAL_ENV = (Deno.env.get('PESAPAL_ENVIRONMENT') || 'TEST').toLowerCase();

    if (!PESAPAL_KEY || !PESAPAL_SECRET) {
      return new Response(JSON.stringify({ success: false, error: 'Missing PesaPal credentials in environment' }), { status: 500 });
    }

    const body = await req.json();
    const { order_id, amount, email = '', phone = '', first_name = '', last_name = '', description = '', callback_url = '', cancellation_url = '' } = body;
    if (!order_id || !amount || !callback_url) return new Response(JSON.stringify({ success: false, error: 'order_id, amount and callback_url are required' }), { status: 400 });

    const pesapalBase = PESAPAL_ENV === 'live' ? 'https://www.pesapal.com' : 'https://demo.pesapal.com';
    const endpoint = `${pesapalBase}/API/PostPesapalDirectOrderV4`;

    // generate local tracking id (merchant reference) so we can match callbacks
    const orderTrackingId = `PP-${Date.now()}`;

    const xml = `<PesapalDirectOrderInfo xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\">` +
      `<Amount>${amount}</Amount>` +
      `<Description>${description}</Description>` +
      `<Type>MERCHANT</Type>` +
      `<Reference>${orderTrackingId}</Reference>` +
      `<FirstName>${first_name}</FirstName>` +
      `<LastName>${last_name}</LastName>` +
      `<EmailAddress>${email}</EmailAddress>` +
      `<PhoneNumber>${phone}</PhoneNumber>` +
      `<Currency>KES</Currency>` +
      `<CallbackUrl>${callback_url}</CallbackUrl>` +
      `</PesapalDirectOrderInfo>`;

    // OAuth 1.0 parameters (will sign with HMAC-SHA1)
    const oauthParams: { [k: string]: string } = {
      oauth_consumer_key: PESAPAL_KEY,
      oauth_nonce: Math.random().toString(36).substring(2),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_version: '1.0',
      pesapal_request_data: xml
    };

    // build normalized parameter string
    const sortedKeys = Object.keys(oauthParams).sort();
    const paramString = sortedKeys.map(k => `${rfc3986Encode(k)}=${rfc3986Encode(oauthParams[k])}`).join('&');

    const signatureBase = `GET&${rfc3986Encode(endpoint)}&${rfc3986Encode(paramString)}`;
    const signingKey = `${PESAPAL_SECRET}&`;
    const signature = await hmacSha1Base64(signingKey, signatureBase);

    const finalQuery = `${paramString}&oauth_signature=${rfc3986Encode(signature)}`;
    const redirectUrl = `${endpoint}?${finalQuery}`;

    // persist the pesapal_tracking_id on the order and mark pending
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${order_id}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify({ pesapal_tracking_id: orderTrackingId, payment_status: 'pending' })
    });

    return new Response(JSON.stringify({ success: true, redirect_url: redirectUrl, order_tracking_id: orderTrackingId }), { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ success: false, error: message }), { status: 500 });
  }
});