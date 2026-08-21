// OpenAI-backed classification for the business-setup wizard — ported from
// the original api/routes/functions/analyze-business-setup.ts (Hono).
// Route path preserved (mounted at /functions/v1/analyze-business-setup in
// app.ts) so the Flutter client's existing call site needs no changes. Same
// OpenAI call shape, same fallback-without-API-key behavior.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../../middleware/http-error';
import { config } from '../../config';

interface Classification {
  targetMarket: string;
  industry: string;
  additionalIndustries: string[];
  geographicScope: 'Local' | 'National';
  customerType: 'B2B' | 'B2C' | 'Both';
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

export async function analyzeBusinessSetupHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = (request.body ?? {}) as Record<string, unknown>;

  if (body?.action !== 'classify_unregistered_business') {
    throw new HttpError(400, 'Unsupported action.');
  }

  const businessIdea = String(body.businessIdea ?? '').trim();
  const industries = cleanList(body.industries);
  if (!businessIdea) throw new HttpError(400, 'businessIdea is required.');
  if (industries.length === 0) throw new HttpError(400, 'industries are required.');

  if (!config.openaiApiKey) {
    return reply.send(fallbackEnrichment(businessIdea, industries, body));
  }

  const prompt = {
    businessIdea,
    hasPartners: Boolean(body.hasPartners),
    numberOfPartners: Number(body.numberOfPartners ?? 1),
    formationCity: String(body.formationCity ?? '').trim(),
    formationState: String(body.formationState ?? '').trim(),
    allowedIndustries: industries,
    allowedGeographicScopes: ['Local', 'National'],
    allowedCustomerTypes: ['B2B', 'B2C', 'Both'],
  };

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openaiModel,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Analyze an unregistered business setup. Return JSON only with classification, marketValidation, businessPlanSections, ideaIsPlausible, ideaFeedback. classification must contain targetMarket, industry, additionalIndustries, geographicScope, customerType. industry must exactly match one allowedIndustries value. additionalIndustries must be an array of zero to four extra allowedIndustries values when the business clearly operates in multiple industries; exclude the primary industry and avoid speculative extras. geographicScope must be Local or National. customerType must be B2B, B2C, or Both. ' +
              'targetMarket must name a specific customer segment by role, need, occasion, or organization type — never just a location, and never a restatement of businessIdea. The caller already has formationCity/formationState and businessIdea as separate fields, so targetMarket must not repeat the city/state name or re-describe what the business does; it must add NEW information about WHO buys, not WHAT is sold or WHERE. Also drop any qualifier that\'s already implied by the business type itself (e.g. do not add "for infrastructure projects" after a transportation-design business — that\'s implied by "transportation design"; do not add "who need coffee" after a coffee shop). ' +
              'Bad: "residents and businesses in Denver, CO" (only a location). Bad: "local government agencies and private developers in Boise, ID who require specialized transportation civil engineering design services for infrastructure projects" (repeats the city, restates the business idea, and the infrastructure-projects qualifier is redundant). Good fix for that same example: "State departments of transportation, county/city public works or engineering departments, and private land developers bidding infrastructure projects" — or, when confident of the real agency for the given formationState (most states have one, consistently named), name it directly, e.g. "The Idaho Transportation Department, county highway districts, and private land developers." ' +
              'More good examples across other business types: "Local commuters, students, and remote workers who want a fast coffee order on the way to work or class", "Small landlords managing 1-10 rental units who need bookkeeping without hiring full-time staff", "Local residents and members eligible to join who want member-owned banking with lower fees than a national bank". ' +
              'When the business idea implies institutional, government, or professional buyers, name the specific class of buyer (department type, licensing board, school district, hospital system, franchise type, property type, etc.) instead of a vague word like "businesses", "organizations", or "clients". This rule applies the same way regardless of industry or location — always ask what you can name about WHO buys that isn\'t already captured elsewhere in the form. ' +
              'marketValidation must contain customerProblem, competitors, validationPlan, pricingHypothesis. businessPlanSections must be an array of comprehensive editable sections with title and content, using placeholders for unknown future setup details. ideaIsPlausible is a boolean: true when businessIdea is a coherent, at-least-vaguely-describable business concept, false when it is empty, keyboard-mash gibberish, or otherwise not describable as a business idea. ideaFeedback is a short one-sentence explanation for the user when ideaIsPlausible is false, and null when ideaIsPlausible is true.',
          },
          { role: 'user', content: JSON.stringify(prompt) },
        ],
      }),
    });

    if (!resp.ok) {
      return reply.send(fallbackEnrichment(businessIdea, industries, body));
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const content = (data?.choices as Array<{ message: { content: string } }>)?.[0]?.message
      ?.content;
    const parsed =
      typeof content === 'string' ? (JSON.parse(content) as Record<string, unknown>) : {};
    const plausibility = normalizeIdeaPlausibility(parsed, businessIdea);
    return reply.send({
      classification: normalizeClassification(
        parsed.classification && typeof parsed.classification === 'object'
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
      source: 'openai',
    });
  } catch {
    return reply.send(fallbackEnrichment(businessIdea, industries, body));
  }
}

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
  const industry = industries.includes(String(input.industry ?? ''))
    ? String(input.industry)
    : fb.industry;
  const additionalIndustries = normalizeAdditionalIndustries(
    input.additionalIndustries,
    industries,
    industry,
  );
  const gs = input.geographicScope;
  const geographicScope: 'Local' | 'National' =
    gs === 'National' ? 'National' : gs === 'Local' ? 'Local' : fb.geographicScope;
  const ct = input.customerType;
  const customerType: 'B2B' | 'B2C' | 'Both' =
    ct === 'B2B' || ct === 'B2C' || ct === 'Both' ? ct : fb.customerType;
  const targetMarket = String(input.targetMarket ?? '').trim() || fb.targetMarket;
  return { targetMarket, industry, additionalIndustries, geographicScope, customerType };
}

