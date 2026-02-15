#!/usr/bin/env bash
set -euo pipefail

if [ -z "${SUPABASE_REF-}" ]; then
  echo "ERROR: SUPABASE_REF environment variable is required (project ref)."
  echo "Example: SUPABASE_REF=your-project-ref ./deploy-functions.sh"
  exit 1
fi

echo "Deploying Supabase Edge Functions to project: $SUPABASE_REF"
for fn in mpesa-stk-push pesapal-create-order pesapal-callback mpesa-callback; do
  echo "- deploying $fn"
  supabase functions deploy "$fn" --project-ref "$SUPABASE_REF"
done

echo "All functions deployed."
