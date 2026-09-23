# Rotating the `github-actions-deployer` access key with zero pipeline downtime

**What makes this safe:** an IAM user can hold **two** access keys at once. You create the
second key, cut GitHub over to it, prove it works, and only then retire the first. At no
point is the user without a working key, so in-flight and queued workflow runs keep
working.

**What actually breaks rotations** (in rough order of how often it bites):

1. Deleting the old key before you know what else was using it.
2. The workflow reading the secret from a *different scope* than the one you updated
   (environment-scoped and org-scoped secrets shadow/are shadowed by repo secrets).
3. The IAM user already having 2 keys, so you can't create a third.
4. A nightly/weekly scheduled job that only exercises the credential days later.

---

## 0. Pre-flight (do this before touching anything)

**Permissions you need**

- AWS: `iam:ListAccessKeys`, `iam:CreateAccessKey`, `iam:UpdateAccessKey`,
  `iam:DeleteAccessKey`, `iam:GetAccessKeyLastUsed` on `github-actions-deployer`.
- GitHub: admin on the repo (to write repo secrets), plus org owner if the secret turns
  out to be org-level.

**Check the key slot is free.** This is the one thing that can stop the whole plan:

```bash
aws iam list-access-keys --user-name github-actions-deployer
```

- **One key listed** → good, proceed.
- **Two keys listed** → you cannot create a third. Identify the stale one
  (`CreateDate` + last-used below), set it `Inactive`, wait for anything that
  screams, then delete it to free the slot.

```bash
aws iam get-access-key-last-used --access-key-id AKIA_OLD_KEY_ID
```

`LastUsedDate`, `ServiceName`, and `Region` tell you whether the key is still live and
roughly what it's doing. A key last used from a service or region your pipeline doesn't
touch is a strong hint there's a second consumer somewhere.

**Find every consumer of this key.** Rotation "breaks the pipeline" most often because
the key was quietly reused elsewhere. Check:

- Other repos and org-level secrets in your GitHub org (search the org for
  `AWS_ACCESS_KEY_ID` in workflow files).
- **Secret scope in the deploying repo** — GitHub resolves in this order:
  environment secret → repo secret → org secret. If the job has
  `environment: production` and that environment defines its own `AWS_ACCESS_KEY_ID`,
  updating the *repo* secret changes nothing and the pipeline will keep using the old
  key (and then break when you delete it).

  ```bash
  gh secret list --repo OWNER/REPO
  gh secret list --repo OWNER/REPO --env production
  gh secret list --org  YOUR_ORG
  ```

- Terraform/Terragrunt state, CI systems other than Actions, a teammate's `~/.aws/credentials`,
  third-party SaaS (Datadog, Vercel, Netlify, a backup job) configured with the same key.
- Authoritative sweep — CloudTrail knows who actually used it:

  ```bash
  aws cloudtrail lookup-events \
    --lookup-attributes AttributeKey=AccessKeyId,AttributeValue=AKIA_OLD_KEY_ID \
    --start-time "$(date -u -d '90 days ago' +%Y-%m-%dT%H:%M:%SZ)" \
    --max-results 50 \
    --query 'Events[].{time:EventTime,name:EventName,src:Username}' --output table
  ```

  (CloudTrail's `lookup-events` only covers the last 90 days; if you have a CloudTrail
  Lake / Athena table, query that instead for the full history.)

**Save the current secret value if you want a rollback path.** GitHub secrets are
write-only — you *cannot* read `AWS_SECRET_ACCESS_KEY` back out of GitHub. If nobody has
the old secret in a password manager, your only recovery path is forward (make another
new key), not backward. Decide which you're comfortable with before you start.

---

## 1. Create the second key

```bash
aws iam create-access-key --user-name github-actions-deployer
```

The `SecretAccessKey` in the response is shown **once and never again**. Copy it straight
into your password manager now.

Sanity-check the new key works before it goes anywhere near CI:

```bash
AWS_ACCESS_KEY_ID=AKIA_NEW_KEY_ID \
AWS_SECRET_ACCESS_KEY=NEW_SECRET \
aws sts get-caller-identity
```

Expect `arn:aws:iam::<account>:user/github-actions-deployer`. IAM is eventually
consistent — if you get `InvalidClientTokenId` in the first ~10 seconds, retry before
assuming anything is wrong.

---

## 2. Update the GitHub secrets

Both keys are valid right now, so the only real hazard is a *torn read*: a job that
starts between the two `gh secret set` calls and picks up the new ID with the old secret.
That window is seconds; close it properly:

1. Confirm nothing is running or queued:
   ```bash
   gh run list --repo OWNER/REPO --status in_progress
   gh run list --repo OWNER/REPO --status queued
   ```
