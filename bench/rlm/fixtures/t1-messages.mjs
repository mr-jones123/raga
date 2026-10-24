/**
 * T1 fixture: customer support messages with hidden categories (OOLONG-style aggregation).
 *
 * Each message has exactly one category. The category comes from one "core" sentence drawn from
 * paraphrase templates; `[a|b|c]` groups in a template multiply its surface forms, so matching the
 * templates with a handful of regexes does not work either. Many billing complaints avoid the words
 * "bill", "charge", and "invoice". Other categories carry distractor sentences that use billing words,
 * including resolved past billing problems ("the double charge from March was reversed, thanks"),
 * so neither a keyword count nor a phrase count recovers the true number.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRng } from "./prng.mjs";

export const CATEGORIES = ["billing complaint", "shipping delay", "product question", "praise", "account access"];
const WEIGHTS = [0.22, 0.2, 0.2, 0.19, 0.19];
export const MESSAGE_COUNT = 800;

const CORE = {
	"billing complaint": [
		"[I was|I've been|I got] [charged|billed|hit] twice for [order {order}|the {product}|my last order] and [nobody has fixed it|no one has replied|it's still not sorted].",
		"My [card|bank|credit card] statement shows ${amount} from you that I never [agreed to|authorised|signed up for].",
		"You [took|pulled|withdrew] ${amount} [out of|from] my account after I cancelled [back in {month}|last {weekday}|weeks ago].",
		"The refund you promised for the {product} [never arrived|still hasn't shown up|is nowhere to be seen] and it has been {days} days.",
		"The [invoice|statement|receipt] for {month} lists [a premium add-on|an extended warranty|a second licence] I never ordered.",
		"I got [hit with|slapped with|stuck with] a ${amount} late fee even though I paid [on time|early|the day it was due].",
		"Why did my subscription renew at ${amount} when I was [quoted|promised|told] ${amount2}?",
		"The price at checkout was ${amount2} but [my bank shows|I ended up paying|the card statement says] ${amount}.",
		"Your system keeps [debiting|taking money from|collecting from] me every week instead of once a month.",
		"I'm still [paying for|being billed for|getting charged for] the plan I downgraded from in {month}.",
		"There's a mystery ${amount} on my [statement|card|bank app] with your company name on it.",
		"Please reverse the duplicate payment for {order}; this is the [third|fourth|second] time I'm asking.",
		"My [coupon|discount code|promo code] was accepted on the site but the full amount was taken anyway.",
		"I was [billed|charged] in euros instead of dollars and lost ${amount} on the conversion.",
		"The tax on my receipt is wrong and I want the difference [back|refunded|returned to my card].",
		"Money left my account for order {order}, which I cancelled before it was even packed.",
		"Someone over there [double-dipped|ran twice] my credit card for the {product}.",
		"The {product} trial was supposed to be free, yet ${amount} [vanished from|was taken out of|disappeared from] my account.",
		"I had to dispute ${amount} with my bank because your team ignored my [emails|calls|messages].",
		"Stop taking money from me, I closed the subscription [weeks ago|in {month}|a month ago].",
		"I was charged ${amount} for express shipping that your site said was free.",
		"Your gift card balance was ignored and my debit card paid the whole ${amount} instead.",
		"Every month the amount you collect creeps up by a few dollars and nobody told me why.",
		"I returned the {product} {days} days ago and I'm still waiting to get my money back.",
		"You overcharged me: [three|two|four] units on the receipt, one in the box.",
		"I see two identical payments of ${amount} for a single {product}, please give one back.",
		"I paid ${amount} for a {product} that was marked down to ${amount2} the same day, and the price-match you advertise was refused.",
		"Nobody can explain the ${amount} 'service fee' that showed up after my order went through.",
		"I want my ${amount} back; the cancellation was confirmed by email but the payment was still collected.",
	],
	"shipping delay": [
		"Order {order} was supposed to arrive {days} days ago and the tracking hasn't moved.",
		"My {product} is still sitting in a {carrier} warehouse.",
		"The estimated delivery date for {order} keeps sliding back.",
		"It's been {days} days and the package still says 'label created'.",
		"The courier says the parcel went back to you, so where is my {product}?",
		"I paid for express and it's taking longer than standard ever did.",
		"My parcel has been 'out for delivery' since last {weekday}.",
		"Still waiting on {order}; I needed it for a birthday that already passed.",
		"{carrier} claims there's an address problem, but my address is correct and the box is stuck.",
		"Nothing has turned up yet and your status page just says processing.",
		"The {product} left your warehouse on {weekday} and has been in transit ever since.",
		"Tracking for {order} shows it bouncing between two depots for a week.",
		"You told me the {product} would ship in two days; that was {days} days ago.",
		"The delivery window passed twice and nobody from {carrier} showed up.",
	],
	"product question": [
		"Does the {product} work with a 220V outlet?",
		"Can the {product} go in the dishwasher, or is it hand wash only?",
		"What's the difference between the {product} and the {product} Pro?",
		"Is there a replacement filter for the {product}, and how often should I swap it?",
		"Will the {product} fit in a {size} cm cabinet?",
		"Does the annual plan include the {product} accessories, or are they billed separately?",
		"How long is the warranty on the {product}?",
		"Is the {product} battery user-replaceable?",
		"Do you make the {product} in a left-handed version?",
		"Can I pay for the {product} in installments, and is there interest?",
		"Which cable does the {product} need to connect to a laptop?",
		"Is the {product} safe to leave running overnight?",
		"Will the invoice for a {product} show my company VAT number if I add it at checkout?",
		"What's the maximum load the {product} can handle?",
	],
	praise: [
		"The {product} is honestly the best purchase I've made this year.",
		"Your support agent {agent} went above and beyond for me.",
		"It arrived a day early and works perfectly.",
		"Just wanted to say thanks, the {product} made my mornings so much easier.",
		"Five stars, I've already recommended you to my sister.",
		"My refund came through in two days, really impressed with how you handled it.",
		"Your billing page is so much clearer than any other company's.",
		"Love the new design of the {product}, it looks great on my desk.",
		"I was worried about the charge for the upgrade but it was worth every cent.",
		"{agent} fixed my issue in five minutes. Please tell their manager.",
		"Great quality, great price, and the packaging was recyclable too.",
		"I've ordered from a lot of shops and you're the only one I trust now.",
	],
	"account access": [
		"I can't log in; the reset email never arrives.",
		"My account got locked after three attempts and I don't know how to unlock it.",
		"Two-factor codes are still going to my old phone number.",
		"The app says my password is wrong but I changed it an hour ago.",
		"I need to change the email on my account but I can't get past the verification step.",
		"Someone else seems to have signed into my profile from another country.",
		"I can't get into my account to download my invoices.",
		"The login page loops back to itself after I enter my details.",
		"My username was changed and now nothing I type is accepted.",
		"The security questions on my account don't match anything I would have chosen.",
		"I get 'session expired' every time I try to open the billing tab.",
		"After merging my two accounts I can't sign in to either one.",
	],
};

/** Sentences that use billing words without being a billing complaint. Added only to other categories. */
const DISTRACTORS = [
	"(The payment itself went through fine, no issues there.)",
	"My billing details are all up to date, by the way.",
	"I'm not complaining about the charge, the price was fair.",
	"No problem with the invoice, that part was quick.",
	"I know my card was charged correctly, that's not the issue.",
	"For the record, the refund from my last order arrived on time.",
	"I checked my bank statement and everything there looks right.",
	"Billing was smooth as always.",
	"The double charge from {month} was reversed already, thanks for that.",
	"Please ignore my earlier email about being charged twice, that got sorted.",
	"Your colleague already refunded the late fee, so that part is fine.",
	"Last time I wrote about a mystery amount on my statement, but it turned out to be my partner's order.",
	"I'm not asking about the ${amount} payment, that one is correct.",
	"The duplicate payment was refunded within a day, which I appreciated.",
];

