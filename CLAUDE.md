# Text Blast — notes for Claude Code

One-way SMS announcements: Cloudflare Worker + D1 + cron, Telnyx Messaging v2. The owner isn't a developer and wants to do as little as possible. Do every step you can by API/CLI; follow SETUP_STATUS.md for what's left.

- Always ask the owner before: spending money (buying a number, brand, campaign), submitting the registration, the first real (non-dry-run) text, and importing the full list or sending welcome texts.
- Never put keys in files, git or chat. Secrets come from the environment (`TELNYX_API_KEY`, `CLOUDFLARE_API_TOKEN`) and go to Cloudflare via `wrangler secret bulk` (scripts/deploy.ts).
- Never log full phone numbers; use `mask()` from src/phone.ts.
- `setup/answers.json` holds the owner's personal details and is git-ignored. `setup/state.json` holds non-secret IDs and is committed.
- Before pushing: `npm test`, `npm run typecheck`, `npm run smoke`.
- Telnyx docs disagree on a few 10DLC paths (OTP verify, number assignment, auto-recharge); scripts/telnyx.ts tries each documented path. Check live responses before assuming.
- Sole Proprietor limits: ~15 SMS/minute (100 boys ≈ 7 min), 1,000/day on T-Mobile per brand, 1 campaign, 1 number.
