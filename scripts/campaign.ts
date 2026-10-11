// The 10DLC campaign wording. Shown to the owner before it's submitted.
import type { Answers } from "./lib";

export function campaignBody(a: Answers, brandId: string) {
  const group = a.groupName ?? "[GROUP NAME]";
  const admin = a.adminName ?? "[ADMIN NAME]";
  const school = a.schoolName ?? group;
  const help = `${group} announcements from ${admin}. Reply STOP to opt out.`;
  return {
    brandId,
    usecase: "SOLE_PROPRIETOR",
    description:
      `One-way announcements from ${admin} to students of ${school} who asked to receive them: schedules, ` +
      `times and reminders. About 20-30 messages a month. No marketing, no links, no third-party content.`,
    messageFlow:
      `Each student gives ${admin} his mobile number in person and agrees to receive ${group} announcement texts. ` +
      `When added, he immediately gets a welcome text: "${group}: You're on the announcement list from ${admin}. ` +
      `About 20-30 texts a month. Reply HELP for help, STOP to opt out." Texting STOP at any time removes him.`,
    sample1: `${group}: Tomorrow's schedule starts at 9am. Reply STOP to opt out.`,
    sample2: `${group}: The bus leaves at 7:30. Reply HELP for help, STOP to opt out.`,
    helpMessage: help,
    optinMessage: `${group}: You're on the announcement list from ${admin}. About 20-30 texts a month. Reply HELP for help, STOP to opt out.`,
    optoutMessage: `${group}: You're unsubscribed and won't get more texts. Reply START to rejoin.`,
    helpKeywords: "HELP,INFO",
    optinKeywords: "START,UNSTOP",
    optoutKeywords: "STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT",
    subscriberHelp: true,
    subscriberOptin: true,
    subscriberOptout: true,
    embeddedLink: false,
    embeddedPhone: false,
    numberPool: false,
    ageGated: false,
    directLending: false,
    affiliateMarketing: false,
    termsAndConditions: true,
    autoRenewal: true,
  };
}
