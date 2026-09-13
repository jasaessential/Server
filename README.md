# JASA V2 — Payment Server

Node.js / Express backend that handles Razorpay payment creation and verification,
then writes the payment result into Firebase Firestore.

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Payment | Razorpay |
| Database | Firebase Firestore (Admin SDK) |
| Hosting | Cloudflare Workers (via `nodejs_compat`) |

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/payment/key` | Returns Razorpay `key_id` |
| `POST` | `/api/payment/create-order` | Creates Razorpay order + writes pending payment to Firestore |
| `POST` | `/api/payment/verify` | Verifies Razorpay signature + marks order as paid in Firestore |
| `POST` | `/api/payment/webhook` | Razorpay webhook receiver (backup event sink) |

---

## Local Setup

```bash
cd server
npm install
cp .env.example .env   # fill in your real values
npm run dev            # starts on http://localhost:3001
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3001) |
| `ALLOWED_ORIGINS` | Comma-separated allowed CORS origins |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_PRIVATE_KEY_ID` | Service account private key ID |
| `FIREBASE_PRIVATE_KEY` | Service account private key (keep `\n` escapes) |
| `FIREBASE_CLIENT_EMAIL` | Service account client email |
| `FIREBASE_CLIENT_ID` | Service account client ID |
| `RAZORPAY_KEY_ID` | Razorpay API key ID |
| `RAZORPAY_KEY_SECRET` | Razorpay API key secret |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay webhook signing secret |
| `SERVER_SECRET` | Internal secret shared between frontend and backend |

---

## Firestore Collections Written

### `payments/{razorpayOrderId}`
Created on `create-order`, updated on `verify` / webhook.

```
razorpayOrderId    string
razorpayPaymentId  string   (after verify)
groupOrderId       string   (JASA-XXXXXX)
firestoreOrderIds  string[] (Firestore order doc IDs)
userId             string
amountINR          number
amountPaise        number
currency           "INR"
status             "created" | "paid" | "failed"
method             string   (upi, card, netbanking…)
paidAt             timestamp
createdAt          timestamp
updatedAt          timestamp
```

### `orders/{id}` — fields added/updated
```
razorpayOrderId    string
razorpayPaymentId  string   (after verify)
paymentMethod      "razorpay"
paymentStatus      "pending" | "paid" | "failed"
paidAt             timestamp
```

---

## Deploying to Cloudflare Workers

```bash
cd server
npm install -g wrangler      # if not installed
npx wrangler login

# Set all secrets (run each line and paste the value when prompted)
npx wrangler secret put FIREBASE_PROJECT_ID
npx wrangler secret put FIREBASE_PRIVATE_KEY_ID
npx wrangler secret put FIREBASE_PRIVATE_KEY
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_CLIENT_ID
npx wrangler secret put RAZORPAY_KEY_ID
npx wrangler secret put RAZORPAY_KEY_SECRET
npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
npx wrangler secret put SERVER_SECRET
npx wrangler secret put ALLOWED_ORIGINS

# Deploy
npx wrangler deploy
```

After deploying, copy the worker URL (e.g. `https://jasa-payment-server.your-subdomain.workers.dev`)
and update `SERVER_URL` in the frontend `env-config.js`.

---

## Razorpay Dashboard Setup

1. Log in to [dashboard.razorpay.com](https://dashboard.razorpay.com)
2. **Settings → API Keys** — generate a key pair, paste into `.env`
3. **Settings → Webhooks** — add webhook URL:
   `https://jasa-payment-server.<subdomain>.workers.dev/api/payment/webhook`
   - Enable events: `payment.captured`, `payment.failed`
   - Set a webhook secret, paste into `RAZORPAY_WEBHOOK_SECRET`

---

## Payment Flow (Frontend → Backend → Firestore)

```
User clicks "Pay & Place Order"
  │
  ├─ cart.js: writes orders to Firestore (status: Pending, paymentStatus: pending)
  │
  ├─ POST /api/payment/create-order
  │     └─ Creates Razorpay order
  │     └─ Writes payments/{rzpOrderId} to Firestore (status: created)
  │     └─ Stamps orders with razorpayOrderId
  │
  ├─ Razorpay modal opens in browser
  │
  ├─ User completes payment
  │
  ├─ POST /api/payment/verify
  │     └─ Verifies HMAC-SHA256 signature
  │     └─ Updates payments/{rzpOrderId} → status: paid
  │     └─ Updates orders → paymentStatus: paid
  │     └─ Updates order_status → paymentStatus: paid
  │
  └─ cart.js: clears cart, redirects to orders.html
```
