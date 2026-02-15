require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const fetch = require('node-fetch');
const app = express();

// capture raw body for webhook signature verification
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf && buf.toString(); }
}));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const PESAPAL_KEY = process.env.PESAPAL_KEY || '';
const PESAPAL_SECRET = process.env.PESAPAL_SECRET || '';
const PESAPAL_ENV = (process.env.PESAPAL_ENVIRONMENT || 'TEST').toLowerCase();
const PESAPAL_CALLBACK_IPS = (process.env.PESAPAL_CALLBACK_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
const PESAPAL_CALLBACK_SECRET = process.env.PESAPAL_CALLBACK_SECRET || ''; // optional HMAC secret for callbacks
const BASE_URL = process.env.BASE_URL || '';
const crypto = require('crypto');

app.post('/mpesa-stk-push', async (req, res) => {
  const { order_id, phone, amount } = req.body;
  if (!order_id || !phone || !amount) return res.status(400).json({ error: 'order_id, phone and amount required' });
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${order_id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ status: 'stk_requested', mpesa_phone: phone })
    });
    return res.json({ ok: true, message: 'STK push simulated (mock server)' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/pesapal-create-order', async (req, res) => {
  const { order_id } = req.body;
  if (!order_id) return res.status(400).json({ error: 'order_id required' });
  try {
    const fakeTrackingId = `PP-${Date.now()}`;
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${order_id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ pesapal_tracking_id: fakeTrackingId, status: 'pesapal_initiated' })
    });
    return res.json({ ok: true, order_tracking_id: fakeTrackingId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/pesapal-callback', async (req, res) => {
  // Basic security: IP allowlist and optional HMAC verification
  const remoteIp = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();

  if (PESAPAL_CALLBACK_IPS.length > 0 && !PESAPAL_CALLBACK_IPS.includes(remoteIp) && !PESAPAL_CALLBACK_IPS.includes(req.ip)) {
    console.warn('Pesapal callback rejected - IP not allowed:', remoteIp);
    return res.status(403).send('Forbidden');
  }

  // If a callback secret / signature header is present, verify HMAC
  const sigHeader = req.headers['x-pesapal-signature'] || req.headers['x-signature'] || req.headers['x-hook-signature'];
  if (PESAPAL_CALLBACK_SECRET && sigHeader) {
    try {
      const computed = crypto.createHmac('sha256', PESAPAL_CALLBACK_SECRET).update(req.rawBody || JSON.stringify(req.body)).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(String(sigHeader)))) {
        console.warn('Pesapal callback signature mismatch');
        return res.status(401).send('Invalid signature');
      }
    } catch (e) {
      console.warn('Pesapal signature verification failed', e.message);
      return res.status(401).send('Invalid signature');
    }
  }

  const payload = req.body || {};
  // Accept multiple possible property names from PesaPal
  const orderTrackingId = payload.order_tracking_id || payload.merchant_reference || payload.pesapal_merchant_reference || payload.orderTrackingId;
  const status = payload.status || 'paid';
  if (!orderTrackingId) return res.status(400).send('Bad Request');

  try {
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
      await fetch(`${SUPABASE_URL}/rest/v1/orders?pesapal_tracking_id=eq.${encodeURIComponent(orderTrackingId)}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({ payment_status: status || 'paid', pesapal_transaction_id: payload.transaction_id || payload.pesapal_transaction_tracking_id || null })
      });
    } else {
      // update in-memory order if present
      const idx = orders.findIndex(o => o.pesapal_tracking_id === orderTrackingId);
      if (idx !== -1) orders[idx].status = status || 'paid';
    }
    return res.send('OK');
  } catch (err) {
    console.error('Pesapal callback processing error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.post('/mpesa-callback', async (req, res) => {
  const { order_id, resultCode } = req.body;
  if (!order_id) return res.status(400).send('Bad Request');
  try {
    const status = (resultCode === 0 || resultCode === '0') ? 'paid' : 'failed';
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${order_id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ status })
    });
    return res.send('OK');
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

// --- Lightweight CORS so the frontend can call these mock endpoints ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve static files from project root (so index.html is available)
const path = require('path');
app.use(express.static(path.join(__dirname, '..')));

// --- In-memory mock data (mirrors frontend) ---
const kenyaCounties = {
  "Nairobi": ["Westlands", "Dagoretti North", "Dagoretti South", "Lang'ata", "Kibra", "Roysambu", "Kasarani", "Ruaraka", "Embakasi South", "Embakasi North", "Embakasi Central", "Embakasi East", "Embakasi West", "Makadara", "Kamukunji", "Starehe", "Mathare"],
  "Mombasa": ["Changamwe", "Jomvu", "Kisauni", "Nyali", "Likoni", "Mvita"],
  "Kisumu": ["Kisumu East", "Kisumu West", "Kisumu Central", "Seme", "Nyando", "Muhoroni", "Nyakach"],
  "Nakuru": ["Nakuru Town West", "Nakuru Town East", "Kuresoi South", "Kuresoi North", "Molo", "Njoro", "Naivasha", "Gilgil", "Subukia", "Rongai", "Bahati"],
  "Kiambu": ["Gatundu South", "Gatundu North", "Juja", "Thika Town", "Ruiru", "Githunguri", "Kiambu", "Kiambaa", "Kabete", "Kikuyu", "Limuru", "Lari"],
  "Kajiado": ["Kajiado North", "Kajiado Central", "Kajiado East", "Kajiado West", "Kajiado South"],
  "Machakos": ["Machakos Town", "Mavoko", "Kangundo", "Kathiani", "Athi River", "Matungulu", "Masinga", "Yatta", "Mwala"]
};

const products = [
  { id: 1, name: "iPhone 14 Pro Max", category: "phones", condition: "new", price: 145000, originalPrice: 165000, image: "https://images.unsplash.com/photo-1678685888221-cda773a3dcdb?w=500", rating: 4.8, reviews: 124, badge: "Best Seller", seller: "Apple Store KE" },
  { id: 2, name: "Samsung 55\" Crystal UHD", category: "electronics", condition: "new", price: 58999, originalPrice: 72000, image: "https://images.unsplash.com/photo-1593359677879-a4bb92f829d1?w=500", rating: 4.6, reviews: 89, badge: "Flash Deal", seller: "Samsung Official" },
  { id: 3, name: "Nike Air Force 1", category: "fashion", condition: "new", price: 8500, originalPrice: 12000, image: "https://images.unsplash.com/photo-1549298916-b41d501d3772?w=500", rating: 4.9, reviews: 256, badge: "Trending", seller: "Nike Store" },
  { id: 4, name: "MacBook Air M2", category: "electronics", condition: "refurbished", price: 115000, originalPrice: 145000, image: "https://images.unsplash.com/photo-1611186871348-b1ce696e52c9?w=500", rating: 4.7, reviews: 67, badge: "Certified Refurb", seller: "TechHub Kenya" },
  { id: 5, name: "Sony WH-1000XM4", category: "electronics", condition: "openbox", price: 28999, originalPrice: 45000, image: "https://images.unsplash.com/photo-1618366712010-f4ae9c647dcb?w=500", rating: 4.8, reviews: 156, badge: "Open Box", seller: "ElectroHub" },
  { id: 6, name: "Versace Eros Perfume", category: "beauty", condition: "new", price: 9500, originalPrice: 14000, image: "https://images.unsplash.com/photo-1592945403244-b3fbafd7f539?w=500", rating: 4.9, reviews: 203, badge: "Authentic", seller: "Beauty World" },
  { id: 7, name: "Toyota Car Mats (Custom)", category: "automotive", condition: "new", price: 4500, originalPrice: 6500, image: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=500", rating: 4.5, reviews: 45, badge: "Custom Fit", seller: "AutoZone KE" },
  { id: 8, name: "Dyson V11 Vacuum", category: "home", condition: "used", price: 35000, originalPrice: 75000, image: "https://images.unsplash.com/photo-1558317374-a354d5f6d40b?w=500", rating: 4.6, reviews: 34, badge: "Like New", seller: "Home Essentials" },
  { id: 9, name: "PlayStation 5 Console", category: "electronics", condition: "new", price: 72000, originalPrice: 85000, image: "https://images.unsplash.com/photo-1606813907291-d86efa9b94db?w=500", rating: 4.9, reviews: 312, badge: "Hot", seller: "GameSpot" },
  { id: 10, name: "Ankara Dress (Kitenge)", category: "fashion", condition: "new", price: 3200, originalPrice: 5500, image: "https://images.unsplash.com/photo-1595777457583-95e059d581b8?w=500", rating: 4.7, reviews: 89, badge: "Local Design", seller: "Mama Africa" },
  { id: 11, name: "Samsung Galaxy S23", category: "phones", condition: "refurbished", price: 68000, originalPrice: 95000, image: "https://images.unsplash.com/photo-1610945415295-d9bbf067e59c?w=500", rating: 4.6, reviews: 78, badge: "Refurb A+", seller: "PhoneHub" },
  { id: 12, name: "Nutribullet Pro 900", category: "home", condition: "new", price: 8500, originalPrice: 12000, image: "https://images.unsplash.com/photo-1570222094114-28a9d8896b74?w=500", rating: 4.5, reviews: 134, badge: "Healthy", seller: "Kitchen Plus" }
];

const orders = []; // in-memory orders for demonstration

// --- Mock API endpoints (non-destructive) ---
app.get('/api/products', (req, res) => {
  const { category, condition, q } = req.query;
  let list = products.slice();
  if (category && category !== 'all') list = list.filter(p => p.category === category);
  if (condition && condition !== 'all') list = list.filter(p => p.condition === condition);
  if (q) list = list.filter(p => p.name.toLowerCase().includes(String(q).toLowerCase()));
  res.json(list);
});

app.get('/api/counties', (req, res) => res.json(kenyaCounties));

app.post('/api/checkout', async (req, res) => {
  const { cart, user, address, payment = 'mpesa', discount = 0 } = req.body || {};
  if (!Array.isArray(cart) || !user || !address) return res.status(400).json({ error: 'cart, user and address required' });

  const subtotal = cart.reduce((s, it) => s + (it.price * (it.quantity || 1)), 0);
  const delivery = 250;
  const total = subtotal + delivery - discount;
  const orderPayload = { cart: JSON.stringify(cart), user_email: user.email || null, user_name: user.name || null, user_phone: user.phone || null, shipping_address: JSON.stringify(address), payment_method: payment, subtotal, delivery, discount, total, status: 'pending' };

  // Persist to Supabase when service role is available
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
    try {
      const suResp = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify(orderPayload)
      });
      const inserted = await suResp.json();
      const created = Array.isArray(inserted) ? inserted[0] : inserted;
      return res.json({ ok: true, orderId: created.id, total });
    } catch (err) {
      console.error('Supabase insert failed (checkout):', err.message);
      // fallthrough to in-memory
    }
  }

  // fallback to in-memory order
  const order = { id: Date.now(), cart, user, address, payment, subtotal, delivery, discount, total, status: 'pending' };
  orders.push(order);

  // Simulate payment completion for demo
  setTimeout(() => { order.status = 'paid'; }, 1500);

  res.json({ ok: true, orderId: order.id, total });
});

app.post('/api/auth', async (req, res) => {
  const { email, name, phone } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  const user = { email, name: name || 'Customer', phone: phone || '07XXXXXXXX' };

  // persist profile to Supabase when service role is available
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
    try {
      const suResp = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify({ email: user.email, full_name: user.name, phone: user.phone })
      });
      const inserted = await suResp.json();
      const created = Array.isArray(inserted) ? inserted[0] : inserted;
      const resultUser = { id: created.id || Date.now(), email: created.email || user.email, name: created.full_name || user.name, phone: created.phone || user.phone };
      return res.json({ ok: true, user: resultUser, token: `mock-token-${resultUser.id}` });
    } catch (err) {
      console.error('Supabase insert failed (auth):', err.message);
      // fallthrough to returning mock user
    }
  }

  const resultUser = { id: Date.now(), ...user };
  return res.json({ ok: true, user: resultUser, token: `mock-token-${resultUser.id}` });
});

// --- OTP (development) ---
const otps = {}; // { email: { code, expiresAt } }
app.post('/api/send-otp', (req, res) => {
  const { email } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid email required' });
  const code = String(Math.floor(1000 + Math.random() * 9000));
  otps[email] = { code, expiresAt: Date.now() + 5 * 60 * 1000 }; // 5 minutes
  console.log(`[OTP] ${email} -> ${code}`); // dev preview
  return res.json({ ok: true, preview: code });
});

// Send OTP via email (uses SMTP credentials from .env). Returns preview in dev.
const nodemailer = require('nodemailer');
let mailTransporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  mailTransporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });
}

app.post('/api/send-otp-email', async (req, res) => {
  const { email } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid email required' });

  const code = String(Math.floor(1000 + Math.random() * 9000));
  otps[email] = { code, expiresAt: Date.now() + 5 * 60 * 1000 };

  if (!mailTransporter) {
    console.warn('Email transporter not configured - returning preview only');
    return res.json({ ok: true, preview: code, sent: false });
  }

  try {
    await mailTransporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Your SokoFresh verification code',
      text: `Your verification code is: ${code} (valid for 5 minutes)`
    });
    console.log(`[OTP-email] sent to ${email}`);
    return res.json({ ok: true, preview: code, sent: true });
  } catch (err) {
    console.error('Failed to send OTP email:', err.message);
    return res.status(500).json({ ok: false, error: err.message, preview: code });
  }
});

app.post('/api/verify-otp', (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) return res.status(400).json({ error: 'email and otp required' });
  const record = otps[email];
  if (!record || record.expiresAt < Date.now() || record.code !== String(otp)) {
    return res.status(400).json({ error: 'invalid or expired otp' });
  }
  delete otps[email];
  return res.json({ ok: true, verified: true });
});

// --- Pesapal order creation (creates order in Supabase when configured) ---
app.post('/api/pesapal-create', async (req, res) => {
  const { cart, user, address, discount = 0 } = req.body || {};
  if (!Array.isArray(cart) || !user || !address) return res.status(400).json({ error: 'cart, user and address required' });

  const subtotal = cart.reduce((s, it) => s + (it.price * (it.quantity || 1)), 0);
  const delivery = 250;
  const total = subtotal + delivery - discount;
  const merchantRef = `PSP-${Date.now()}-${Math.floor(Math.random()*9000)+1000}`;

  // Try to persist to Supabase if environment configured, otherwise fall back to in-memory
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
    try {
      const orderPayload = {
        user_email: user.email || null,
        user_name: user.name || null,
        user_phone: user.phone || null,
        cart: JSON.stringify(cart),
        subtotal,
        delivery,
        discount,
        total,
        status: 'pesapal_initiated',
        pesapal_tracking_id: merchantRef,
        shipping_address: JSON.stringify(address)
      };

      const suResp = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(orderPayload)
      });

      const inserted = await suResp.json();
      const created = Array.isArray(inserted) ? inserted[0] : inserted;

      // If Pesapal credentials are present, build real OAuth-signed Pesapal redirect URL
      if (PESAPAL_KEY && PESAPAL_SECRET) {
        const pesapalBase = PESAPAL_ENV === 'live' ? 'https://www.pesapal.com' : 'https://demo.pesapal.com';
        const endpoint = `${pesapalBase}/API/PostPesapalDirectOrderV4`;
        const orderTrackingId = merchantRef;
        const names = (user.name || '').split(' ');
        const firstName = names.shift() || '';
        const lastName = names.join(' ') || '';
        const callbackUrl = process.env.PESAPAL_CALLBACK_URL || (BASE_URL || `${req.protocol}://${req.get('host')}`) + '/pesapal-callback';
        const xml = `<PesapalDirectOrderInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">` +
          `<Amount>${total}</Amount>` +
          `<Description>Order ${created.id}</Description>` +
          `<Type>MERCHANT</Type>` +
          `<Reference>${orderTrackingId}</Reference>` +
          `<FirstName>${firstName}</FirstName>` +
          `<LastName>${lastName}</LastName>` +
          `<EmailAddress>${user.email || ''}</EmailAddress>` +
          `<PhoneNumber>${user.phone || ''}</PhoneNumber>` +
          `<Currency>KES</Currency>` +
          `<CallbackUrl>${callbackUrl}</CallbackUrl>` +
          `</PesapalDirectOrderInfo>`;

        const oauthParams = {
          oauth_consumer_key: PESAPAL_KEY,
          oauth_nonce: Math.random().toString(36).substring(2),
          oauth_signature_method: 'HMAC-SHA1',
          oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
          oauth_version: '1.0',
          pesapal_request_data: xml
        };

        // RFC3986 encode
        const rfc3986Encode = (str) => encodeURIComponent(str).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
        const sortedKeys = Object.keys(oauthParams).sort();
        const paramString = sortedKeys.map(k => `${rfc3986Encode(k)}=${rfc3986Encode(oauthParams[k])}`).join('&');
        const signatureBase = `GET&${rfc3986Encode(endpoint)}&${rfc3986Encode(paramString)}`;
        const signingKey = `${PESAPAL_SECRET}&`;
        const signature = crypto.createHmac('sha1', signingKey).update(signatureBase).digest('base64');
        const finalQuery = `${paramString}&oauth_signature=${rfc3986Encode(signature)}`;
        const redirectUrl = `${endpoint}?${finalQuery}`;

        return res.json({ ok: true, orderId: created.id, total, redirectUrl, order_tracking_id: orderTrackingId });
      }

      const redirectUrl = `${req.protocol}://${req.get('host')}/pesapal/checkout?tracking=${encodeURIComponent(merchantRef)}&order_id=${created.id}&amount=${total}`;
      return res.json({ ok: true, orderId: created.id, total, redirectUrl });
    } catch (err) {
      console.error('Supabase insert failed:', err.message);
      // fallthrough to in-memory
    }
  }

  // in-memory fallback
  const order = { id: Date.now(), cart, user, address, subtotal, delivery, discount, total, status: 'pesapal_initiated', pesapal_tracking_id: merchantRef };
  orders.push(order);

  // If Pesapal credentials present, return real Pesapal signed URL even in fallback mode
  if (PESAPAL_KEY && PESAPAL_SECRET) {
    const pesapalBase = PESAPAL_ENV === 'live' ? 'https://www.pesapal.com' : 'https://demo.pesapal.com';
    const endpoint = `${pesapalBase}/API/PostPesapalDirectOrderV4`;
    const orderTrackingId = merchantRef;
    const names = (user.name || '').split(' ');
    const firstName = names.shift() || '';
    const lastName = names.join(' ') || '';
    const callbackUrl = process.env.PESAPAL_CALLBACK_URL || (BASE_URL || `${req.protocol}://${req.get('host')}`) + '/pesapal-callback';
    const xml = `<PesapalDirectOrderInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">` +
      `<Amount>${total}</Amount>` +
      `<Description>Order ${order.id}</Description>` +
      `<Type>MERCHANT</Type>` +
      `<Reference>${orderTrackingId}</Reference>` +
      `<FirstName>${firstName}</FirstName>` +
      `<LastName>${lastName}</LastName>` +
      `<EmailAddress>${user.email || ''}</EmailAddress>` +
      `<PhoneNumber>${user.phone || ''}</PhoneNumber>` +
      `<Currency>KES</Currency>` +
      `<CallbackUrl>${callbackUrl}</CallbackUrl>` +
      `</PesapalDirectOrderInfo>`;

    const oauthParams = {
      oauth_consumer_key: PESAPAL_KEY,
      oauth_nonce: Math.random().toString(36).substring(2),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_version: '1.0',
      pesapal_request_data: xml
    };

    const rfc3986Encode = (str) => encodeURIComponent(str).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const sortedKeys = Object.keys(oauthParams).sort();
    const paramString = sortedKeys.map(k => `${rfc3986Encode(k)}=${rfc3986Encode(oauthParams[k])}`).join('&');
    const signatureBase = `GET&${rfc3986Encode(endpoint)}&${rfc3986Encode(paramString)}`;
    const signingKey = `${PESAPAL_SECRET}&`;
    const signature = crypto.createHmac('sha1', signingKey).update(signatureBase).digest('base64');
    const finalQuery = `${paramString}&oauth_signature=${rfc3986Encode(signature)}`;
    const redirectUrl = `${endpoint}?${finalQuery}`;

    return res.json({ ok: true, orderId: order.id, total, redirectUrl, order_tracking_id: orderTrackingId });
  }

  const redirectUrl = `${req.protocol}://${req.get('host')}/pesapal/checkout?tracking=${encodeURIComponent(merchantRef)}&order_id=${order.id}&amount=${total}`;
  return res.json({ ok: true, orderId: order.id, total, redirectUrl });
});

