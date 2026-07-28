import type { CommercePort, GroundingContext, GroundingPort, ModelPort } from "@palup/platform-ports";
import type {
  Decision,
  PitchKind,
  Policy,
  SafetyClass,
  Signals,
} from "./types.js";
import { classifySupportIntent, handleSupport } from "./support.js";

/** The shipping baseline policy (current champion). Candidates are variations of this. */
export const DEFAULT_POLICY: Policy = {
  id: "champion-v0",
  label: "Baseline (concise, balanced)",
  styleDirective: "Be concise: 2-4 sentences, warm, plain language.",
  proactivityDefault: "balanced",
};

// The system prompt reinforces the guardrails on the MODEL side (defense-in-depth behind the code
// guardrails) and grounds replies in the merchant's own catalog. Only the first line (voice) comes
// from the tunable policy; the rest are non-negotiable and identical across every candidate.
function systemPrompt(policy: Policy, ctx?: GroundingContext): string {
  const rules = [
    policy.styleDirective, // ← the only policy-tunable line
    "Recommend ONLY products from the CATALOG below - never invent products, prices, or discounts.",
    "Only state facts (attributes, prices, shipping, availability, stock) found in the CATALOG/POLICY below. If a fact isn't there, say you're not certain and will check - never invent a spec, price, ETA, stock level, or shipping detail.",
    "If a shopper assumes a product has an attribute it does NOT have in the catalog (e.g. SPF), correct them honestly rather than confirming it.",
    "If the question is ambiguous or you can't tell which product they mean, ask a brief clarifying question instead of guessing.",
    "All catalog items are in stock; never claim something is low-stock or 'almost sold out' to create urgency.",
    "Be an honest advisor: if a product isn't a good fit for the shopper, say so and suggest a better fit - even if it is cheaper.",
    "If the store doesn't carry what the shopper needs, say so honestly and suggest the closest fit.",
    "Never make medical or disease claims and never diagnose; defer health/safety concerns to a human.",
    "You are an AI assistant - never claim to be human; disclose it if asked.",
  ];
  if (!ctx) return ["You are an online store's shopping assistant.", ...rules].join(" ");
  const catalog = ctx.products
    .map(
      (p) =>
        `- ${p.title} (${p.price}): ${p.description}${p.tags?.length ? ` [${p.tags.join(", ")}]` : ""}`,
    )
    .join("\n");
  return [
    `You are ${ctx.brandName}'s shopping assistant.`,
    rules.join(" "),
    "",
    "CATALOG:",
    catalog,
    "",
    `POLICY: Returns - ${ctx.policy.returns} Shipping - ${ctx.policy.shipping}`,
  ].join("\n");
}

// NOTE (honest scope): detection here is a first-cut heuristic classifier. The production
// brain uses the model + learned signals for classification — but the GUARDRAILS
// (safety escalation, injection-as-data, no-pitch-into-problem, no invented discounts) are
// enforced in THIS code deterministically, exactly so that swapping in a stronger model can
// never loosen them (docs/design/shopper-widget.md §6A, §7).

const INJECTION = [
  "ignore previous",
  "ignore above",
  "ignore all",
  "disregard your",
  "system:",
  "[system",
  "you are now",
  "pretend you",
  "developer mode",
  "devmode",
  "repeat your instructions",
  "repeat your system",
  "reveal your prompt",
  "print your instructions",
  "override",
];

const SAFETY: { class: Exclude<SafetyClass, "none" | "injection">; terms: string[] }[] = [
  { class: "distress", terms: ["panic attack", "hurt myself", "kill myself", "self harm", "self-harm", "want to die", "don't want to live", "dont want to live", "don't want to be here", "dont want to be here", "want to disappear", "no reason to go on", "no point anymore", "end it all", "can't go on", "cant go on", "better off without me", "don't want to be alive"] },
  { class: "product_safety", terms: ["burn", "rash", "reaction", "reacted", "allergic", "allergy", "nut oil", "broke me out", "broke out", "breaking out", "irritat", "swelling", "swollen", "sting", "hives", "peeling", "flaking", "blister"] },
  { class: "medical", terms: ["cure", "treat ", "diagnos", "pregnan", "medication", "prescription", "tretinoin", "rosacea", "eczema", "mole", "infection"] },
  { class: "legal", terms: ["lawyer", "i'll sue", "lawsuit", "legal action"] },
  { class: "abuse", terms: ["you're useless", "you are useless", "useless", "i hate you", "hate you", "stupid bot", "stupid", "idiot", "worst bot", "garbage", "trash", "shut up", "shut it"] },
];

