# Setup status

To resume in a new Claude Code session, paste:

> Continue the Text Blast setup: check out the `text-blast` branch, read SETUP_STATUS.md, and do the next unchecked step.

## Done

- [x] Program written: webhook, admin commands, batched sending, retries, daily cap, dry run, opt-out handling
- [x] 109 automated tests, plus an end-to-end check in Cloudflare's real runtime (`npm run smoke`)
- [x] Setup scripts for every Telnyx and Cloudflare step, so nobody needs to click through dashboards
- [x] README and the admin cheat sheet

## Needed from the owner (only things a person must do)

1. [ ] **Telnyx account.** Sign up at telnyx.com, finish the ID check, add a card and about $20 balance. Then create an API key in the portal under **Keys & Credentials** and add it to this environment as the variable `TELNYX_API_KEY` (never paste it in chat).
2. [ ] **Cloudflare account.** Sign up free at dash.cloudflare.com. Create an API token from **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template, add the **D1: Edit** permission, and add it to this environment as `CLOUDFLARE_API_TOKEN`. (`wrangler login` can't work from a cloud session, so a token replaces it.)
3. [ ] **Network access.** In this environment's settings, allow `api.telnyx.com`, `api.cloudflare.com` and `*.workers.dev`. Then start a new session so the changes apply.
4. [ ] **Answers:** group name, admin's name and cell number, your own cell (for the first real test), preferred area code, school name, and the member list in any format.
5. [ ] **Registration details:** your legal name, home address, email and mobile number. Telnyx texts a PIN to that mobile, which you pass on.
6. [ ] **Telnyx public key.** Telnyx has no API for this. In the portal, open **Keys & Credentials → Public Key** and copy it. It's not a secret, so it can be pasted in chat.
7. [ ] **Approvals:** the number's price, submitting the registration (fees about $19 once + $2/month), the first real text, and whether everyone gets the welcome text on the first import.

## Steps Claude Code runs (in order)

| # | Step | Command |
|---|---|---|
| 1 | Check balance | `npm run telnyx -- balance` |
| 2 | Find numbers, confirm price, buy | `npm run telnyx -- numbers 718`, then `buy +1… --yes` |
| 3 | Messaging profile + attach number | `npm run telnyx -- profile` |
| 4 | Brand, then PIN | `brand --yes`, `otp-send`, `otp-verify <PIN>` |
| 5 | Campaign wording, shown to the owner first | `campaign-preview`, then `campaign --yes` |
| 6 | Deploy with DRY_RUN on (creates D1, migrations, secrets, webhook) | `npm run deploy -- --dry` |
| 7 | Dry-run test: the admin texts the number | `npm run logs`, `npm run report` |
| 8 | Wait for campaign approval, then assign the number | `campaign-status`, `assign` |
| 9 | Turn off auto-recharge | `npm run telnyx -- autorecharge off` |
| 10 | Real test to the admin and owner only | import the 2 numbers, `npm run deploy -- --live`, admin texts "Test 1" |
| 11 | Ask the owner, then import the full list | `npm run import -- list --apply [--welcome]` |

## Current IDs

`setup/state.json` holds the number, profile, brand and campaign IDs as they're created (no secrets).
