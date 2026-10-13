# Gateway Restaurant: website + backend

One small program that is both the website and the backend. It needs **no npm packages**, only **Node.js 22.13 or newer**.

## What it does
- Customers open the website, choose a restaurant, fill a cart, pay by bank transfer and upload the receipt, then place the order. They get an order code and can track it.
- Restaurants log in at the **Vendor** tab with their own password. They see new orders, open the receipt, accept, mark ready, mark delivered, change the menu and prices, and open or close the restaurant.
- You (the owner) use **/admin** to add restaurants, reset passwords and set delivery fees. The general fee list applies everywhere. Under each restaurant, **Delivery fees** lets you set a different fee for each customer area (an empty box uses the general fee).
- The server works out all prices itself, so nobody can change a price from their phone.

## Try it on your own computer
1. Install Node.js 22.13+ from nodejs.org.
2. Open a terminal in this folder and run:
   - Mac/Linux: `ADMIN_KEY=choose-a-long-secret npm run seed && ADMIN_KEY=choose-a-long-secret npm start`
   - Windows (PowerShell): `$env:ADMIN_KEY="choose-a-long-secret"; npm run seed; npm start`
3. Open http://localhost:3000. The seed step adds SAMPLE restaurants and prints their logins (also saved in `data/sample-logins.txt`).
4. Open http://localhost:3000/admin and enter your ADMIN_KEY.

## Put it online (so customers can use it)
You need a host that runs Node 22.13+ **and keeps a persistent disk or volume** (your orders and receipts live there). Many app hosts work: you upload this folder (or connect it from GitHub), set these settings, and they give you an https link.

| Setting | Value |
|---|---|
| Start command | `npm start` (or use the included `Dockerfile`) |
| `ADMIN_KEY` | A long secret only you know (at least 8 characters). Without it, /admin is switched off. |
| `DATA_DIR` | The folder where the host mounts the persistent disk, for example `/data` |
| `PORT` | Usually set by the host. Leave it alone. |

Important: a host with no persistent disk will lose all orders and receipts every time it restarts.

After it is running:
1. Open `https://your-link/admin`, enter the ADMIN_KEY.
2. Add each real restaurant (name, area, bank details, a password for them). Give each restaurant its password privately.
3. Set your delivery areas and fees.
4. If you ran the sample seed, delete the sample restaurants in /admin.
5. Each restaurant logs in at the Vendor tab, adds their menu, and shares their own link (shown on their dashboard).

## Backups
Everything is in the `DATA_DIR` folder (`gateway.db` plus the `receipts` folder). Copy that folder regularly.

## Good to know
- **Check the bank app before accepting.** Receipt screenshots can be faked. The restaurant should confirm the money arrived in their account, then tap Accept.
- Order and login attempts are rate-limited. Receipt images are only shown to the restaurant that owns the order.
- Not included yet: SMS or WhatsApp alerts for new orders (the vendor dashboard checks for new orders every few seconds while open), online card payment (Paystack or Flutterwave), food photos, rider tracking.

## Deploy on Render (Blueprint)
1. Put this folder in a GitHub repository.
2. In Render: New, then Blueprint, choose the repository. Render reads `render.yaml`, creates the service and a 1 GB permanent disk, and asks you to type your `ADMIN_KEY`.
3. When it is live, open `https://your-service.onrender.com/admin`.
