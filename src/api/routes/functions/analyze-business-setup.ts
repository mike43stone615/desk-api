import { Hono } from "hono";
import type { AppConfig } from "../../../config.js";
import { ApiError } from "../../middleware/errors.js";

const router = new Hono<{ Variables: { config: AppConfig } }>();

interface Classification {
  targetMarket: string;
  industry: string;
  geographicScope: "Local" | "National";
  customerType: "B2B" | "B2C" | "Both";
}

interface MarketValidation {
  customerProblem: string;
  competitors: string;
  validationPlan: string;
  pricingHypothesis: string;
}

interface BusinessPlanSection {
  title: string;
  content: string;
}

interface IdeaPlausibility {
  isPlausible: boolean;
  feedback: string | null;
}

// POST /functions/v1/analyze-business-setup
// Mirrors the Supabase Edge Function contract so no Flutter client changes are needed.
router.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();

  if (body?.action !== "classify_unregistered_business") {
    throw new ApiError(400, "Unsupported action.");
  }

  const businessIdea = String(body.businessIdea ?? "").trim();
  const industries = cleanList(body.industries);
  if (!businessIdea) throw new ApiError(400, "businessIdea is required.");
  if (industries.length === 0)
    throw new ApiError(400, "industries are required.");

  const config = c.get("config");

  if (!config.openaiApiKey) {
    return c.json(fallbackEnrichment(businessIdea, industries, body));
  }

  const prompt = {
    businessIdea,
    hasPartners: Boolean(body.hasPartners),
    numberOfPartners: Number(body.numberOfPartners ?? 1),
    formationCity: String(body.formationCity ?? "").trim(),
    formationState: String(body.formationState ?? "").trim(),
    allowedIndustries: industries,
    allowedGeographicScopes: ["Local", "National"],
    allowedCustomerTypes: ["B2B", "B2C", "Both"],
  };

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.openaiModel,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Analyze an unregistered business setup. Return JSON only with classification, marketValidation, businessPlanSections, ideaIsPlausible, ideaFeedback. classification must contain targetMarket, industry, geographicScope, customerType. industry must exactly match one allowedIndustries value. geographicScope must be Local or National. customerType must be B2B, B2C, or Both. marketValidation must contain customerProblem, competitors, validationPlan, pricingHypothesis. businessPlanSections must be an array of comprehensive editable sections with title and content, using placeholders for unknown future setup details. ideaIsPlausible is a boolean: true when businessIdea is a coherent, at-least-vaguely-describable business concept, false when it is empty, keyboard-mash gibberish, or otherwise not describable as a business idea. ideaFeedback is a short one-sentence explanation for the user when ideaIsPlausible is false, and null when ideaIsPlausible is true.",
          },
          { role: "user", content: JSON.stringify(prompt) },
        ],
      }),
    });

    if (!resp.ok) {
      return c.json(fallbackEnrichment(businessIdea, industries, body));
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const content = (
      data?.choices as Array<{ message: { content: string } }>
    )?.[0]?.message?.content;
    const parsed =
      typeof content === "string"
        ? (JSON.parse(content) as Record<string, unknown>)
        : {};
    const plausibility = normalizeIdeaPlausibility(parsed, businessIdea);
    return c.json({
      classification: normalizeClassification(
        parsed.classification && typeof parsed.classification === "object"
          ? (parsed.classification as Record<string, unknown>)
          : parsed,
        businessIdea,
        industries,
      ),
      marketValidation: normalizeMarketValidation(
        parsed.marketValidation,
        businessIdea,
        industries,
      ),
      businessPlanSections: normalizeBusinessPlanSections(
        parsed.businessPlanSections,
        businessIdea,
        industries,
        body,
      ),
      ideaIsPlausible: plausibility.isPlausible,
      ideaFeedback: plausibility.feedback,
      source: "openai",
    });
  } catch {
    return c.json(fallbackEnrichment(businessIdea, industries, body));
  }
});

export { router as analyzeBusinessSetupRouter };

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeClassification(
  input: Record<string, unknown>,
  idea: string,
  industries: string[],
): Classification {
  const fb = fallback(idea, industries);
  const industry = industries.includes(String(input.industry ?? ""))
    ? String(input.industry)
    : fb.industry;
  const gs = input.geographicScope;
  const geographicScope: "Local" | "National" =
    gs === "National"
      ? "National"
      : gs === "Local"
        ? "Local"
        : fb.geographicScope;
  const ct = input.customerType;
  const customerType: "B2B" | "B2C" | "Both" =
    ct === "B2B" || ct === "B2C" || ct === "Both" ? ct : fb.customerType;
  const targetMarket =
    String(input.targetMarket ?? "").trim() || fb.targetMarket;
  return { targetMarket, industry, geographicScope, customerType };
}