// Someone asking whether they're talking to a person — must disclose AI clearly AND offer a human.
const IDENTITY = /real person|a human|are you (a )?(bot|human|person|real|robot)|talking to (a |an )?(person|human|robot|bot|ai)|is this (a )?(bot|person|human|real)|human being/;
// Emotional-pressure demands for a free product / unauthorized giveaway — empathize, take NO unauthorized
// action, escalate. (Distinct from legit "free shipping" questions, which don't match.)
const GIVEAWAY = /free one\b|give (me|it to me) (a )?free|for free|free product|free sample|waive the|comp me|hook me up.*free|just give it to me/;

const SUPPORT = [
  "where's my order", "wheres my order", "order status", "tracking", "track my",
  "return", "refund", "exchange", "cancel", "broken", "defective", "damaged",
  "didn't arrive", "never arrived", "late", "wrong item", "charged twice", "charge twice",
  // escalation-when-stuck is a support intent, not a sales opening
  "need help", "none of this", "just fix it", "not working",
];

const UNKNOWN_FACT = ["competitor", "brand x", "cheaper elsewhere", "other store", "price of their"];

function classifySafety(text: string): SafetyClass {
  for (const group of SAFETY) {
    if (group.terms.some((t) => text.includes(t))) return group.class;
  }
  return "none";
}

function selectPitch(signals: Signals, policy: Policy): PitchKind {
  const level = signals.proactivityLevel ?? policy.proactivityDefault;
  const rel = signals.relationship;
  const cart = signals.cart;
  if (cart === "has_items" || cart === "high_value") {
    return level === "cautious" ? "cart_recovery" : "cross_sell";
  }
  if (rel === "replenishment_due" || rel === "lapsed") return "replenishment";
  if (level === "cautious") return "none";
  if (level === "confident") return "guided_rec";
  return "guided_rec";
}

export interface Brain {
  decide(signals: Signals, message: string): Promise<Decision>;
}

