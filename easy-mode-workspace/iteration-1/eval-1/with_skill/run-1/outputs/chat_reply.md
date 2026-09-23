Made you a tap-through checklist for it: **Roastlog DNS Cutover** — 8 steps, every value one tap to copy, deep links into the exact Namecheap and Vercel pages, and it remembers where you got to if you put the phone down.

**One thing to sort out before you start.** I looked at your Vercel account (`tschomay`, Hobby) and there's no project called `roastlog-web` in it — you have *sound-games*, *auralux*, *tschomay-site-preview* and *harness-playground*. So it's either under a different Vercel login or not created yet. Every link on the page assumes the `tschomay` account, so swap the account name in the URLs if it turns out to live elsewhere.

The short version, if you just want to move: add both `roastlog.coffee` and `www.roastlog.coffee` in the project's Domains settings, then in Namecheap's Advanced DNS **delete the two records it ships with** (the `www` CNAME to parkingpage.namecheap.com, and the URL Redirect on `@`) and add an A record `@` → the IP Vercel shows you, plus a CNAME `www` → `cname.vercel-dns.com`.

Two things the page warns about in place, because they're the ones that actually cost people an afternoon:

- Deleting the URL Redirect on `@` is not optional — it silently overrides your A record, so the apex keeps serving the parking page while the DNS table looks perfect.
- Check the Nameservers dropdown says **Namecheap BasicDNS** first. If it's set to Custom DNS, Advanced DNS still accepts and saves records that are never served, with no error anywhere.

The apex IP is the one value I couldn't pre-fill — Vercel hands out different ones (`216.198.79.1` currently, `76.76.21.21` on older projects). Read it off your Domains page; both are in copy blocks on step 3 so you're not typing digits on a phone keyboard.

Ping me when Vercel goes green, or if it doesn't — I'll update the page rather than just answering here.