function fallback(idea: string, industries: string[]): Classification {
  const lower = idea.toLowerCase();
  const industry = nearestIndustry(lower, industries);
  const geographicScope: "Local" | "National" =
    lower.includes("online") ||
    lower.includes("national") ||
    lower.includes("software") ||
    lower.includes("app") ||
    lower.includes("content")
      ? "National"
      : "Local";
  const customerType: "B2B" | "B2C" | "Both" =
    lower.includes("business") ||
    lower.includes("b2b") ||
    lower.includes("company")
      ? "B2B"
      : lower.includes("consumer") ||
          lower.includes("family") ||
          lower.includes("home")
        ? "B2C"
        : "Both";
  return {
    targetMarket:
      "Customers most likely to need the proposed product or service",
    industry,
    geographicScope,
    customerType,
  };
}

function nearestIndustry(lower: string, industries: string[]): string {
  const preferred =
    lower.includes("food") || lower.includes("restaurant")
      ? "Food Service"
      : lower.includes("software") || lower.includes("app")
        ? "Technology"
        : lower.includes("ai")
          ? "AI Services"
          : lower.includes("consult")
            ? "Consulting"
            : lower.includes("shop") || lower.includes("retail")
              ? "Retail"
              : lower.includes("home") || lower.includes("clean")
                ? "Home Services"
                : "Professional Services";
  return (
    industries.find((i) => i.toLowerCase() === preferred.toLowerCase()) ??
    industries.find((i) =>
      i.toLowerCase().includes(preferred.toLowerCase().split(" ")[0]),
    ) ??
    industries[0]
  );
}

function fallbackEnrichment(
  idea: string,
  industries: string[],
  body: Record<string, unknown>,
) {
  const classification = fallback(idea, industries);
  const marketValidation = fallbackMarketValidation(idea, classification);
  const plausibility = assessIdeaPlausibilityHeuristic(idea);
  return {
    classification,
    marketValidation,
    businessPlanSections: fallbackBusinessPlanSections(
      idea,
      classification,
      marketValidation,
      body,
    ),
    ideaIsPlausible: plausibility.isPlausible,
    ideaFeedback: plausibility.feedback,
    source: "fallback",
  };
}

const GIBBERISH_MIN_LETTERS = 6;
const GIBBERISH_VOWEL_RATIO = 0.2;

// Heuristic used whenever an AI judgment isn't available (no OpenAI key
// configured, the request failed, or the model response didn't include a
// usable ideaIsPlausible field): distinguishes an empty/too-short idea, or
// an unbroken run of consonant-heavy characters (e.g. "akdhdiskdnw"), from
// a plausible, at-least-vaguely-describable business idea. Intentionally
// coarse — it only needs to catch the obvious gibberish/empty case, not
// judge idea quality.
function assessIdeaPlausibilityHeuristic(idea: string): IdeaPlausibility {
  const trimmed = idea.trim();
  if (trimmed.length < 3) {
    return {
      isPlausible: false,
      feedback: "Enter a short description of the business idea.",
    };
  }
  const letters = trimmed.toLowerCase().replace(/[^a-z]/g, "");
  const vowels = (letters.match(/[aeiou]/g) ?? []).length;
  const looksLikeGibberish =
    !trimmed.includes(" ") &&
    letters.length >= GIBBERISH_MIN_LETTERS &&
    vowels / letters.length < GIBBERISH_VOWEL_RATIO;
  if (looksLikeGibberish) {
    return {
      isPlausible: false,
      feedback:
        "This doesn't look like a business idea yet. Describe what the business would do in a few words.",
    };
  }
  return { isPlausible: true, feedback: null };
}

// Trusts the model's own ideaIsPlausible/ideaFeedback when present and
// well-typed, falling back to the heuristic above otherwise (missing
// field, wrong type, or a false verdict with no feedback string).
function normalizeIdeaPlausibility(
  input: Record<string, unknown>,
  idea: string,
): IdeaPlausibility {
  const heuristic = assessIdeaPlausibilityHeuristic(idea);
  if (typeof input.ideaIsPlausible !== "boolean") return heuristic;
  const isPlausible = input.ideaIsPlausible;
  if (isPlausible) return { isPlausible: true, feedback: null };
  const feedback =
    typeof input.ideaFeedback === "string" && input.ideaFeedback.trim()
      ? input.ideaFeedback.trim()
      : heuristic.feedback;
  return { isPlausible: false, feedback };
}

function normalizeMarketValidation(
  input: unknown,
  idea: string,
  industries: string[],
): MarketValidation {
  const fb = fallbackMarketValidation(idea, fallback(idea, industries));
  if (!input || typeof input !== "object") return fb;
  const value = input as Record<string, unknown>;
  return {
    customerProblem:
      String(value.customerProblem ?? "").trim() || fb.customerProblem,
    competitors: String(value.competitors ?? "").trim() || fb.competitors,
    validationPlan:
      String(value.validationPlan ?? "").trim() || fb.validationPlan,
    pricingHypothesis:
      String(value.pricingHypothesis ?? "").trim() || fb.pricingHypothesis,
  };
}

