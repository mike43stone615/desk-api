# Keyword Dictionary Audit

Source dictionary: `C:\Users\User\AppData\Local\Temp\desk-keyword-dictionary-audit\node_modules\word-list\words.txt` (word-list package, 274,137 lowercased words after filtering).

This audit checks every dictionary word for lexical compatibility with the keyword/name-matching libraries in Desk, Registry API, Market Validation API, and Compliance-related matching helpers. It does **not** claim that every unmapped word received human semantic approval; unmapped means no high-confidence lexical relationship was found by this repeatable pass.

## Results

- Dictionary words reviewed: 274,137
- Mapping targets extracted: 1,778
- Mapped rows emitted: 18,115
- Unique mapped words: 8,592
- Full audit CSV: `docs/keyword-dictionary-audit-all.csv`
- Mapped-only CSV: `docs/keyword-dictionary-audit-mapped.csv`

## Mapped Rows By Library

- setup-classifier: 13,339
- regulatory-status: 935
- overpass-osm-tag: 607
- market-regex-vehicle_fit_relevant_pattern: 380
- registry-reserved-word: 377
- registry-generic-words: 340
- market-regex-licensed_trade_pattern: 272
- market-regex-housing_construction_relevant_pattern: 262
- market-regex-safety_relevant_pattern: 249
- market-regex-special_federal_license_pattern: 237
- market-regex-noaa_climate_relevant_pattern: 205
- compliance-business-type-synonym: 143
- registry-entity-suffix: 121
- market-regex-fda_relevant_pattern: 118
- market-regex-children_focus_pattern: 117
- market-regex-inherently_seasonal_business_pattern: 112
- registry-normalize-abbreviation: 96
- market-regex-senior_focus_pattern: 50
- market-regex-budget_price_pattern: 46
- market-regex-budget_target_pattern: 40
- market-regex-high_income_target_pattern: 38
- market-regex-premium_price_pattern: 18
- registry-stop-words: 13

## Confidence Labels

- `exact`: dictionary word exactly matches an existing keyword, suffix, stop/generic word, reserved word, synonym key, or extracted regex term.
- `phrase-token`: dictionary word is a significant token inside an existing phrase keyword, such as `coffee` from `coffee shop`.
- `stem-prefix-candidate`: dictionary word starts with a current keyword/token stem and is close in length; these are candidates for human review before patching.

## Important Caveat

A true semantic audit of all 274k words still requires human/model review of the unmapped words and all stem-prefix candidates. This file gives us the exhaustive word-by-word ledger and the high-confidence candidates; it is the basis for the next patch pass, not a substitute for semantic judgment.

## Semantic Candidate Pass

Source semantic data: `wordnet-db 3.1` from `C:\Users\User\AppData\Local\Temp\desk-keyword-dictionary-audit\node_modules\wordnet-db\dict`.

- Dictionary words with WordNet entries: 59,994
- Words with semantic candidates: 6,866
- Semantic candidate rows: 11,642
- Semantic candidates for words not already lexically mapped: 9,790
- Candidate CSV: `docs/keyword-dictionary-audit-semantic-candidates.csv`

### Unmapped Semantic Candidates By Library

- setup-classifier: 6,805
- registry-reserved-word: 744
- market-regex-housing_construction_relevant_pattern: 384
- market-regex-inherently_seasonal_business_pattern: 337
- market-regex-licensed_trade_pattern: 267
- market-regex-children_focus_pattern: 213
- overpass-osm-tag: 193
- regulatory-status: 144
- market-regex-vehicle_fit_relevant_pattern: 143
- market-regex-special_federal_license_pattern: 116
- market-regex-noaa_climate_relevant_pattern: 102
- market-regex-safety_relevant_pattern: 92
- market-regex-budget_price_pattern: 63
- market-regex-budget_target_pattern: 43
- market-regex-premium_price_pattern: 36
- market-regex-fda_relevant_pattern: 30
- market-regex-senior_focus_pattern: 28
- compliance-business-type-synonym: 25
- market-regex-high_income_target_pattern: 25

