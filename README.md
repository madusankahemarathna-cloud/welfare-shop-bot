# SLAF Station Sigiriya • Welfare Shop WhatsApp Automation Service

A free, lightweight, cloud-synced WhatsApp automation microservice powered by Baileys for the SLAF Station Sigiriya Welfare Shop.

## Features
- **Dedicated Dual-Tenant Isolation**: Operates exclusively with `welfare_stock_batches`, `welfare_items_master`, `welfare_settings`.
- **Daily Automated Expiry Audit**: Runs at 08:00 AM (Asia/Colombo) to scan items approaching expiry.
- **One-by-One Sequential Queue**: Dispatches alert item by item, awaiting officer review (`YES` to keep, `NO` to remove).
- **Interactive Two-Way Stock Management**: Automatically removes expired items from store stock upon officer `NO` reply.
- **Strict Silent Protection**: Silently ignores non-YES/NO accidental words to avoid clutter or unintended actions.
- **Web Dashboards**:
  - `/` — Live service health & status dashboard
  - `/qr` — Interactive WhatsApp Web QR Code Pairing screen
  - `/inspection` — Visual inspection dashboard of all store batches and remaining shelf life

## Deployment on Render
1. Create a new GitHub repository named `welfare-shop-bot`.
2. Push this directory to the repository.
3. In Render.com, create a new **Web Service** pointing to this repository.
4. Set Build Command: `npm install`
5. Set Start Command: `node server.js`
6. Add Environment Variable:
   - `FIREBASE_SERVICE_ACCOUNT`: `<JSON contents of serviceAccountKey.json>`
7. Deploy!