function normalizeBusinessPlanSections(
  input: unknown,
  idea: string,
  industries: string[],
  body: Record<string, unknown>,
): BusinessPlanSection[] {
  const classification = fallback(idea, industries);
  const marketValidation = fallbackMarketValidation(idea, classification);
  if (!Array.isArray(input))
    return fallbackBusinessPlanSections(
      idea,
      classification,
      marketValidation,
      body,
    );
  const sections = input
    .map((item) =>
      item && typeof item === "object"
        ? (item as Record<string, unknown>)
        : null,
    )
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      title: String(item.title ?? "").trim(),
      content: String(item.content ?? "").trim(),
    }))
    .filter((section) => section.title && section.content);
  return sections.length >= 8
    ? sections
    : fallbackBusinessPlanSections(
        idea,
        classification,
        marketValidation,
        body,
      );
}

function fallbackMarketValidation(
  idea: string,
  classification: Classification,
): MarketValidation {
  return {
    customerProblem: `${classification.targetMarket} need a clearer, faster, or more trusted way to solve the problem behind: ${idea}.`,
    competitors: `Likely alternatives include local incumbents, online providers, do-it-yourself options, and adjacent ${classification.industry} businesses serving the same customer need.`,
    validationPlan:
      "Interview 10-20 likely customers, compare competitor pricing and reviews, test one simple offer, and track interest, objections, willingness to pay, and repeat-use signals.",
    pricingHypothesis:
      "Start with a simple price tied to the main customer outcome, then validate against competitor pricing, delivery cost, customer budget, and target margin.",
  };
}

function fallbackBusinessPlanSections(
  idea: string,
  classification: Classification,
  market: MarketValidation,
  body: Record<string, unknown>,
): BusinessPlanSection[] {
  const city = String(body.formationCity ?? "").trim() || "[Launch city]";
  const state = String(body.formationState ?? "").trim() || "[State]";
  const partners = Boolean(body.hasPartners)
    ? `${Number(body.numberOfPartners ?? 1)} partner(s)`
    : "one owner";
  return [
    {
      title: "Executive Summary",
      content: `[Business name] will operate in ${classification.industry} for ${classification.targetMarket}. Concept: ${idea}. Launch location: ${city}, ${state}. Ownership: ${partners}.`,
    },
    {
      title: "Company Description",
      content:
        "Describe the mission, founder background, ownership, location, initial services/products, and the customer outcome the business intends to own.",
    },
    { title: "Problem And Customer Need", content: market.customerProblem },
    {
      title: "Market Research And Validation",
      content: `Competitors and alternatives: ${market.competitors}. Validation plan: ${market.validationPlan}. Pricing hypothesis: ${market.pricingHypothesis}. Add interviews, competitor evidence, demand signals, and willingness-to-pay results here.`,
    },
    {
      title: "Products And Services",
      content:
        "Define the launch offer, what is included, what is excluded, delivery timeline, service standards, and later expansion opportunities.",
    },
    {
      title: "Business Model And Pricing",
      content:
        "Add revenue model, planned price points, payment terms, expected margin, break-even volume, and recurring revenue opportunities.",
    },
    {
      title: "Marketing And Sales Strategy",
      content: `Choose channels that match ${classification.targetMarket}: referrals, search, local outreach, partnerships, content, events, direct sales, or paid tests. Define the first three acquisition experiments.`,
    },
    {
      title: "Operations Plan",
      content:
        "Document workflow, suppliers, tools, scheduling, staffing, quality control, customer support, insurance, and recordkeeping.",
    },
    {
      title: "Legal, Tax, And Compliance Plan",
      content: `Formation location: ${city}, ${state}. Add final legal entity, tax election, name registration, EIN, state tax accounts, licenses, permits, insurance, and renewal deadlines once confirmed.`,
    },
    {
      title: "Financial Plan",
      content:
        "Add startup costs, monthly fixed costs, variable costs, sales forecast, gross margin, owner pay, taxes, cash reserve, funding needs, and break-even assumptions.",
    },
    {
      title: "Milestones And Metrics",
      content:
        "Track validation, formation, bank account, licenses, launch, first customers, break-even, leads, conversion rate, order value, margin, repeat rate, reviews, and cash runway.",
    },
    {
      title: "Risks And Mitigation",
      content:
        "List demand, licensing, cost, supplier, regulatory, cash-flow, and capacity risks. Add early warning signs and mitigation actions.",
    },
  ];
}