### How To Use This Pass

Rows in `keyword-dictionary-audit-semantic-candidates.csv` are proposed mappings, not automatic patches. A row means the dictionary word's WordNet synonyms/gloss overlap strongly with an existing matching-library target. High-scoring rows whose overlap terms are domain-specific are the safest candidates to promote into actual keyword lists.
## Direct Synonym Review Queue

This stricter file filters the broad semantic pass down to unmapped dictionary words where domain-specific overlap terms appear in the word's direct WordNet synonym set. These are still review candidates, but they are much safer than glossary-only rows.

- Direct synonym review rows: 510
- Unique direct synonym words: 419
- Review CSV: `docs/keyword-dictionary-audit-semantic-direct-synonyms.csv`

### Direct Synonym Candidates By Library

- setup-classifier: 379
- market-regex-vehicle_fit_relevant_pattern: 23
- market-regex-housing_construction_relevant_pattern: 15
- market-regex-inherently_seasonal_business_pattern: 14
- market-regex-children_focus_pattern: 13
- registry-reserved-word: 12
- market-regex-licensed_trade_pattern: 11
- regulatory-status: 10
- market-regex-special_federal_license_pattern: 7
- overpass-osm-tag: 6
- market-regex-premium_price_pattern: 4
- market-regex-budget_price_pattern: 4
- market-regex-senior_focus_pattern: 3
- market-regex-high_income_target_pattern: 3
- market-regex-noaa_climate_relevant_pattern: 2
- compliance-business-type-synonym: 2
- market-regex-fda_relevant_pattern: 1
- market-regex-budget_target_pattern: 1
## Promoted Direct-Synonym Additions

Promoted from the direct-synonym review queue into runtime keyword/name matching libraries after filtering out obvious alternate-sense false positives.

- Setup classifier additions: 158 terms, applied to both `desk-api` and `desk_business`.
- Market-validation regex additions: 34 terms.
- Overpass tag additions: 4 terms.
- Compliance business-type synonym additions: 2 terms.
- Registry reserved-word additions: 1 term.
- Desk regulatory-status keyword additions: 3 terms.
- Focused setup promotion CSV: `docs/keyword-dictionary-audit-setup-classifier-promotions.csv` (164 target/word rows; 158 new keyword strings inserted into each setup classifier).

Skipped direct-synonym rows remain in `docs/keyword-dictionary-audit-semantic-direct-synonyms.csv` for later manual review when the dictionary sense was too broad or likely to create false positives.
## Phrase Audit Pass

Bounded exhaustive phrase audit completed across current runtime phrases, curated domain phrase aliases, and WordNet multi-word lemmas. Phrase space is infinite, so this pass is exhaustive within those declared sources.

- Phrase audit rows: 65513
- Added phrase rows: 514
- Skipped phrase rows: 64999
- Full phrase audit CSV: `docs/keyword-phrase-audit-all.csv`
- Added phrase CSV: `docs/keyword-phrase-audit-added.csv`
- Skipped phrase CSV: `docs/keyword-phrase-audit-skipped.csv`

### Added Phrase Rows By Library

- setup-classifier: 355
- overpass-osm-tag: 61
- compliance-business-type-synonym: 20
- regulatory-status: 20
- market-regex-housing_construction_relevant_pattern: 13
- market-regex-special_federal_license_pattern: 10
- market-regex-vehicle_fit_relevant_pattern: 7
- market-regex-licensed_trade_pattern: 5
- market-regex-children_focus_pattern: 4
- market-regex-inherently_seasonal_business_pattern: 4
- market-regex-budget_price_pattern: 3
- market-regex-budget_target_pattern: 3
- market-regex-high_income_target_pattern: 3
- market-regex-premium_price_pattern: 3
- market-regex-senior_focus_pattern: 3
