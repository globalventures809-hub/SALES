# ignito — backend scaffolding (Supabase Edge Functions + mock server)

What I added
- `functions/` — Supabase Edge Functions for `mpesa-stk-push`, `pesapal-create-order`, `pesapal-callback`, `mpesa-callback` (Deno/TypeScript). These now perform real gateway calls (M-Pesa STK and PesaPal signing) and update Supabase `orders` via REST using `SUPABASE_SERVICE_ROLE`.
- `server.js`, `package.json`, `Dockerfile` — a local mock Express server to run the same endpoints for local development or containerized testing.
- `ignito/.env.example` — env keys required by the functions and mock server.

Endpoints (mock / edge function names)
- POST /mpesa-stk-push       -> initiate STK push (calls Safaricom API, updates order payment_status -> `pending`)
- POST /pesapal-create-order -> create pesapal order (builds OAuth-signed URL & returns `redirect_url`)
- POST /pesapal-callback     -> pesapal webhook -> update order payment_status
- POST /mpesa-callback       -> mpesa webhook -> update order payment_status

Required environment variables (set in Supabase or server)
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE  (server-side only)
- PESAPAL_KEY
- PESAPAL_SECRET
- PESAPAL_ENVIRONMENT (TEST | LIVE)
- PESAPAL_CALLBACK_IPS (comma-separated)
- MPESA_ENVIRONMENT (sandbox | production)
- MPESA_CONSUMER_KEY
- MPESA_CONSUMER_SECRET
- MPESA_SHORTCODE
- MPESA_PASSKEY
- MPESA_CALLBACK_URL (optional)
- MPESA_CALLBACK_IPS (comma-separated)
- TRUSTED_IPS (comma-separated)
- BASE_URL

Deploy notes
- Run the local mock server:
  cd ignito && npm install && npm start
- Deploy Supabase Edge Functions (supabase CLI required):
  # set SUPABASE_REF to your project ref
  SUPABASE_REF=your-ref npm --prefix ignito run deploy:functions
  or
  SUPABASE_REF=your-ref ./ignito/deploy-functions.sh

CI / GitHub Actions
- A workflow is included at `.github/workflows/deploy-ignito-functions.yml` that automatically deploys Edge Functions when changes are pushed to `main` under `ignito/functions/`.
- Required repository secrets:
  - `SUPABASE_REF` (your project ref)
  - `SUPABASE_ACCESS_TOKEN` (Supabase CLI access token)

Security notes
- Never expose `SUPABASE_SERVICE_ROLE` or payment secrets in client-side code.
- Rotate any keys that were publicly exposed.
