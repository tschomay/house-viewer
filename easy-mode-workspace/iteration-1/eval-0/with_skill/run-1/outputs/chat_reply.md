Made you a tap-to-copy checklist you can work through on the phone — **Roastlog Webhook Runbook** (link above). Every value is a copy button, the links go straight to the right Stripe page, and it remembers which steps you've ticked if you get interrupted.

The short version: in **test mode**, add an event destination pointing at `https://api.roastlog.dev/webhooks/stripe`, select your two events, copy the `whsec_…` signing secret into `STRIPE_WEBHOOK_SECRET` on your host, and **redeploy** — most hosts won't pick up a new env var without one. Then do the whole thing again in **live mode**, which issues a *different* secret.

Two things on the page worth knowing before you start:

- `invoice.payment_failed` only fires for invoices and subscriptions. If Roastlog takes one-off Checkout payments, that handler will never run — you'd want `checkout.session.async_payment_failed` / `payment_intent.payment_failed` instead.
- If deliveries come back 400 with *"No signatures found matching the expected signature"*, it's almost never your verification code — it's the wrong mode's secret, a line break in the paste, or a JSON body parser running before verification and destroying the raw bytes Stripe signed.

The runbook has a "when it breaks" section covering those plus redirects, timeouts, and duplicate events. Ping me with whatever the delivery log says and I'll update the page.
