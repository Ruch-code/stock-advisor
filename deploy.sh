#!/bin/bash
# StockPulse auto-deploy: push to GitHub + publish to Netlify
set -e

cd "$(dirname "$0")"

if [ -n "$1" ]; then
  git add -A
  git commit -m "$1" || true
  git push origin main
fi

echo "Deploying to Netlify..."
netlify deploy --prod --dir=. --site voluble-pika-444e68

echo ""
echo "✔ Code pushed to GitHub: https://github.com/Ruch-code/stock-advisor"
echo "✔ Live site refreshed:   https://voluble-pika-444e68.netlify.app"