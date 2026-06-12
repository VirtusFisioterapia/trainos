name: Resoconto Settimanale VIRTUS

on:
  schedule:
    - cron: '0 7 * * 0'
  workflow_dispatch:

jobs:
  invia-resoconto:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install resend
      - run: node .github/scripts/resoconto.js
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
