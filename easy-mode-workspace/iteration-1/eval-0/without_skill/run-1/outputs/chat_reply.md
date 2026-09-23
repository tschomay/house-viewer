Sure — the dashboard side is quick. Do it in **test mode first**, then repeat the same steps in live mode. Here's the phone-friendly path.

**Values you'll need to paste:**

Endpoint URL:
```
https://api.roastlog.dev/webhooks/stripe
```
Events:
```
checkout.session.completed
invoice.payment_failed
```

---

**1. Open the webhooks page (test mode)**
Tap: https://dashboard.stripe.com/test/webhooks
That link puts you straight into test mode, so you don't have to hunt for the Test/Live toggle. (In the newer UI this lives under Developers → Webhooks, or Workbench → Webhooks.)

**2. Add the endpoint**
Tap **Add endpoint** (may say *Add destination*). If it asks for a destination type, pick **Webhook endpoint** (not Amazon EventBridge), and for events source pick **Your account**.

**3. Paste the URL**
Endpoint URL: `https://api.roastlog.dev/webhooks/stripe`
Description is optional — something like "roastlog api" helps later.

**4. Select the two events**
Tap **Select events**, search for each one and check it:
- `checkout.session.completed`
- `invoice.payment_failed`

Don't tick "receive all events" — you'll drown in traffic you don't handle.

**5. Create it**
Tap **Add endpoint**. You'll land on the endpoint's detail page.

**6. Copy the signing secret**
On that page, find **Signing secret** → **Reveal**. It starts with `whsec_`. Copy it.

**7. Put the secret in your app's env**
Add it wherever your API's env vars live (Vercel/Fly/Railway/etc.):
```
STRIPE_WEBHOOK_SECRET=whsec_...
```
Then redeploy. Your handler must verify with it, using the **raw request body** (not the parsed JSON) — e.g. `stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)`. If your framework auto-parses JSON, disable that for this route or the signature check will always fail. That's the #1 thing that breaks here.

**8. Test it**
On the endpoint page tap **Send test webhook**, choose `checkout.session.completed`, send. Then check the event under the endpoint's event list — you want a **200**. If you get 400, it's almost certainly the raw-body/signature issue above. If 404, the route path or trailing slash is off.

**9. Go live**
Repeat steps 1-7 at https://dashboard.stripe.com/webhooks (live mode). It's a **separate endpoint with a different signing secret** — test secrets don't work in live mode. Your account also needs to be activated before live mode accepts anything.

---

**Couple of gotchas worth knowing:**
- Return a 2xx fast (under ~10s), then do slow work async — Stripe treats a timeout as a failure and retries.
- Stripe retries for up to ~3 days with backoff, and can deliver the same event twice. Key off `event.id` (or the session/invoice id) and make your handler idempotent.
- `checkout.session.completed` doesn't always mean money arrived — for delayed methods, check `session.payment_status == "paid"` and consider also handling `checkout.session.async_payment_succeeded` / `...failed`.
- If you ever want to replay a real event, the event page has a **Resend** option — handy for debugging without making new test payments.