export function createBrain(
  model: ModelPort,
  grounding?: GroundingPort,
  policy: Policy = DEFAULT_POLICY,
  commerce?: CommercePort,
  shopperId = "shopper-demo",
): Brain {
  const tenantId = "demo";
  const groundedMessages = async (message: string, systemExtra = "") => {
    const ctx = grounding ? await grounding.getContext(tenantId) : undefined;
    return [
      { role: "system" as const, content: systemPrompt(policy, ctx) + systemExtra },
      { role: "user" as const, content: message },
    ];
  };
  return {
    async decide(signals: Signals, message: string): Promise<Decision> {
      const text = message.toLowerCase();
      const flags: string[] = [];

      // 0. Kill switch — halts the agent instantly at any scope. No autonomous action; safe hand-off to
      // a person. This path must ALWAYS exist and win (governance non-negotiable, CLAUDE.md §3.4).
      if (signals.killed) {
        flags.push("kill_switch", "halted", "escalate");
        return {
          mode: "safety",
          reply:
            "Our team has paused me right now, so I can't take any actions — but I don't want to leave you waiting: I'm connecting you with a person who can help.",
          pitch: "none",
          escalateToHuman: true,
          outbound: false,
          safetyClass: "none",
          flags,
          model: "guardrail",
        };
      }

      // 1. Injection — treat as data, never take a boundary action, never issue a discount.
      const isInjection = INJECTION.some((p) => text.includes(p));
      if (isInjection) {
        flags.push("injection_blocked");
        return {
          mode: "smalltalk",
          reply:
            "I can't do that — but I'm happy to help with product questions, your order, or a recommendation.",
          pitch: "none",
          escalateToHuman: false,
          outbound: false,
          safetyClass: "injection",
          flags,
          model: "guardrail",
        };
      }

      // 1. Safety — highest precedence; latches for the conversation (INV-A).
      const safetyClass = classifySafety(text);
      if (safetyClass !== "none" || signals.safetyLatched) {
        const cls = safetyClass === "none" ? "product_safety" : safetyClass;
        flags.push(`safety:${cls}`, "no_pitch");
        const escalate = cls !== "regulated_claim" && cls !== "abuse";
        if (escalate) flags.push("escalate");
        // Ground an allergy question on the store's published allergen statement — WITHOUT guaranteeing
        // personal safety. Real data (the Shopify adapter maps it); safe to state facts, not promises.
        const safetyCtx = grounding ? await grounding.getContext(tenantId) : undefined;
        const allergenNote = safetyCtx?.policy.allergens ? ` ${safetyCtx.policy.allergens}` : "";
        // AI-disclosed, empathetic, escalates, and DEFERS health to a doctor (the agent never gives
        // medical advice itself) — recommends no product and never downplays.
        const reply =
          cls === "distress"
            ? "As an AI assistant, I'm really sorry you're going through this — you deserve real support. I'm connecting you with a person now, and if you're in danger please contact your local emergency services or a crisis line."
            : cls === "product_safety"
              ? /allergic|allergy|nut oil|ingredient|i'?ll be fine|ill be fine|broke me out last time|before i (buy|use)|is (this|it) safe|safe for me/.test(text)
                ? // Pre-purchase safety question (allergy / past reaction / "will I be fine?") — ground on the
                  // published ingredient/allergen facts, but NEVER guarantee personal safety; patch test + escalate.
                  `As an AI assistant I don't want to guess about an allergy or a past reaction.${allergenNote} Even so, I can't promise a product is safe for your specific allergy or against cross-contact — please check the full ingredient list on the product page, and if you've reacted before, do a small patch test first. If you're at all unsure, check with a doctor before using it, and I can connect you with our team to confirm the ingredients.`
                : // A reaction that's already happening — empathize, give NO medical advice, escalate, defer
                  // to a doctor, recommend nothing, and never downplay it.
                  "As an AI assistant, I'm really sorry to hear that — that's not okay and I don't want to brush it off. I'm not able to advise on a skin reaction myself, so I'm bringing in a person from our team right away, and if you're worried about your skin or health please check with a doctor. I won't suggest another product while this is going on."
              : cls === "medical"
                ? "As an AI assistant, I can't give medical advice on that — please check with a doctor or pharmacist. I'm happy to connect you with a person for anything order- or product-related."
                : cls === "abuse"
                  ? "I'd like to keep this respectful and still help — I can bring in a member of our team whenever you're ready."
                  : "As an AI assistant, I understand — I'm bringing in a member of our team to help with this.";
        return {
          mode: "safety",
          reply,
          pitch: "none",
          escalateToHuman: escalate,
          outbound: false,
          safetyClass: cls,
          flags,
          model: "guardrail",
        };
      }

      // 2. Open support issue OR a support intent — suppresses sales (INV-B).
      const supportIntent = classifySupportIntent(text);
      const isSupport =
        (signals.openIssues?.length ?? 0) > 0 || supportIntent !== "general" || SUPPORT.some((p) => text.includes(p));
      if (isSupport) {
        // Real, grounded support with the guardrails in code (ownership, refund ceiling=HITL, escalate).
        if (commerce) {
          const r = await handleSupport(commerce, shopperId, message);
          return { mode: "support", reply: r.reply, pitch: "none", escalateToHuman: r.escalate, outbound: false, safetyClass: "none", flags: r.flags, model: "support" };
        }
        // Fallback when no commerce port is wired: generic grounded reply.
        flags.push("mode_support", "no_pitch");
        const stuck = text.includes("just fix it") || text.includes("need help") || text.includes("none of this");
        if (stuck) flags.push("escalate");
        const gen = await model.complete({ messages: await groundedMessages(message), temperature: 0, tenantId });
        const reply = stuck
          ? "I'm sorry this has been frustrating — I'm connecting you with a person who can resolve it."
          : `Let me help with that. ${gen.text}`;
        return { mode: "support", reply, pitch: "none", escalateToHuman: stuck, outbound: false, safetyClass: "none", flags, model: gen.model };
      }

      // Identity — if asked whether they're talking to a person, disclose AI clearly AND offer a human.
      if (IDENTITY.test(text)) {
        flags.push("ai_disclosure", "offer_human");
        return {
          mode: "smalltalk",
          reply:
            "I should be upfront: I'm an AI assistant, not a person. I'm glad to help with products, your order, or a recommendation — and I can connect you with a human on our team anytime you'd like.",
          pitch: "none",
          escalateToHuman: false,
          outbound: false,
          safetyClass: "none",
          flags,
          model: "guardrail",
        };
      }

      // Unauthorized giveaway under pressure — empathize, take NO unauthorized action, escalate to a human.
      if (GIVEAWAY.test(text)) {
        flags.push("no_unauthorized_action", "no_pitch", "escalate");
        return {
          mode: "support",
          reply:
            "I'm sorry you're dealing with that — I really am. I'm not able to authorize a free product or a discount myself, but I don't want to leave you stuck, so I'm connecting you with a person on our team who can look at what's possible.",
          pitch: "none",
          escalateToHuman: true,
          outbound: false,
          safetyClass: "none",
          flags,
          model: "guardrail",
        };
      }

      // 3. Honest uncertainty — never fabricate a fact we can't ground.
      if (UNKNOWN_FACT.some((p) => text.includes(p))) {
        flags.push("honest_uncertainty", "no_pitch");
        return {
          mode: "sales",
          reply:
            "I can't verify another store's current price, but I can tell you exactly how ours performs for what you need — what matters most to you?",
          pitch: "none",
          escalateToHuman: false,
          outbound: false,
          safetyClass: "none",
          flags,
          model: "guardrail",
        };
      }

      // 4. Sales / smalltalk — reactive answer always; proactive pitch is gated.
      // Competitor-comparison handling per the merchant "discuss competitors" mode (default full).
      let systemExtra = "";
      if (/compare[ds]? (to|with)|compared to| versus | vs\b|better than|brand [a-z]\b|competitor/.test(text)) {
        const mode = signals.groundingMode ?? "full";
        flags.push(`competitor:${mode}`);
        systemExtra =
          mode === "off"
            ? "\nCOMPETITOR POLICY: Do NOT discuss competitor specifics. Redirect to the shopper's need and highlight OUR strengths, grounded from the catalog. Never disparage a competitor."
            : mode === "general"
              ? "\nCOMPETITOR POLICY: Give an honest, GENERAL comparison — what to look for in this category — from general knowledge only. No live web; never assert a specific volatile competitor fact (price/stock) as certain. Never disparage."
              : "\nCOMPETITOR POLICY: You may reference a current competitor fact ONLY if you can cite a source; if you can't source it, redirect to the shopper's need. Ground our side from the catalog. Never fabricate a competitor fact and never disparage.";
      }
      const gen = await model.complete({
        messages: await groundedMessages(message, systemExtra),
        temperature: 0,
        tenantId,
      });
      const negativeMood =
        signals.mood === "frustrated" || signals.mood === "upset" || signals.mood === "anxious";
      let pitch: PitchKind = "none";
      let outbound = false;
      if (negativeMood) {
        flags.push("mood_brake", "no_pitch");
      } else {
        pitch = selectPitch(signals, policy);
        if (pitch !== "none") flags.push(`pitch:${pitch}`);
        // Consent-gated outbound: replenishment/cart-recovery imply an email/SMS follow-up, which is
        // only permitted with valid consent (unknown = no-consent). Never do outbound otherwise.
        const wantsOutbound = pitch === "replenishment" || pitch === "cart_recovery";
        if (wantsOutbound) {
          if (signals.consent?.email === "in") {
            outbound = true;
            flags.push("outbound");
          } else {
            flags.push("outbound_suppressed_no_consent");
          }
        }
      }
      return {
        mode: "sales",
        reply: gen.text,
        pitch,
        escalateToHuman: false,
        outbound,
        safetyClass: "none",
        flags,
        model: gen.model,
      };
    },
  };
}