2. Set both, back to back, **in the scope you identified in step 0**:
   ```bash
   gh secret set AWS_ACCESS_KEY_ID     --repo OWNER/REPO --body 'AKIA_NEW_KEY_ID'
   gh secret set AWS_SECRET_ACCESS_KEY --repo OWNER/REPO --body 'NEW_SECRET'
   ```
   Add `--env production` or `--org YOUR_ORG --visibility selected` if that's where the
   live values are. If the key lives in more than one place, update **all** of them in
   this same window.

Note on in-flight runs: a job resolves secrets when the *job* starts, not when the run
starts. A multi-job workflow spanning the update can therefore see old values in one job
and new in another — which is harmless here, because both keys work. It stops being
harmless the moment you delete the old key, which is why step 4 waits.

Avoid using the web UI for this if you can — pasting a secret by hand into two fields is
where transposition typos come from. If you must, paste, don't retype.

---

## 3. Verify on a real run

Don't declare victory on the secret update. Force an actual authenticated deploy:

```bash
gh workflow run deploy.yml --repo OWNER/REPO   # or open a throwaway PR if that's the trigger
gh run watch --repo OWNER/REPO
```

What "verified" means: a step that genuinely calls AWS succeeded (an S3 sync, an ECS
update, a CloudFormation deploy). `configure-aws-credentials` succeeding on its own is
weak evidence — with `sts` verification disabled it can pass without the key ever being
exercised.

Then confirm from the AWS side that the **new** key is the one being used:

```bash
aws iam get-access-key-last-used --access-key-id AKIA_NEW_KEY_ID
```

`LastUsedDate` should be minutes old.

---

## 4. Deactivate the old key (don't delete yet)

Deactivate is the reversible step. It's your real test of whether anything unknown still
depends on the old key, and it's undone in one command.

```bash
aws iam update-access-key \
  --user-name github-actions-deployer \
  --access-key-id AKIA_OLD_KEY_ID \
  --status Inactive
```

Instant rollback if something screams:

```bash
aws iam update-access-key --user-name github-actions-deployer \
  --access-key-id AKIA_OLD_KEY_ID --status Active
```

**Soak before deleting.** Wait long enough for every consumer to have run at least once —
that means at least one full cycle of your *slowest* scheduled job. If there's a weekly
cron, wait a week, not a day. 24-72 hours is the usual minimum; a week is the safe answer
when scheduled jobs exist.

---

## 5. Delete the old key

Only after a clean soak:

```bash
aws iam delete-access-key \
  --user-name github-actions-deployer \
  --access-key-id AKIA_OLD_KEY_ID
```

This is irreversible and frees the second slot for the next rotation. Confirm you're back
to exactly one key:

```bash
aws iam list-access-keys --user-name github-actions-deployer
```

---

## Rollback cheat sheet

| Symptom | Action |
| --- | --- |
| Pipeline fails right after the secret update | Reactivate old key (if you'd deactivated it) and re-set the old secret values — **requires having saved the old secret**. |
| `InvalidClientTokenId` | Wrong/typo'd `AWS_ACCESS_KEY_ID`, or the key was deleted. Re-set the secret from the password manager. |
| `SignatureDoesNotMatch` | Mismatched pair — the ID and secret came from different keys, or trailing whitespace/newline got pasted into the secret. Re-set both together. |
| `AccessDenied` on a specific API but auth succeeded | Not a rotation problem — the key works, the IAM policy doesn't allow that call. Don't roll back. |
| Something unknown breaks days later | Reactivate the old key immediately, then use CloudTrail on the old key ID to identify the consumer. |
| Old secret was never saved anywhere | You can't roll back. Roll *forward*: delete the bad key to free a slot, create a fresh one, redo steps 1-3. |

---

## Stop doing this: switch to OIDC

Long-lived IAM user keys in repo secrets are the thing you're rotating *because* they're
long-lived. GitHub Actions can assume an IAM role directly over OIDC — short-lived
credentials, nothing stored in GitHub, nothing to rotate, ever.

You already run exactly this pattern in `a9-tracker`: `.github/workflows/deploy.yml`
authenticates to Google Cloud with Workload Identity Federation and holds no service
account key at all. The AWS equivalent:

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::<account>:role/github-actions-deployer
      aws-region: us-east-1
```

Setup is a one-time job: register `token.actions.githubusercontent.com` as an IAM OIDC
provider, create a role whose trust policy conditions on your specific
`repo:OWNER/REPO:ref:refs/heads/main` (scope the `sub` claim tightly — a wildcard here is
how other people's repos get to assume your role), attach the deployer's existing policy,
then delete the IAM user entirely.

Worth doing as the *follow-up* to this rotation, not instead of it — rotate first to close
the immediate exposure, migrate second.

---

## One thing to confirm first

The repo open in this session, `tschomay/a9-tracker`, contains **no AWS usage and no
`AWS_ACCESS_KEY_ID` secret**. Its only workflow (`.github/workflows/deploy.yml`) deploys
to Firebase Hosting using keyless Workload Identity Federation. Whatever consumes
`github-actions-deployer` lives in a different repo — worth confirming which one before
you run step 2, since that's the repo whose secrets you'll be updating.
