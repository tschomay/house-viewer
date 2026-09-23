Here's the full walkthrough — written up in `roastlog-coffee-dns-setup.md` (includes a troubleshooting table and the "let Vercel run DNS" alternative). The short version:

**First, a heads-up:** I looked at your Vercel account (`tschomay`, Hobby) and there's no project called `roastlog-web` — you have `sound-games`, `auralux`, `tschomay-site-preview`, and `harness-playground`. So it's either on a different Vercel login or not created yet. Worth confirming before you start.

**0. Check your nameservers.** Namecheap → Domain List → Manage → **Domain** tab. The NAMESERVERS dropdown must say **Namecheap BasicDNS**. If it says Custom DNS, the Advanced DNS tab is inert and nothing below will work.

**1. Add the domain in Vercel first** (so you can copy its exact values instead of guessing). Project → Settings → Domains → add `roastlog.coffee`. Vercel offers a choice of which is canonical — I'd pick apex primary with `www` redirecting to it. Either option registers *both* hostnames. Both will show "Invalid Configuration" and display the DNS records it wants. Keep that tab open.

**2. Copy the two values.** Typically an A record `@` → `216.198.79.1` and a CNAME `www` → `cname.vercel-dns.com`. But older projects get `76.76.21.21` and newer ones get a project-specific `xxxxx.vercel-dns-0NN.com` — **use what's on your screen**, not what's in any guide.

**3. Namecheap → Advanced DNS → delete the parking records.** A fresh domain ships with `CNAME www → parkingpage.namecheap.com` and `URL Redirect @ → http://www.roastlog.coffee/`. Delete both. That URL Redirect on `@` is the #1 reason apex domains stay broken. Leave MX/TXT alone if you have email there.

**4. Add the two records:**
- A Record | Host `@` | the Vercel IP | TTL Automatic
- CNAME Record | Host `www` | the Vercel CNAME target | TTL Automatic

Host is literally `@` and `www` — not the full domain. Click the green ✓ on each row, then SAVE ALL CHANGES.

**5. Wait 5–30 min**, hit Refresh in Vercel's Domains page. Both flip to green, then Vercel auto-issues the Let's Encrypt cert a minute or two later. Verify with `dig roastlog.coffee +short` and `curl -sSI https://www.roastlog.coffee | head -n 1` (should be a 308 to the apex).

Common failure modes, in order of likelihood: nameservers not on BasicDNS, the parking URL-redirect record left in place, or the A record's Host typed as `roastlog.coffee` instead of `@`. If DNS resolves but the cert never issues, check for a CAA record that excludes `letsencrypt.org`.

Ping me if Vercel is still showing Invalid Configuration after half an hour and I'll help you read what actually propagated.
