// Keep output catalog-constrained and attach evidence to each suggested activity.
export function classificationResponseFormat(industries: string[], classificationOnly: boolean) {
  const object = (properties: Record<string, unknown>) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  const string = { type: 'string' };
  const properties: Record<string, unknown> = {
    classification: object({
      industry: { type: 'string', enum: ['', ...industries] },
      additionalIndustries: {
        type: 'array',
        items: { type: 'string', enum: industries },
        maxItems: 4,
      },
      industryEvidence: {
        type: 'array',
        items: object({
          industry: { type: 'string', enum: industries },
          quote: string,
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        }),
        maxItems: 5,
      },
      geographicScope: { type: 'string', enum: ['Local', 'National'] },
      customerType: { type: 'string', enum: ['B2B', 'B2C', 'Both'] },
    }),
    ideaIsPlausible: { type: 'boolean' },
    ideaValidationCategory: {
      type: 'string',
      enum: [
        'VALID',
        'VALID_BUT_NEEDS_DETAIL',
        'MULTIPLE_IDEAS',
        'EXISTING_BUSINESS',
        'IDEA_REQUEST',
        'NOT_BUSINESS_IDEA',
        'NONSENSE',
        'EMPTY',
        'PROHIBITED',
        'MALICIOUS_INPUT',
        'TOO_LONG',
      ],
    },
    ideaFeedback: { type: ['string', 'null'] },
  };
  if (!classificationOnly) {
    properties.marketValidation = object({
      customerProblem: string,
      competitors: string,
      validationPlan: string,
      pricingHypothesis: string,
    });
    properties.businessPlanSections = {
      type: 'array',
      items: object({ title: string, content: string }),
    };
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: 'business_setup_classification',
      strict: true,
      schema: object(properties),
    },
  };
}

export function hasIndustryEvidence(
  value: unknown,
  industry: string,
  idea: string,
  additional: boolean,
): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const quote = typeof entry.quote === 'string' ? entry.quote.trim().toLowerCase() : '';
    return (
      entry.industry === industry &&
      quote.length >= 3 &&
      idea.toLowerCase().includes(quote) &&
      (entry.confidence === 'high' || (!additional && entry.confidence === 'medium')) &&
      !/\b(?:not|no|without|don't|doesn't)\b/.test(quote)
    );
  });
}