const FILLERS = [
	"I've been a customer for {years} years.",
	"I'm writing from my phone, so excuse any typos.",
	"My order number is {order} in case you need it.",
	"This is the second time I'm writing about this.",
	"I hope you're having a good day.",
	"I tried the help center first but couldn't find an answer.",
	"I live in {city}, if that matters.",
	"My partner suggested I reach out directly.",
	"I bought the {product} for my home office.",
	"I chatted with someone named {agent} earlier this week.",
	"I'm usually pretty patient, but I've had a long week and wanted to get this sorted before the weekend.",
	"Some background: I use the {product} every day and I've owned a couple of your other products over the years.",
	"I'm copying this message into the contact form as well because I wasn't sure which one you check.",
	"If it helps, the best time to reach me is in the evening after six, {city} time.",
	"My neighbour had something similar happen last spring, so I thought I'd ask before assuming anything.",
	"I read through the FAQ and a couple of forum threads but none of them quite matched my situation.",
	"Please let me know if you need any more details from my side, like the email address I signed up with.",
	"I'm not in a rush for a phone call, an email reply is completely fine.",
	"I usually order through the app.",
	"Sorry for the long message.",
	"I've attached nothing, but can send screenshots if needed.",
];

const OPENERS = ["Hi,", "Hello team,", "To whom it may concern,", "Hey there,", "Good morning,", "Hi support,", "Hello,", ""];
const CLOSERS = ["Thanks.", "Regards.", "Thank you!", "Cheers.", "Best wishes.", "Waiting for your answer.", ""];

