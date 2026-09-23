# Point roastlog.coffee (Namecheap) at the `roastlog-web` Vercel project

Goal: `https://roastlog.coffee` and `https://www.roastlog.coffee` both serve the Vercel
deployment, with one canonically redirecting to the other, and valid HTTPS on both.

Total hands-on time: ~10 minutes. Then 5-30 minutes of waiting for DNS.

---

## Step 0 — Check where your DNS is actually hosted

This is the step people skip and then debug for an hour.

1. Namecheap -> **Domain List** -> **Manage** next to `roastlog.coffee`
2. Stay on the **Domain** tab, look at the **NAMESERVERS** dropdown.
3. It must say **Namecheap BasicDNS** (or **Namecheap Web Hosting DNS**).

- If it says **Custom DNS**, your DNS is hosted somewhere else entirely and the
  Advanced DNS tab does nothing. Either switch it back to Namecheap BasicDNS, or
  add the records at whoever those nameservers belong to.
- If it says **Premium DNS**, records are managed under the PremiumDNS tab instead.
  Same record values, different screen.

---

## Step 1 — Add both domains to the Vercel project first

Do Vercel before Namecheap, so you can copy Vercel's exact values instead of guessing.

1. Go to <https://vercel.com/dashboard> -> project **roastlog-web** -> **Settings** -> **Domains**
2. In the input box type `roastlog.coffee` and click **Add**.
3. Vercel will offer a set of options. Pick the one you want:
   - **`roastlog.coffee` with `www.roastlog.coffee` redirecting to it** — apex is canonical (my default recommendation; shorter, and what most people type)
   - **`www.roastlog.coffee` with `roastlog.coffee` redirecting to it** — www is canonical (slightly better if you ever want cookie isolation or a CDN in front)

   Either way you end up with **both** hostnames registered on the project — one serving,
   one issuing a 308 redirect. That is what you want. You can flip the direction later.
4. Both entries will now show **Invalid Configuration** with a yellow/red marker, and
   Vercel will display the exact DNS records it wants. **Leave this tab open** — you are
   about to copy from it.

> Heads-up: I checked your Vercel account (`tschomay`, Hobby plan) and I don't see a
> project named `roastlog-web` — only `sound-games`, `auralux`, `tschomay-site-preview`,
> and `harness-playground`. So either the project lives under a different Vercel
> account/login, or it hasn't been created yet. Worth confirming before Step 1.

---

## Step 2 — Read the two values Vercel gives you

Vercel will show something like:

| Purpose | Type  | Name  | Value                                    |
|---------|-------|-------|------------------------------------------|
| apex    | A     | `@`   | `216.198.79.1`                            |
| www     | CNAME | `www` | `cname.vercel-dns.com` (or a project-specific `xxxxx.vercel-dns-0NN.com`) |

**Use the values on your screen, not the ones in this table.** Vercel has rotated these
over time — older projects get `76.76.21.21` for the A record and plain
`cname.vercel-dns.com` for the CNAME; newer ones get `216.198.79.1` and a per-project
CNAME target. All of them work; only the one Vercel shows you is guaranteed to.

---

## Step 3 — Namecheap: clear the default parking records

1. Namecheap -> **Domain List** -> **Manage** -> **Advanced DNS** tab
2. Look at the **HOST RECORDS** table. A fresh Namecheap domain almost always has:
   - `CNAME Record` | Host `www` | Value `parkingpage.namecheap.com.`
   - `URL Redirect Record` | Host `@` | Value `http://www.roastlog.coffee/`
3. **Delete both** (trash icon on the right of each row). They will fight your new
   records — in particular the URL Redirect on `@` blocks the apex A record from
   working at all.
4. Leave any **MX** or **TXT** records alone if you have email on this domain.

---

## Step 4 — Namecheap: add the two records

Click **ADD NEW RECORD** twice.

**Record 1 — apex**

- Type: **A Record**
- Host: `@`  ← literally the at-sign, not `roastlog.coffee`
- Value: the IP from Vercel (e.g. `216.198.79.1`)
- TTL: **Automatic** (or `5 min` if you want faster iteration while testing)

**Record 2 — www**

- Type: **CNAME Record**
- Host: `www`  ← just `www`, not `www.roastlog.coffee`
- Value: the CNAME target from Vercel (e.g. `cname.vercel-dns.com`)
- TTL: **Automatic**

Then click the green **✓** on each row, and **SAVE ALL CHANGES** at the top of the table.

Notes:
- Namecheap adds the trailing dot to CNAME values itself. Don't stress about it.
- Never put `http://` or a path in the Value field of a CNAME.
- If Namecheap rejects the CNAME saying a conflicting record exists on `www`, you missed
  deleting the parking CNAME in Step 3.
- You do **not** need a second A record for `www`, and you do **not** need an ALIAS record.
  (Namecheap does support ALIAS at `@` — only reach for it if Vercel gives you a
  CNAME-only target for the apex, which is unusual.)

---

## Step 5 — Verify

1. Wait ~5 minutes. Namecheap's own guidance is up to 30 minutes for BasicDNS changes.
2. Back in Vercel -> Settings -> Domains, click **Refresh** on each domain.
   Both should flip to **Valid Configuration** with a green check.
3. Vercel then auto-issues a Let's Encrypt certificate for both hostnames. That takes
   another minute or two after validation. Until it lands you may briefly see a cert
   warning — that's expected, not a misconfiguration.
4. Sanity checks from your machine:

```bash
dig roastlog.coffee +short          # -> the Vercel IP
dig www.roastlog.coffee +short      # -> the vercel-dns CNAME, then an IP
curl -sSI https://roastlog.coffee | head -n 1
curl -sSI https://www.roastlog.coffee | head -n 1   # -> 308 if www is the redirect side
```

   Or paste the domain into <https://dnschecker.org> to watch propagation worldwide.

---

## If it doesn't work

| Symptom | Cause | Fix |
|---|---|---|
| Vercel still says Invalid after 30+ min | Nameservers aren't Namecheap BasicDNS | Step 0 |
| Apex loads a Namecheap parking page | URL Redirect record on `@` still present | Step 3 |
| `www` works, apex doesn't | A record Host was typed as `roastlog.coffee` instead of `@` | Re-edit the record |
| Both resolve but cert never issues | A `CAA` record exists that excludes Let's Encrypt | Add `0 issue "letsencrypt.org"` as a CAA record, or delete the restrictive one |
| Redirect goes the wrong direction | Wrong primary chosen | Vercel -> Domains -> `…` menu on the domain -> **Edit** / set redirect target |
| Old site keeps showing up | Browser/OS DNS cache | Hard refresh, try a different network, or `sudo dscacheutil -flushcache` (macOS) |

---

## Alternative: let Vercel run DNS entirely (optional)

If you'd rather not hand-manage records, you can instead set Namecheap's nameservers to
**Custom DNS** with:

```
ns1.vercel-dns.com
ns2.vercel-dns.com
```

Vercel then handles apex + www automatically. Trade-off: **all** DNS for the domain moves
to Vercel, so any email (MX), verification TXT records, or other subdomains have to be
re-created there. For a single web project the two-record approach above is simpler and
less disruptive. Pick one — do not do both.