// Simple simulated Pesapal checkout page (development only)
app.get('/pesapal/checkout', (req, res) => {
  const { tracking, order_id, amount } = req.query;
  return res.send(`
    <!doctype html>
    <html><head><meta charset="utf-8"><title>PesaPal - Simulated Checkout</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{font-family:Inter,Arial;display:flex;align-items:center;justify-content:center;height:100vh;background:#f3f4f6;margin:0}.card{background:#fff;padding:24px;border-radius:12px;box-shadow:0 10px 30px rgba(2,6,23,0.08);max-width:600px;width:100%}button{background:#6b21a8;color:#fff;border:none;padding:12px 18px;border-radius:8px;cursor:pointer}</style>
    </head><body>
      <div class="card">
        <h2>PesaPal - simulated checkout</h2>
        <p><strong>Merchant reference:</strong> ${tracking}</p>
        <p><strong>Order id:</strong> ${order_id}</p>
        <p><strong>Amount:</strong> KSh ${amount}</p>
        <p>This page simulates the PesaPal payment gateway. Clicking "Complete payment" will trigger the payment callback and return you to the store.</p>
        <div style="display:flex;gap:8px;margin-top:18px">
          <button id="pay">Complete payment</button>
          <a href="/" style="align-self:center;color:#6b21a8;text-decoration:underline">Cancel</a>
        </div>
        <div id="msg" style="margin-top:12px;color:green;display:none">Processing...</div>
      </div>
      <script>
        document.getElementById('pay').addEventListener('click', async () => {
          document.getElementById('msg').style.display = 'block';
          try {
            await fetch('/pesapal-callback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order_tracking_id: String('${tracking}'), status: 'paid' })
            });
            window.location.href = '/?pesapal=success&order_id=${order_id}';
          } catch (err) {
            document.getElementById('msg').textContent = 'Callback failed: ' + err.message;
          }
        });
      </script>
    </body></html>
  `);
});

// Order lookup (returns order from Supabase when available or in-memory)
app.get('/api/orders/:id', async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'order id required' });

  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(id)}`, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
        }
      });
      const json = await r.json();
      if (Array.isArray(json) && json.length) return res.json(json[0]);
      return res.status(404).json({ error: 'order not found' });
    } catch (err) {
      console.error('Supabase lookup failed:', err.message);
      // fallthrough to in-memory
    }
  }

  const order = orders.find(o => String(o.id) === String(id));
  if (!order) return res.status(404).json({ error: 'order not found' });
  res.json(order);
});

// SPA fallback to serve index.html for unknown routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Ignito mock server running on http://localhost:${port}`));
