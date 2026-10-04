<<<<<<< ours
# miki_dev
Hack4freedom miki project
=======
# miki-payment

Payment processing for Bitcoin Miki.

Rust (Axum + SQLx/MariaDB) backend that creates orders and real Bitcoin
Lightning invoices through **BTCPay Server**. The customer pays on the
BTCPay checkout page; payment confirmation arrives later via BTCPay
webhooks (next phase).

## BTCPay configuration

The invoice-creation endpoint requires three environment variables
(see `.env.example`; never commit real values):

| Variable | Meaning |
|---|---|
| `BTCPAY_URL` | Base URL of the BTCPay Server instance, e.g. `https://btcpay.example.com` |
| `BTCPAY_STORE_ID` | Store to create invoices in |
| `BTCPAY_API_KEY` | API key with the `btcpay.store.cancreateinvoice` permission |

If any variable is missing the server still boots, and invoice creation
answers `503 bitcoin payments are not configured`. API keys, store IDs
and authorization headers are never logged and never returned by the API.

### Currency note

The order amount is stored as BIGINT minor units and passed to BTCPay in
the order's own currency (e.g. `1000 KES` → `amount: "10.00"`,
`currency: "KES"`). The application performs **no currency conversion
and holds no exchange rates**. The configured BTCPay store must be able
to price the order currency with its rate source — if it cannot, the API
responds `502` with `payment provider does not support invoice currency
KES`. Supported minor-unit currencies are an explicit allow-list in
`src/services/invoice.rs` (`KES`, `USD`, `EUR`, `GBP`, `JPY`, `BTC`).

## Invoice creation

```
POST /api/v1/orders/{order_id}/invoice
```

No request body. The amount and currency always come from the stored
order — clients cannot influence them.

**Success `201`** (new invoice created) / **`200`** (existing active
invoice reused):

```json
{
  "order_id": 1,
  "order_number": "ORD-01be8d6b0ed64dc5be9acd937dfb7e91",
  "invoice_id": 4,
  "invoice_number": "INV-2f0a...",
  "status": "pending",
  "payment_url": "https://btcpay.example.com/i/AbCdEf",
  "expires_at": "2026-09-30T14:05:00",
  "reused": false
}
```

`payment_url` is the BTCPay checkout page where the customer pays
(Lightning included, per store payment-method settings). Creating an
invoice only creates a payment request: the local invoice stays
`pending`, `paid_at` stays `NULL`, and the order status does not change.
Payment is confirmed only by verified BTCPay webhooks (later phase).

Errors: `404` order not found · `409` already paid / cancelled /
creation in progress · `400` unsupported currency · `502` BTCPay
rejected the request · `503` BTCPay unreachable or not configured.

## How the Rust application talks to BTCPay

- `src/btcpay.rs` — Greenfield API client (reqwest, one shared
  connection pool built at startup).
  `POST {BTCPAY_URL}/api/v1/stores/{BTCPAY_STORE_ID}/invoices` with
  header `Authorization: token {BTCPAY_API_KEY}`, JSON body
  `{ "amount": "10.00", "currency": "KES", "metadata": { "orderId": "ORD-…" } }`.
- `src/services/invoice.rs` — workflow: short DB transaction (lock order,
  check for duplicates, insert unpaid placeholder) → BTCPay HTTP call
  *outside* any transaction → short DB transaction (claim placeholder on
  success, delete it on failure). The placeholder row prevents duplicate
  active invoices between concurrent requests.
- `src/routes/orders.rs` — thin handler; no business logic, no request
  body.
- `invoices.btcpay_invoice_id` links each local invoice to its BTCPay
  invoice, which is how future webhooks will identify the order.

Endpoint paths, field names and the auth scheme follow the official
BTCPay Greenfield OpenAPI contract.
>>>>>>> theirs