function normalizeAdditionalIndustries(
  value: unknown,
  industries: string[],
  primaryIndustry: string,
): string[] {
  if (!Array.isArray(value)) return [];
  const selected: string[] = [];
  for (const item of value) {
    const candidate = String(item ?? '').trim();
    const industry = industries.find(
      (allowed) => allowed.toLowerCase() === candidate.toLowerCase(),
    );
    if (!industry) continue;
    if (industry.toLowerCase() === primaryIndustry.toLowerCase()) continue;
    if (selected.some((entry) => entry.toLowerCase() === industry.toLowerCase())) continue;
    selected.push(industry);
    if (selected.length >= 4) break;
  }
  return selected;
}

function fallback(idea: string, industries: string[]): Classification {
  const lower = idea.toLowerCase();
  const rule = classificationRules.find((candidate) =>
    candidate.keywords.some((keyword) => lower.includes(keyword)),
  );
  const industry = nearestAllowedIndustry(rule?.industry, lower, industries);
  const additionalIndustries = classificationRules
    .filter(
      (candidate) =>
        candidate !== rule && candidate.keywords.some((keyword) => lower.includes(keyword)),
    )
    .map((candidate) => nearestAllowedIndustry(candidate.industry, lower, industries))
    .filter(
      (candidate, index, list) =>
        candidate.toLowerCase() !== industry.toLowerCase() &&
        list.findIndex((item) => item.toLowerCase() === candidate.toLowerCase()) === index,
    )
    .slice(0, 4);
  const geographicScope: 'Local' | 'National' =
    rule?.geographicScope ??
    (lower.includes('online') ||
    lower.includes('national') ||
    lower.includes('software') ||
    lower.includes('app') ||
    lower.includes('content')
      ? 'National'
      : 'Local');
  const customerType: 'B2B' | 'B2C' | 'Both' =
    rule?.customerType ??
    (lower.includes('business') ||
    lower.includes('b2b') ||
    lower.includes('company') ||
    lower.includes('agency') ||
    lower.includes('contractor') ||
    lower.includes('government') ||
    lower.includes('municipal') ||
    lower.includes('developer')
      ? 'B2B'
      : lower.includes('consumer') || lower.includes('family') || lower.includes('home')
        ? 'B2C'
        : 'Both');
  return {
    targetMarket: rule?.targetMarket ?? targetMarketForIndustry(industry),
    industry,
    additionalIndustries,
    geographicScope,
    customerType,
  };
}

