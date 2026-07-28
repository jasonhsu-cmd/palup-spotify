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
  { class: "distress", terms: ["panic attack", "hurt myself", "kill myself", "self harm", "self-harm"] },
  { class: "product_safety", terms: ["burn", "rash", "reaction", "reacted", "allergic", "allergy", "broke out", "breaking out", "irritat", "swelling", "swollen", "sting", "hives", "peeling", "flaking", "blister"] },
  { class: "medical", terms: ["cure", "treat ", "diagnos", "pregnan", "medication", "prescription", "tretinoin", "rosacea", "eczema", "mole", "infection"] },
  { class: "legal", terms: ["lawyer", "i'll sue", "lawsuit", "legal action"] },
  { class: "abuse", terms: ["you're useless", "you are useless", "i hate you", "stupid bot"] },
];

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
  const groundedMessages = async (message: string) => {
    const ctx = grounding ? await grounding.getContext(tenantId) : undefined;
    return [
      { role: "system" as const, content: systemPrompt(policy, ctx) },
      { role: "user" as const, content: message },
    ];
  };
  return {
    async decide(signals: Signals, message: string): Promise<Decision> {
      const text = message.toLowerCase();
      const flags: string[] = [];

      // 0. Injection — treat as data, never take a boundary action, never issue a discount.
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
        // AI-disclosed, empathetic, escalates, and DEFERS health to a doctor (the agent never gives
        // medical advice itself) — recommends no product and never downplays.
        const reply =
          cls === "distress"
            ? "As an AI assistant, I'm really sorry you're going through this — you deserve real support. I'm connecting you with a person now, and if you're in danger please contact your local emergency services or a crisis line."
            : cls === "product_safety"
              ? "As an AI assistant, I'm sorry to hear that. I'm not able to advise on a reaction myself, so I'm bringing in a person to help right away — and if you're worried about your health, please check with a doctor."
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
      const gen = await model.complete({
        messages: await groundedMessages(message),
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
