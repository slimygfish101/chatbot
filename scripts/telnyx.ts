// Telnyx setup, one step at a time. Each step is safe to re-run.
//
//   npm run telnyx -- status
//   npm run telnyx -- balance
//   npm run telnyx -- numbers [areaCode]
//   npm run telnyx -- buy +17185551234 --yes        (spends money)
//   npm run telnyx -- profile
//   npm run telnyx -- brand --yes                   (spends money, submits registration)
//   npm run telnyx -- otp-send
//   npm run telnyx -- otp-verify 123456
//   npm run telnyx -- campaign-preview
//   npm run telnyx -- campaign --yes                (spends money, submits registration)
//   npm run telnyx -- campaign-status
//   npm run telnyx -- assign
//   npm run telnyx -- webhook https://text-blast.xxx.workers.dev/telnyx
//   npm run telnyx -- autorecharge [off]
//   npm run telnyx -- helpreply                     (shows Telnyx's own STOP/HELP auto-replies)
//
// Needs TELNYX_API_KEY in the environment. Never put it in a file.
import { die, loadAnswers, loadState, saveState } from "./lib";
import { campaignBody } from "./campaign";
import { toE164 } from "../src/phone";

const API = "https://api.telnyx.com/v2";
const key = process.env.TELNYX_API_KEY;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  if (!key) die("TELNYX_API_KEY is not set in this environment.");
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

/** Calls, and exits with Telnyx's error message if it failed. */
async function must(method: string, path: string, body?: unknown): Promise<any> {
  const r = await call(method, path, body);
  if (r.status >= 400) die(`Telnyx ${method} ${path} → ${r.status}\n${JSON.stringify(r.json?.errors ?? r.json, null, 2)}`);
  return r.json;
}

/** Tries each [method, path] until one isn't 404/405 (Telnyx docs disagree on a few paths). */
async function firstWorking(attempts: [string, string][], body?: unknown): Promise<any> {
  let last: { status: number; json: any } | null = null;
  for (const [m, p] of attempts) {
    last = await call(m, p, body);
    if (last.status !== 404 && last.status !== 405) {
      if (last.status >= 400) die(`Telnyx ${m} ${p} → ${last.status}\n${JSON.stringify(last.json?.errors ?? last.json, null, 2)}`);
      return last.json;
    }
  }
  die(`None of these worked: ${attempts.map((a) => a.join(" ")).join(", ")} (last: ${last?.status})`);
}

const needYes = (what: string) => {
  if (!process.argv.includes("--yes")) die(`${what}\nRe-run with --yes once the owner has approved.`);
};

const [step, arg] = process.argv.slice(2).filter((a) => a !== "--yes");