interface FallbackClassificationRule {
  keywords: string[];
  industry: string;
  targetMarket: string;
  geographicScope: 'Local' | 'National';
  customerType: 'B2B' | 'B2C' | 'Both';
}

const classificationRules: FallbackClassificationRule[] = [
  {
    keywords: [
      'civil engineering',
      'transportation design',
      'road',
      'bridge',
      'infrastructure',
      'traffic engineering',
    ],
    industry: 'Engineering Firm',
    targetMarket:
      'State transportation departments, county and city public works teams, and private land developers planning infrastructure projects',
    geographicScope: 'Local',
    customerType: 'B2B',
  },
  {
    keywords: ['engineering', 'engineer', 'structural', 'mechanical design', 'electrical design'],
    industry: 'Engineering Firm',
    targetMarket:
      'Property owners, developers, contractors, and public agencies that need licensed technical design support',
    geographicScope: 'Local',
    customerType: 'B2B',
  },
  {
    keywords: ['coffee', 'cafe', 'espresso', 'tea', 'boba'],
    industry: 'Coffee Shop / Cafe',
    targetMarket: 'Local commuters, students, remote workers, and daily coffee drinkers',
    geographicScope: 'Local',
    customerType: 'B2C',
  },
  {
    keywords: ['restaurant', 'diner', 'eatery', 'taco', 'pizza', 'burger'],
    industry: 'Restaurant',
    targetMarket: 'Local diners, families, workers, and visitors looking for prepared meals',
    geographicScope: 'Local',
    customerType: 'B2C',
  },
  {
    keywords: ['bakery', 'bread', 'pastry', 'cake', 'cookie'],
    industry: 'Bakery',
    targetMarket: 'Local residents, event planners, and gift buyers seeking fresh baked goods',
    geographicScope: 'Local',
    customerType: 'B2C',
  },
  {
    keywords: ['food truck', 'mobile food', 'street food'],
    industry: 'Food Truck',
    targetMarket:
      'Event attendees, office lunch crowds, and local foot traffic looking for quick prepared food',
    geographicScope: 'Local',
    customerType: 'B2C',
  },
  {
    keywords: ['software', 'saas', 'app', 'platform', 'developer tool'],
    industry: 'Software Development',
    targetMarket:
      'Teams and users with a repeated workflow problem that software can automate or simplify',
    geographicScope: 'National',
    customerType: 'Both',
  },
  {
    keywords: ['ai', 'automation', 'machine learning', 'chatbot'],
    industry: 'AI Services',
    targetMarket:
      'Organizations with repeatable operations, support, marketing, or data tasks that can be automated',
    geographicScope: 'National',
    customerType: 'B2B',
  },
  {
    keywords: ['cybersecurity', 'security audit', 'penetration', 'compliance security'],
    industry: 'Cybersecurity Services',
    targetMarket:
      'Small and midsize organizations that need security monitoring, risk reviews, or compliance support',
    geographicScope: 'National',
    customerType: 'B2B',
  },
  {
    keywords: ['it support', 'managed services', 'msp', 'network support'],
    industry: 'IT / Managed Services',
    targetMarket:
      'Small businesses that need reliable technology support without a full internal IT team',
    geographicScope: 'Local',
    customerType: 'B2B',
  },
  {
    keywords: ['consulting', 'consultant', 'advisor', 'fractional'],
    industry: 'Consulting / Professional Services',
    targetMarket:
      'Organizations and founders that need specialized expertise for a specific business decision or project',
    geographicScope: 'National',
    customerType: 'B2B',
  },
  {
    keywords: ['marketing', 'advertising', 'seo', 'brand strategy'],
    industry: 'Marketing Agency',
    targetMarket:
      'Small businesses and growth teams that need help attracting, converting, and retaining customers',
    geographicScope: 'National',
    customerType: 'B2B',
  },
  {
    keywords: ['social media', 'content management'],
    industry: 'Social Media Management',
    targetMarket:
      'Brands and local businesses that need consistent social content and audience engagement',
    geographicScope: 'National',
    customerType: 'B2B',
  },
  {
    keywords: ['virtual assistant', 'admin support', 'executive assistant'],
    industry: 'Virtual Assistant Services',
    targetMarket:
      'Busy founders, executives, and small teams that need part-time administrative support',
    geographicScope: 'National',
    customerType: 'B2B',
  },
  {
    keywords: ['cleaning', 'janitorial', 'maid'],
    industry: 'Cleaning / Janitorial Service',
    targetMarket:
      'Homeowners, renters, offices, and property managers needing recurring cleaning help',
    geographicScope: 'Local',
    customerType: 'Both',
  },
  {
    keywords: ['landscaping', 'lawn', 'yard', 'garden maintenance'],
    industry: 'Landscaping',
    targetMarket:
      'Homeowners, property managers, and commercial sites that need outdoor maintenance or improvements',
    geographicScope: 'Local',
    customerType: 'Both',
  },
  {
    keywords: ['plumbing', 'plumber'],
    industry: 'Plumbing Contractor',
    targetMarket:
      'Homeowners, landlords, builders, and businesses needing installation or repair work',
    geographicScope: 'Local',
    customerType: 'Both',
  },
  {
    keywords: ['electrical', 'electrician'],
    industry: 'Electrical Contractor',
    targetMarket:
      'Homeowners, builders, property managers, and businesses needing electrical installation or repair',
    geographicScope: 'Local',
    customerType: 'Both',
  },
  {
    keywords: ['hvac', 'heating', 'air conditioning'],
    industry: 'HVAC Contractor',
    targetMarket:
      'Homeowners, landlords, and commercial property operators needing climate-system service',
    geographicScope: 'Local',
    customerType: 'Both',
  },
  {
    keywords: ['roof', 'roofing'],
    industry: 'Roofing Contractor',
    targetMarket: 'Homeowners, property managers, and builders needing roof repair or replacement',
    geographicScope: 'Local',
    customerType: 'Both',
  },
  {
    keywords: ['childcare', 'daycare', 'preschool'],
    industry: 'Childcare Center / Daycare',
    targetMarket: 'Working parents and guardians who need reliable daytime care for young children',
    geographicScope: 'Local',
    customerType: 'B2C',
  },
  {
    keywords: ['tutor', 'test prep', 'learning center'],
    industry: 'Tutoring Center',
    targetMarket:
      'Students and families seeking academic support, test preparation, or subject-specific coaching',
    geographicScope: 'Local',
    customerType: 'B2C',
  },
  {
    keywords: ['retail', 'shop', 'store', 'boutique'],
    industry: 'Retail Store',
    targetMarket: 'Shoppers looking for a curated local selection, service, or product category',
    geographicScope: 'Local',
    customerType: 'B2C',
  },
  {
    keywords: ['ecommerce', 'e-commerce', 'online store'],
    industry: 'E-commerce / Online Store',
    targetMarket:
      'Online shoppers searching for a focused product selection delivered conveniently',
    geographicScope: 'National',
    customerType: 'B2C',
  },
  {
    keywords: ['pet', 'dog', 'cat', 'grooming'],
    industry: 'Pet Services',
    targetMarket:
      'Pet owners who need convenient, trustworthy care, grooming, training, or support services',
    geographicScope: 'Local',
    customerType: 'B2C',
  },
  {
    keywords: ['accounting', 'bookkeeping', 'tax preparation'],
    industry: 'Accounting / Bookkeeping / Tax Preparation',
    targetMarket:
      'Small business owners and individuals who need accurate books, tax filing, and financial records',
    geographicScope: 'Local',
    customerType: 'Both',
  },
  {
    keywords: ['law', 'legal', 'attorney'],
    industry: 'Law Firm',
    targetMarket:
      'Individuals and organizations facing legal decisions, disputes, transactions, or compliance needs',
    geographicScope: 'Local',
    customerType: 'Both',
  },
  {
    keywords: ['real estate', 'realtor', 'brokerage'],
    industry: 'Real Estate Brokerage / Agent',
    targetMarket:
      'Home buyers, sellers, investors, and property owners navigating real estate transactions',
    geographicScope: 'Local',
    customerType: 'Both',
  },
  {
    keywords: ['property management', 'landlord', 'rental units'],
    industry: 'Property Management',
    targetMarket:
      'Rental property owners and small landlords who need leasing, maintenance, and tenant coordination',
    geographicScope: 'Local',
    customerType: 'B2B',
  },
];