const PRODUCTS = [
	"AeroPress Max",
	"desk lamp",
	"kettle",
	"standing desk",
	"air purifier",
	"blender",
	"robot vacuum",
	"office chair",
	"water filter",
	"travel mug",
	"smart plug",
	"label printer",
];
const CARRIERS = ["UPS", "FedEx", "DHL", "the postal service", "the courier"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const AGENTS = ["Priya", "Marco", "Dana", "Kenji", "Lucia", "Tom"];
const CITIES = ["Leeds", "Austin", "Lyon", "Osaka", "Porto", "Calgary", "Durban"];
const FIRST = ["Ana", "Ben", "Chloe", "Dev", "Ella", "Femi", "Gus", "Hana", "Ivan", "Jo", "Kai", "Lena", "Mo", "Nia"];
const LAST = ["Smith", "Okafor", "Novak", "Garcia", "Chen", "Muller", "Rossi", "Khan", "Silva", "Berg"];

function fill(template, rng) {
	const withAlternatives = template.replace(/\[([^\]]+)\]/g, (_match, options) => rng.pick(options.split("|")));
	return withAlternatives.replace(/\{(\w+)\}/g, (_match, key) => {
		switch (key) {
			case "order":
				return `#${rng.int(100000, 999999)}`;
			case "amount":
			case "amount2":
				return `${rng.int(5, 400)}.${String(rng.int(0, 99)).padStart(2, "0")}`;
			case "month":
				return rng.pick(MONTHS);
			case "days":
				return String(rng.int(6, 40));
			case "product":
				return rng.pick(PRODUCTS);
			case "carrier":
				return rng.pick(CARRIERS);
			case "weekday":
				return rng.pick(WEEKDAYS);
			case "agent":
				return rng.pick(AGENTS);
			case "size":
				return String(rng.int(30, 90));
			case "years":
				return String(rng.int(1, 12));
			case "city":
				return rng.pick(CITIES);
			default:
				throw new Error(`unknown placeholder ${key}`);
		}
	});
}

function pickCategory(rng) {
	let r = rng.next();
	for (let i = 0; i < CATEGORIES.length; i++) {
		r -= WEIGHTS[i];
		if (r < 0) return CATEGORIES[i];
	}
	return CATEGORIES[CATEGORIES.length - 1];
}

/** Writes `messages.txt` into `dir`; returns the ground truth, including the ids of the billing complaints. */
export function generateT1(dir, seed) {
	const rng = createRng(seed);
	const lines = [];
	const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
	const billingIds = [];
	for (let i = 1; i <= MESSAGE_COUNT; i++) {
		const category = pickCategory(rng);
		counts[category]++;
		if (category === "billing complaint") billingIds.push(i);
		const parts = [];
		const fillers = rng.shuffle(FILLERS).slice(0, rng.int(4, 6));
		const opener = rng.pick(OPENERS);
		if (opener) parts.push(opener);
		parts.push(fill(fillers[0], rng));
		parts.push(fill(rng.pick(CORE[category]), rng));
		for (const filler of fillers.slice(1)) parts.push(fill(filler, rng));
		if (category !== "billing complaint" && rng.chance(0.4)) {
			parts.splice(rng.int(1, parts.length), 0, fill(rng.pick(DISTRACTORS), rng));
		}
		const closer = rng.pick(CLOSERS);
		if (closer) parts.push(closer);
		const date = `2026-${String(rng.int(1, 9)).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}`;
		const name = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
		lines.push(`MSG ${String(i).padStart(4, "0")} | ${date} | ${name} | ${parts.join(" ")}`);
	}
	const text = `${lines.join("\n")}\n`;
	writeFileSync(join(dir, "messages.txt"), text);
	return { answer: counts["billing complaint"], counts, bytes: Buffer.byteLength(text), billingIds };
}
