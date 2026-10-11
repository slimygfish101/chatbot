# Text Blast

The admin texts one phone number from his flip phone, and every boy on the list gets that text as a normal SMS. Boys can't post to the group. When the message has gone out, the admin gets a one-line summary like "Sent to 98 of 100."

- **For the admin:** see [ADMIN_CHEATSHEET.md](ADMIN_CHEATSHEET.md). Print it.
- **Setup progress and next steps:** see [SETUP_STATUS.md](SETUP_STATUS.md).

## How it works

1. The admin texts the group number. That number belongs to Telnyx, the texting company.
2. Telnyx passes the text to this program, which runs free on Cloudflare.
3. The program checks that the text really came from Telnyx and from an admin's phone, then saves it as a "blast".
4. Within a minute it starts sending, one ordinary SMS per boy, 15 a minute. That's the speed limit carriers set for this kind of registration, so 100 boys take about 7 minutes.
5. A minute or two after the last text, once the phone companies report back, the admin gets the summary. Texts a carrier reports as undelivered count as failed.

Replies from boys are ignored, except:

| A boy texts | What happens |
|---|---|
| STOP, STOPALL, UNSUBSCRIBE, CANCEL, END or QUIT | He's taken off the list and can't be re-added by the admin or an import. This is recorded even for numbers not on the list. Telnyx sends him the "you're unsubscribed" confirmation. |
| START or UNSTOP | He goes back to where he was before STOP: on the list if he was on it, otherwise not. Nobody new can join this way. |
| HELP or INFO | He gets: "[Group] announcements from [Admin]. Reply STOP to opt out." (at most once a day per number) |

## Everyday tasks

All of these are run by Claude Code (or anyone) from this folder. You never need a dashboard.

| Task | How |
|---|---|
| Add or remove one boy | Admin texts `#add 2125551234 Moshe` or `#remove 2125551234` |
| Add many boys | Give Claude Code the list in any format. It runs `npm run import -- list.txt`, shows you anything odd, then `--apply` (and `--welcome` if you want the welcome text sent). |
| Download the list | `npm run export` saves `setup/members-export.csv` |
| See who got the last message | `npm run report` |
| Watch it live | `npm run logs` (phone numbers in the logs are cut to the last 4 digits) |
| Change or add an admin | Update `adminNumbers` in `setup/answers.json`, then `npm run deploy` |
| Pause everything | Set `PAUSED = "true"` in `wrangler.toml`, then `npm run deploy`. Messages the admin sends are saved and go out when it's set back to `"false"`. |
| Test mode (nothing really sent) | `npm run deploy -- --dry`. Back to real: `npm run deploy -- --live` |

## Safety features

- **Signature check:** every message from Telnyx is signed. Anything unsigned, forged or older than 5 minutes is rejected.
- **No double sends:** Telnyx sometimes delivers the same message twice. Each one is recorded, so a repeat never causes a second blast. Two copies of the sender running at once can't send the same batch. Each boy's result is saved the moment his text goes out, so if the program is ever cut off mid-batch, the one text in flight is never resent, and the boys not yet reached still get it.
- **Pacing:** batches are at least a minute apart, so the 15-a-minute carrier limit is never exceeded.
- **One at a time:** a second blast waits until the first one finishes. `#cancel` stops the one sending (between texts), or the next one waiting if nothing is sending.
- **Daily cap:** at most `MAX_TEXTS_PER_DAY` texts a day (default 1000; a long message counts as 2–3). If it's reached, sending pauses, the admin is told once, and the rest goes out after midnight. `#cancel` stops it. HELP replies never go past the cap.
- **Retries:** if Telnyx is busy (429), has an error (5xx) or doesn't answer within 10 seconds, that boy is retried after 30s, 60s and 120s. After 4 tries he's counted as failed. The summary is retried too.
- **Errors:** if something fails before a blast is saved, the admin gets "Not sent because of a system error. Please send it again."
- **DRY_RUN:** logs what would be sent and sends nothing. It's on by default, and stays on unless set to exactly `"false"`. Dry runs don't use up the daily cap or count as anyone's welcome text.
- **Opt-outs win:** someone who texted STOP is never texted again, even if the admin `#add`s him or he's in an imported list.
- **No media:** only the words of a message are ever sent, never pictures.
- **Secrets** (Telnyx key, phone numbers) live only in Cloudflare's encrypted secret store and in the environment, never in this repository.

