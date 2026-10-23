// A business keeps everything the setup wizard collected as one JSON text (businesses.business_json). The Administration page shows
// each fact in it as its own column, so it can be read, filtered, sorted and edited field by field, and does not show the JSON
// itself. This file is the list of those facts: the column's name, where it sits in the JSON, and what kind of value it is.
// (The wizard's own list is defaultDraft() in desk_business: setup-wizard/wizard-data.js.)
import { HttpError } from '../middleware/http-error';

export type JsonFieldType = 'text' | 'bool' | 'bool_or_empty' | 'int' | 'text_list' | 'json';
export interface JsonField { column: string; key: string; type: JsonFieldType }

const f = (column: string, key: string, type: JsonFieldType): JsonField => ({ column, key, type });

/** In the order the page shows them: the business itself first, then where and how it is formed, then the idea, then the rest. */
export const BUSINESS_JSON_FIELDS: readonly JsonField[] = [
  f('business_name', 'businessName', 'text'),
  f('is_registered_business', 'isRegisteredBusiness', 'bool_or_empty'),
  f('formation_state', 'formationState', 'text'),
  f('formation_city', 'formationCity', 'text'),
  f('formation_address', 'formationAddress', 'text'),
  f('formation_place_id', 'formationPlaceId', 'text'),
  f('business_structure', 'businessStructure', 'text'),
  f('legal_entity', 'legalEntity', 'text'),
  f('tax_election', 'taxElection', 'text'),
  f('special_legal_designation', 'specialLegalDesignation', 'text'),
  f('has_partners', 'hasPartners', 'bool'),
  f('number_of_partners', 'numberOfPartners', 'int'),
  f('regulatory_statuses', 'regulatoryStatuses', 'text_list'),
  f('regulatory_statuses_reviewed', 'regulatoryStatusesReviewed', 'bool'),
  f('s_corp_eligible_owners_confirmed', 'sCorpEligibleOwnersConfirmed', 'bool'),
  f('s_corp_single_class_confirmed', 'sCorpSingleClassConfirmed', 'bool'),
  f('s_corp_business_eligible_confirmed', 'sCorpBusinessEligibleConfirmed', 'bool'),
  f('business_idea', 'businessIdea', 'text'),
  f('idea_industry', 'industry', 'text'),
  f('additional_industries', 'additionalIndustries', 'text_list'),
  f('classification_source', 'classificationSource', 'text'),
  f('customer_type', 'customerType', 'text'),
  f('customer_problem', 'customerProblem', 'text'),
  f('geographic_scope', 'geographicScope', 'text'),
  f('competitors', 'competitors', 'text'),
  f('pricing_hypothesis', 'pricingHypothesis', 'text'),
  f('validation_plan', 'validationPlan', 'text'),
  f('idea_plausible', 'ideaPlausible', 'bool'),
  f('idea_feedback', 'ideaFeedback', 'json'),
  f('market_research', 'marketResearch', 'json'),
  f('name_availability', 'nameAvailability', 'json'),
  f('manual_verification_acknowledged', 'manualVerificationAcknowledged', 'bool'),
  f('business_plan_mode', 'businessPlanMode', 'text'),
  f('uploaded_business_plan_name', 'uploadedBusinessPlanName', 'text'),
  f('business_plan_sections', 'businessPlanSections', 'json'),
  f('requirements', 'requirements', 'json'),
  f('registered_agent_status', 'registeredAgentStatus', 'text'),
  f('registered_agent_name', 'registeredAgentName', 'text'),
  f('venture_backed', 'ventureBacked', 'bool'),
  f('wants_stock', 'wantsStock', 'bool'),
  f('real_estate_or_holdings', 'realEstateOrHoldings', 'bool'),
  f('wants_liability_protection', 'wantsLiabilityProtection', 'bool'),
  f('recommended_legal_entity', 'recommendedLegalEntity', 'text'),
  f('recommended_tax_election', 'recommendedTaxElection', 'text'),
  f('recommended_special_designation', 'recommendedSpecialDesignation', 'text'),
  f('recommended_reasons', 'recommendedReasons', 'text_list'),
  f('last_analyzed_idea_fingerprint', 'lastAnalyzedIdeaFingerprint', 'text'),
  f('market_research_fingerprint', 'marketResearchFingerprint', 'text'),
  f('current_step', 'currentStep', 'int'),
];

/** The columns the page shows without being asked: the rest are in its Columns menu. */
export const BUSINESS_JSON_DEFAULT_SHOWN = ['business_name', 'formation_state', 'legal_entity', 'tax_election', 'has_partners', 'number_of_partners'];

/** SQL that reads one field out of the stored text: empty when the JSON is damaged or the field is missing or of another kind. */
export function jsonFieldSql(jsonColumn: string, field: JsonField): string {
  const j = `safe_jsonb("${jsonColumn}")`;
  const at = `${j} -> '${field.key}'`;
  switch (field.type) {
    case 'text':
      return `${j} ->> '${field.key}'`;
    case 'bool':
    case 'bool_or_empty':
      return `CASE WHEN jsonb_typeof(${at}) = 'boolean' THEN (${j} ->> '${field.key}')::boolean END`;
    case 'int':
      return `CASE WHEN jsonb_typeof(${at}) = 'number' THEN round((${j} ->> '${field.key}')::numeric)::integer END`;
    default:
      return `(${at})`; // a list or an object: shown as it is
  }
}

export const businessJsonComputed = (jsonColumn: string): Record<string, string> =>
  Object.fromEntries(BUSINESS_JSON_FIELDS.map((field) => [field.column, jsonFieldSql(jsonColumn, field)]));

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** What to store for a typed value, or a plain-words 400. */
export function coerceJsonField(field: JsonField, value: unknown): unknown {
  switch (field.type) {
    case 'text':
      return value === null || value === undefined ? null : String(value);
    case 'bool':
    case 'bool_or_empty': {
      if (isEmpty(value)) {
        if (field.type === 'bool_or_empty') return null;
        throw new HttpError(400, `${field.column} must be true or false.`, 'invalid_value');
      }
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new HttpError(400, `${field.column} must be true or false.`, 'invalid_value');
    }
    case 'int': {
      if (isEmpty(value)) return null;
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isInteger(n)) throw new HttpError(400, `${field.column} needs a whole number.`, 'invalid_value');
      return n;
    }
    case 'text_list': {
      if (isEmpty(value)) return [];
      let list: unknown = value;
      if (typeof value === 'string') {
        try { list = JSON.parse(value); } catch { list = null; }
      }
      if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) {
        throw new HttpError(400, `${field.column} needs a list of words, for example ["a", "b"].`, 'invalid_value');
      }
      return list;
    }
    case 'json': {
      if (isEmpty(value)) return null;
      let parsed: unknown = value;
      if (typeof value === 'string') {
        try { parsed = JSON.parse(value); } catch { throw new HttpError(400, `${field.column} needs valid JSON.`, 'invalid_value'); }
      }
      if (parsed !== null && typeof parsed !== 'object') throw new HttpError(400, `${field.column} needs valid JSON (an object or a list).`, 'invalid_value');
      return parsed;
    }
  }
}