async function main() {
  const state = loadState();
  const answers = loadAnswers();

  switch (step) {
    case "balance": {
      const b = (await must("GET", "/balance")).data;
      console.log(`Balance: $${b.balance} ${b.currency}. Available credit: $${b.available_credit}. Credit limit: $${b.credit_limit}.`);
      break;
    }

    case "numbers": {
      const area = arg ?? answers.areaCode;
      const q = new URLSearchParams({
        "filter[country_code]": "US",
        "filter[phone_number_type]": "local",
        "filter[features][]": "sms",
        "filter[limit]": "5",
        "filter[best_effort]": "false",
      });
      if (area) q.set("filter[national_destination_code]", area);
      const list = (await must("GET", `/available_phone_numbers?${q}`)).data ?? [];
      if (!list.length) die(`No numbers available${area ? ` in area code ${area}` : ""}. Try another area code.`);
      for (const n of list) {
        const c = n.cost_information ?? {};
        console.log(`${n.phone_number}  upfront $${c.upfront_cost ?? "?"}  monthly $${c.monthly_cost ?? "?"}  ${n.region_information?.map((r: any) => r.region_name).join(", ") ?? ""}`);
      }
      break;
    }

    case "buy": {
      if (state.phoneNumber) die(`Already bought ${state.phoneNumber}.`);
      const number = toE164(arg ?? "");
      if (!number) die("Usage: buy +17185551234 --yes");
      needYes(`This buys ${number} (monthly charge).`);
      const order = (await must("POST", "/number_orders", {
        phone_numbers: [{ phone_number: number }],
        ...(state.messagingProfileId ? { messaging_profile_id: state.messagingProfileId } : {}),
      })).data;
      console.log(`Ordered ${number}. Order status: ${order.status}.`);
      saveState({ phoneNumber: number });
      break;
    }

    case "profile": {
      if (!state.phoneNumber) die("Buy a number first.");
      let profileId = state.messagingProfileId;
      if (!profileId) {
        const p = (await must("POST", "/messaging_profiles", {
          name: `${answers.groupName ?? "Group"} Text Blast`,
          whitelisted_destinations: ["US"],
          webhook_api_version: "2",
          ...(state.webhookUrl ? { webhook_url: state.webhookUrl } : {}),
        })).data;
        profileId = p.id as string;
        saveState({ messagingProfileId: profileId });
        console.log(`Created messaging profile ${profileId}.`);
      }
      const found = (await must("GET", `/phone_numbers?filter[phone_number]=${encodeURIComponent(state.phoneNumber)}`)).data?.[0];
      if (!found) die(`${state.phoneNumber} isn't on the account yet (order may still be pending). Try again in a minute.`);
      await must("PATCH", `/phone_numbers/${found.id}/messaging`, { messaging_profile_id: profileId });
      saveState({ phoneNumberId: found.id });
      console.log(`Attached ${state.phoneNumber} to the messaging profile.`);
      break;
    }

    case "brand": {
      if (state.brandId) die(`Brand already created: ${state.brandId}. Use otp-send / otp-verify / status.`);
      const b = answers.brand;
      if (!b) die("Owner details missing in setup/answers.json (brand).");
      const mobile = toE164(b.mobilePhone);
      if (!mobile) die("Owner mobile number isn't a valid US number.");
      const body = {
        entityType: "SOLE_PROPRIETOR",
        displayName: `${b.firstName} ${b.lastName}`,
        firstName: b.firstName,
        lastName: b.lastName,
        phone: mobile,
        mobilePhone: mobile,
        email: b.email,
        street: b.street,
        city: b.city,
        state: b.state,
        postalCode: b.postalCode,
        country: "US",
        vertical: "EDUCATION",
      };
      console.log(JSON.stringify({ ...body, email: "(hidden)", street: "(hidden)" }, null, 2));
      needYes("This submits the Sole Proprietor brand registration (one-time fee).");
      const brand = await must("POST", "/10dlc/brand", body);
      const brandId = brand.brandId ?? brand.data?.brandId ?? brand.id;
      saveState({ brandId });
      console.log(`Brand created: ${brandId}. Status: ${brand.identityStatus ?? brand.status ?? "?"}. Next: otp-send.`);
      break;
    }

    case "otp-send": {
      if (!state.brandId) die("Create the brand first.");
      await must("POST", `/10dlc/brand/${state.brandId}/smsOtp`, {
        pinSms: "Your Telnyx texting registration PIN is @OTP_PIN@. It expires in 24 hours.",
        successSms: "Thanks, your texting registration is verified.",
      });
      console.log("PIN texted to the owner's mobile. It's good for 24 hours. Next: otp-verify <PIN>.");
      break;
    }

    case "otp-verify": {
      if (!state.brandId) die("Create the brand first.");
      const pin = (arg ?? "").replace(/\D/g, "");
      if (!pin) die("Usage: otp-verify 123456");
      await firstWorking(
        [
          ["PUT", `/10dlc/brand/${state.brandId}/smsOtp`],
          ["POST", `/10dlc/brand/${state.brandId}/smsOtp/verify`],
        ],
        { otpPin: pin },
      );
      const brand = await must("GET", `/10dlc/brand/${state.brandId}`);
      console.log(`PIN accepted. Identity status: ${brand.identityStatus ?? brand.data?.identityStatus ?? "?"}.`);
      break;
    }

    case "campaign-preview": {
      console.log(JSON.stringify(campaignBody(answers, state.brandId ?? "<brandId>"), null, 2));
      break;
    }

    case "campaign": {
      if (state.campaignId) die(`Campaign already submitted: ${state.campaignId}. Use campaign-status.`);
      if (!state.brandId) die("Create and verify the brand first.");
      const body = campaignBody(answers, state.brandId);
      console.log(JSON.stringify(body, null, 2));
      needYes("This submits the campaign for carrier review (one-time vetting fee + monthly fee).");
      const c = await must("POST", "/10dlc/campaignBuilder", body);
      const campaignId = c.campaignId ?? c.data?.campaignId ?? c.id;
      saveState({ campaignId });
      console.log(`Campaign submitted: ${campaignId}. Approval usually takes a few days. Check with campaign-status.`);
      break;
    }

    case "campaign-status": {
      if (!state.campaignId) die("No campaign yet.");
      const c = await must("GET", `/10dlc/campaign/${state.campaignId}`);
      const d = c.data ?? c;
      console.log(
        JSON.stringify(
          {
            campaignId: d.campaignId,
            campaignStatus: d.campaignStatus,
            status: d.status,
            submissionStatus: d.submissionStatus,
            failureReasons: d.failureReasons,
          },
          null,
          2,
        ),
      );
      break;
    }

    case "assign": {
      if (!state.campaignId || !state.phoneNumber) die("Need both a campaign and a number.");
      const r = await firstWorking(
        [
          ["POST", "/10dlc/phone_number_campaigns"],
          ["POST", "/10dlc/phoneNumberCampaign"],
        ],
        { phoneNumber: state.phoneNumber, campaignId: state.campaignId },
      );
      saveState({ numberAssigned: true });
      console.log(`Assigned ${state.phoneNumber} to the campaign. Status: ${r.assignmentStatus ?? r.data?.assignmentStatus ?? "submitted"}.`);
      break;
    }

    case "webhook": {
      const url = arg ?? state.webhookUrl;
      if (!url || !/^https:\/\/.+\/telnyx$/.test(url)) die("Usage: webhook https://<worker>.workers.dev/telnyx");
      if (!state.messagingProfileId) die("Create the messaging profile first.");
      await must("PATCH", `/messaging_profiles/${state.messagingProfileId}`, { webhook_url: url, webhook_api_version: "2" });
      saveState({ webhookUrl: url });
      console.log(`Inbound webhook set to ${url}.`);
      break;
    }

    case "autorecharge": {
      const paths: [string, string][] = [
        ["GET", "/payment/auto_recharge_prefs"],
        ["GET", "/payments/auto_recharge_prefs"],
      ];
      if (arg === "off") {
        const r = await firstWorking(paths.map(([, p]) => ["PATCH", p] as [string, string]), { enabled: false });
        console.log(`Auto-recharge is now ${r.data?.enabled ? "ON" : "OFF"}.`);
      } else {
        const r = await firstWorking(paths);
        const d = r.data ?? {};
        console.log(`Auto-recharge: ${d.enabled ? "ON" : "OFF"}. Threshold $${d.threshold_amount ?? "?"}, recharge $${d.recharge_amount ?? "?"}.`);
      }
      break;
    }

    case "helpreply": {
      if (!state.messagingProfileId) die("Create the messaging profile first.");
      const r = await call("GET", `/messaging_profiles/${state.messagingProfileId}/autoresp_configs`);
      console.log(JSON.stringify(r.json, null, 2));
      break;
    }

    case "status": {
      const out: Record<string, unknown> = { ...state };
      const b = await call("GET", "/balance");
      out.balance = b.json?.data ? `$${b.json.data.balance}` : `error ${b.status}`;
      if (state.brandId) {
        const r = await call("GET", `/10dlc/brand/${state.brandId}`);
        const d = r.json?.data ?? r.json;
        out.brand = { identityStatus: d?.identityStatus, status: d?.status };
      }
      if (state.campaignId) {
        const r = await call("GET", `/10dlc/campaign/${state.campaignId}`);
        const d = r.json?.data ?? r.json;
        out.campaign = { campaignStatus: d?.campaignStatus, status: d?.status, failureReasons: d?.failureReasons };
      }
      console.log(JSON.stringify(out, null, 2));
      break;
    }

    default:
      console.log(readUsage());
  }
}

function readUsage(): string {
  return "Steps: status, balance, numbers [area], buy <number> --yes, profile, brand --yes, otp-send, otp-verify <pin>, campaign-preview, campaign --yes, campaign-status, assign, webhook <url>, autorecharge [off], helpreply";
}

main().catch((e) => die(String(e?.stack ?? e)));