function nearestAllowedIndustry(
  preferred: string | undefined,
  lower: string,
  industries: string[],
): string {
  const candidates = [
    preferred,
    lower.includes('food') ? 'Restaurant' : undefined,
    lower.includes('software') || lower.includes('app') ? 'Software Development' : undefined,
    lower.includes('consult') ? 'Consulting / Professional Services' : undefined,
    lower.includes('shop') || lower.includes('retail') ? 'Retail Store' : undefined,
    lower.includes('home') || lower.includes('clean') ? 'Cleaning / Janitorial Service' : undefined,
    'Consulting / Professional Services',
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const exact = industries.find((industry) => industry.toLowerCase() === candidate.toLowerCase());
    if (exact) return exact;
    const candidateTokens = candidate
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const fuzzy = industries.find((industry) => {
      const lowerIndustry = industry.toLowerCase();
      return candidateTokens.some((token) => lowerIndustry.includes(token));
    });
    if (fuzzy) return fuzzy;
  }
  return industries[0] ?? 'Consulting / Professional Services';
}

function targetMarketForIndustry(industry: string): string {
  const lower = industry.toLowerCase();
  if (lower.includes('engineering'))
    return 'Developers, property owners, contractors, and public agencies that need technical design support';
  if (lower.includes('software'))
    return 'Teams and users with a repeated workflow problem that software can automate or simplify';
  if (lower.includes('consult'))
    return 'Organizations and founders that need specialized expertise for a specific business decision or project';
  if (lower.includes('retail'))
    return 'Shoppers looking for a focused product selection, service, or local buying experience';
  if (lower.includes('clean'))
    return 'Households, offices, and property managers needing reliable recurring service';
  if (lower.includes('restaurant') || lower.includes('food'))
    return 'Local diners, workers, families, and visitors looking for prepared food';
  return 'Specific buyers who already have the problem this business is designed to solve';
}
function fallbackEnrichment(idea: string, industries: string[], body: Record<string, unknown>) {
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
    source: 'fallback',
  };
}