## Cost

| Item | Cost |
|---|---|
| Texts: 100 boys × 20–30 messages = 2,000–3,000 texts at about 0.75–0.9¢ each, carrier fees included | $15–27 a month |
| Phone number with texting | about $1.10 a month |
| Sole Proprietor campaign | $2 a month |
| Brand registration + campaign review | about $19 once |
| Cloudflare hosting | $0 |
| **Total** | **about $18–30 a month, plus about $19 once** |

These are the owner's researched Telnyx rates. The setup script shows the real price of the number before buying it. A message over 160 plain characters, or with emoji or Hebrew, costs 2–3 texts per boy.

## Limits to know

- **Speed:** carriers allow Sole Proprietor numbers about 15 texts a minute, so 100 boys takes about 7 minutes. No setting can make it faster. A Low-Volume Standard registration is faster, but it needs an EIN.
- **Daily:** T-Mobile allows a Sole Proprietor brand 1,000 texts a day. That's about 10 blasts to 100 boys.
- **Cloudflare free plan:** everything fits. The busiest run (a batch of 15 that also finishes the job and texts the summary) makes 44 calls to Telnyx and the database combined, counted the strictest way, under the free limit of 50. A test enforces this. A run uses well under the 10 ms CPU limit, because time spent waiting on Telnyx doesn't count. The once-a-minute schedule adds about 1,440 runs a day, far under the 100,000-request daily limit, and about 3,000 database writes a day, far under the 100,000 limit. Keep `SEND_BATCH_SIZE` at 15 or below on the free plan.

---

## Technical notes

```
src/
  index.ts      HTTP entry (POST /telnyx) and the once-a-minute cron
  verify.ts     Telnyx Ed25519 signature + timestamp check
  inbound.ts    admin blasts and #commands; member STOP/START/HELP
  sender.ts     batched sending, retries, daily cap, summary
  store.ts      all D1 queries
  telnyx.ts     send one SMS via POST https://api.telnyx.com/v2/messages
  commands.ts, keywords.ts, phone.ts, segments.ts, config.ts, log.ts
migrations/     D1 schema
scripts/
  telnyx.ts     Telnyx setup steps (number, profile, 10DLC brand/PIN/campaign, webhook, auto-recharge)
  deploy.ts     D1 create + migrate, deploy, secrets, set webhook
  import-members.ts / export-members.ts / report.ts
  local-smoke.ts  runs the real Worker locally (wrangler dev) and replays signed webhooks
test/           unit + flow tests (in-memory SQLite stand-in for D1) and signed webhook replays
```

| Command | What it does |
|---|---|
| `npm test` | All tests |
| `npm run typecheck` | TypeScript check |
| `npm run smoke` | End-to-end check in the real Workers runtime (local D1, signed webhooks, dry run) |
| `npm run telnyx -- <step>` | One Telnyx setup step (run with no step to list them) |
| `npm run deploy` | Deploy everything |

**Settings** (`wrangler.toml` `[vars]`): `GROUP_NAME`, `ADMIN_NAME`, `MAX_TEXTS_PER_DAY`, `DRY_RUN`, `PAUSED`, `SEND_BATCH_SIZE` (default 15, max 30), `TIMEZONE` (the daily cap resets at midnight here), `TELNYX_REPLIES_TO_HELP`.
**Secrets** (set by `npm run deploy` via `wrangler secret bulk`): `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_NUMBER`, `ADMIN_NUMBERS`.
**Setup environment variables** (in the environment only, never in files): `TELNYX_API_KEY`, `CLOUDFLARE_API_TOKEN`, optionally `CLOUDFLARE_ACCOUNT_ID`.
