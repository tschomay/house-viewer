Wrote you a full runbook: `aws-key-rotation-runbook.md`

The short version — an IAM user can hold **two** access keys at once, and that's the entire trick. You create the second key, cut GitHub over to it, prove it works on a real run, and only then retire the first. The user is never without a working credential, so in-flight and queued runs keep going.

The sequence:

1. **Pre-flight.** `aws iam list-access-keys --user-name github-actions-deployer`. If two keys already exist you can't create a third — free a slot first, and that's the step that turns this into a downtime-y rotation, so check it before you plan the window.
2. **Create the new key.** The secret is shown once; straight into the password manager. Verify it with `aws sts get-caller-identity` before it goes near CI.
3. **Update both GitHub secrets back to back**, while nothing is queued or running. Both keys are valid at this point, so the only hazard is a torn read — a job starting between the two `gh secret set` calls and pairing the new ID with the old secret.
4. **Verify on a real deploy** — a step that genuinely calls AWS, not just `configure-aws-credentials` going green — then confirm `get-access-key-last-used` on the *new* key shows minutes-old activity.
5. **Deactivate the old key** (`--status Inactive`, one command to undo), soak, then delete.

Three things that are the actual cause of most broken rotations, and are worth reading in the runbook before you start:

- **Secret scope.** GitHub resolves environment → repo → org. If the deploy job has an `environment:` that defines its own `AWS_ACCESS_KEY_ID`, updating the repo secret changes nothing — the pipeline keeps using the old key and then dies the moment you delete it. Check all three scopes.
- **Other consumers.** Rotation breaks things because the key got quietly reused — another repo, a teammate's `~/.aws/credentials`, a SaaS integration. CloudTrail on the old key ID tells you the truth; the runbook has the query.
- **Soak length.** Wait for one full cycle of your *slowest* scheduled job. A weekly cron means wait a week, not a day.

One caveat on rollback: GitHub secrets are write-only, so you cannot read the current `AWS_SECRET_ACCESS_KEY` back out. If nobody has the old secret saved somewhere, your only recovery path is forward (make another new key), not backward. Worth confirming before step 1.

Two things I noticed:

**This repo has no AWS in it.** `tschomay/a9-tracker` contains no `AWS_ACCESS_KEY_ID` and no AWS usage — the only workflow deploys to Firebase Hosting. So `github-actions-deployer` is consumed by some other repo, and that's the one whose secrets you'll be updating. Worth pinning down which before step 3.

**You already run the fix for this.** `deploy.yml` here authenticates to Google Cloud via Workload Identity Federation with no stored key at all. AWS has the exact same thing — GitHub OIDC into an assumed IAM role, short-lived creds, nothing in repo secrets, nothing to ever rotate again. I'd rotate first to close the current exposure, then migrate as the follow-up and delete the IAM user entirely. Setup sketch is at the end of the runbook.