const GIBBERISH_MIN_LETTERS = 6;
const GIBBERISH_VOWEL_RATIO = 0.2;

function assessIdeaPlausibilityHeuristic(idea: string): IdeaPlausibility {
  const trimmed = idea.trim();
  if (trimmed.length < 3) {
    return { isPlausible: false, feedback: 'Enter a short description of the business idea.' };
  }
  const letters = trimmed.toLowerCase().replace(/[^a-z]/g, '');
  const vowels = (letters.match(/[aeiou]/g) ?? []).length;
  const looksLikeGibberish =
    !trimmed.includes(' ') &&
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

function normalizeIdeaPlausibility(input: Record<string, unknown>, idea: string): IdeaPlausibility {
  const heuristic = assessIdeaPlausibilityHeuristic(idea);
  if (typeof input.ideaIsPlausible !== 'boolean') return heuristic;
  const isPlausible = input.ideaIsPlausible;
  if (isPlausible) return { isPlausible: true, feedback: null };
  const feedback =
    typeof input.ideaFeedback === 'string' && input.ideaFeedback.trim()
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
  if (!input || typeof input !== 'object') return fb;
  const value = input as Record<string, unknown>;
  return {
    customerProblem: String(value.customerProblem ?? '').trim() || fb.customerProblem,
    competitors: String(value.competitors ?? '').trim() || fb.competitors,
    validationPlan: String(value.validationPlan ?? '').trim() || fb.validationPlan,
    pricingHypothesis: String(value.pricingHypothesis ?? '').trim() || fb.pricingHypothesis,
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
    return fallbackBusinessPlanSections(idea, classification, marketValidation, body);
  const sections = input
    .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : null))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      title: String(item.title ?? '').trim(),
      content: String(item.content ?? '').trim(),
    }))
    .filter((section) => section.title && section.content);
  return sections.length >= 8
    ? sections
    : fallbackBusinessPlanSections(idea, classification, marketValidation, body);
}

