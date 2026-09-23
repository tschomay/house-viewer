---
name: easy-mode
description: Turn manual procedures into a published, tap-to-copy checklist. Use when the user asks to "walk me through" something, is on mobile, or when they have manual multi-step work (cloud setup, key rotation, DNS configuration, copying values). Trigger: about to end a turn with a numbered list of steps you can't automate? Use this instead.
---

Some work you cannot automate. Provisioning identities, pasting secrets, approving prompts — these need the user's hands and credentials. What you hand over at that boundary is your deliverable, not a scrollable terminal list.

Easy mode replaces that with a published checklist: every command is one tap to copy, every link goes straight to the exact console page, and progress persists through interruptions.

## When to invoke this skill

Invoke easy-mode when:
- User explicitly asks: "walk me through", "how do I", "give me steps", "on mobile/phone"
- User has implicit manual work: cloud console setup, key rotation, DNS config, secret management, credential handling
- You're about to send a numbered list of manual steps the user must do by hand

**Invoke even without explicit "walk me through" if the task is manual multi-step work requiring copying, pasting, or clicking through consoles.** The benchmark shows 100% success with the skill vs. 7% without for implicit cases like key rotation.

## The core rule: never make them transcribe

**Never ask the user to transcribe something you can compute.** A 97-character identifier wrapped across terminal lines is a transcription trap — copied line-by-line, it silently picks up breaks mid-word.

Before saying "paste the value it printed", ask if you can determine it from config, earlier output, or the project's identifiers. Usually you can — put it in a copy block and use console output for confirmation only.

For values you genuinely cannot know (generated tokens, account IDs), say explicitly they must be pasted as one line with no spaces or breaks, and name the error that signals transcription failed.

## Pick the easiest route

The page's job is to make the procedure easy for the user, not to maximize copy blocks. For each step, ask which route you'd honestly tell a friend to take.

**CLI earns its place when it's genuinely better**: many operations at once, no UI exists, exact values hard to type, or something worth running identically later. A single 2-field form in the UI is none of those. If the shell version needs installs, flags, and error handling to do what three UI taps would do, the UI is the right answer.

A good example: "Open this page, click *Add site*, enter `a9-tracker`" — one link, one click, one copy block. That's better than an elaborate script that does the same work.

## Start from the template

Copy `assets/template.html` and fill it in. Do not design each page fresh.

The template is the house style: complete, themed across all three light/dark states, with copy buttons, progress bar, and fill-once panels already built. Its parts are marked `REPLACE` or marked for deletion. Redesigning per page burns effort on solved problems and makes the set look inconsistent.

Your effort belongs on the procedure itself: order, computed values, named failures. That's where runbooks win.

Only deviate if the subject genuinely demands it, and only in the top tokens (variables), not by restyling. See `references/mechanics.md` if you do touch CSS — it names which rules are load-bearing (`white-space: pre`, `localStorage` try/catch, stable step ids) so you can tell a safe change from one that breaks copy behavior.

## What the page needs to do

The template already handles these. They matter when extending it or deviating:

**Copy blocks.** Every command and value gets a copy button in a `<pre white-space: pre>` block (so long values scroll, not wrap, avoiding invisible line breaks in the copied text). Fall back gracefully if clipboard is blocked.

**One paste per multi-step sequence.** Wrap shell command sequences in a single heredoc (`cat > script.sh <<'EOF' … EOF` then run), not twelve separate pastes.

**Deep links to the exact console page**, not product homepages. On small screens, navigation is most of the work.

**Persistent progress.** Save checkbox state and any fill-in values to `localStorage` (wrapped in try/catch) so interruptions don't reset their place.

**Fill-once for repeated unknowns.** If the same account number, key, or ID appears in 3+ steps, put a small "fill this once" panel at the top instead of leaving 3+ placeholders to hand-edit. Every place on the page rewrites when filled. This eliminates the silent failure of a stale placeholder inside a copied command.

**Don't number steps unless order matters.** If step 4 depends on step 3's output, numbering is information. If they're independent, drop it — it's just clutter.

## Write for failure

Every step will fail for someone. The difference is in what happens then.

**Put warnings inline, not in preambles.** A caution about a debug token belongs in that step, not the intro. Nobody re-reads introductions when they're stuck.

**Name the failure signature.** Systems produce misleading errors (a new account showing "does not exist" due to propagation lag; App Check misconfiguration showing silent data loss). Say "if you see X, it means Y" — that sentence saves more debugging time than anything else on the page.

**Say whether re-running is safe.** Make scripts idempotent (check before creating, retry transients), then state it: "Safe to run again" turns panic into confidence.

**Show what good looks like.** Not just "run it" — what output proves it worked, what to verify next.

## Before publishing

Two checks catch real breakage:

**Verify copy blocks produce valid content.** Extract each block exactly as `innerText` would, HTML-unescape, and validate — `bash -n` for scripts, single-line-no-whitespace for values. A page that looks right but copies broken text is worse than no page.

**Walk the steps as the user would.** Does every referenced value exist by the step that needs it? Are prerequisites front-loaded, not discovered partway through? A missing permission role halfway through means starting over — that should block from the beginning.

## Keeping it alive

The page is the deliverable. When they hit an error the page didn't anticipate, fix the page, not just the chat. Update and republish — that's the difference between a runbook and a transcript.

In chat: give the one-sentence answer to unblock them immediately. The page carries the durable version. Don't make them excavate a wall of text for the fix.