function fallbackMarketValidation(idea: string, classification: Classification): MarketValidation {
  return {
    customerProblem: `${classification.targetMarket} need a clearer, faster, or more trusted way to solve the problem behind: ${idea}.`,
    competitors: `Likely alternatives include local incumbents, online providers, do-it-yourself options, and adjacent ${classification.industry} businesses serving the same customer need.`,
    validationPlan:
      'Interview 10-20 likely customers, compare competitor pricing and reviews, test one simple offer, and track interest, objections, willingness to pay, and repeat-use signals.',
    pricingHypothesis:
      'Start with a simple price tied to the main customer outcome, then validate against competitor pricing, delivery cost, customer budget, and target margin.',
  };
}

function fallbackBusinessPlanSections(
  idea: string,
  classification: Classification,
  market: MarketValidation,
  body: Record<string, unknown>,
): BusinessPlanSection[] {
  const city = String(body.formationCity ?? '').trim() || '[Launch city]';
  const state = String(body.formationState ?? '').trim() || '[State]';
  const partners = body.hasPartners
    ? `${Number(body.numberOfPartners ?? 1)} partner(s)`
    : 'one owner';
  return [
    {
      title: 'Executive Summary',
      content: `[Business name] will operate in ${classification.industry} for ${classification.targetMarket}. Concept: ${idea}. Launch location: ${city}, ${state}. Ownership: ${partners}.`,
    },
    {
      title: 'Company Description',
      content:
        'Describe the mission, founder background, ownership, location, initial services/products, and the customer outcome the business intends to own.',
    },
    { title: 'Problem And Customer Need', content: market.customerProblem },
    {
      title: 'Market Research And Validation',
      content: `Competitors and alternatives: ${market.competitors}. Validation plan: ${market.validationPlan}. Pricing hypothesis: ${market.pricingHypothesis}. Add interviews, competitor evidence, demand signals, and willingness-to-pay results here.`,
    },
    {
      title: 'Products And Services',
      content:
        'Define the launch offer, what is included, what is excluded, delivery timeline, service standards, and later expansion opportunities.',
    },
    {
      title: 'Business Model And Pricing',
      content:
        'Add revenue model, planned price points, payment terms, expected margin, break-even volume, and recurring revenue opportunities.',
    },
    {
      title: 'Marketing And Sales Strategy',
      content: `Choose channels that match ${classification.targetMarket}: referrals, search, local outreach, partnerships, content, events, direct sales, or paid tests. Define the first three acquisition experiments.`,
    },
    {
      title: 'Operations Plan',
      content:
        'Document workflow, suppliers, tools, scheduling, staffing, quality control, customer support, insurance, and recordkeeping.',
    },
    {
      title: 'Legal, Tax, And Compliance Plan',
      content: `Formation location: ${city}, ${state}. Add final legal entity, tax election, name registration, EIN, state tax accounts, licenses, permits, insurance, and renewal deadlines once confirmed.`,
    },
    {
      title: 'Financial Plan',
      content:
        'Add startup costs, monthly fixed costs, variable costs, sales forecast, gross margin, owner pay, taxes, cash reserve, funding needs, and break-even assumptions.',
    },
    {
      title: 'Milestones And Metrics',
      content:
        'Track validation, formation, bank account, licenses, launch, first customers, break-even, leads, conversion rate, order value, margin, repeat rate, reviews, and cash runway.',
    },
    {
      title: 'Risks And Mitigation',
      content:
        'List demand, licensing, cost, supplier, regulatory, cash-flow, and capacity risks. Add early warning signs and mitigation actions.',
    },
  ];
}
