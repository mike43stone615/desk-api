// Real answers (trimmed) captured from the running service, used as the examples in the published API description
// (GET /v1/gateway/openapi.json). Keys are "METHOD /v1/path". Regenerate by re-capturing when an answer changes.
export const GATEWAY_EXAMPLES: Record<string, { status: number; request: unknown; response: unknown }> = {
  "GET /v1/auth/session": {
    "status": 200,
    "request": null,
    "response": {
      "user": {
        "id": "f4baaa6d940aef8395c51a1f9d0fe809",
        "email": "you@example.com",
        "firstName": "Ada",
        "lastName": "Lovelace",
        "emailConfirmedAt": "2026-09-20T15:45:52.705Z"
      }
    }
  },
  "GET /v1/setup/businesses": {
    "status": 200,
    "request": null,
    "response": {
      "hasMore": false,
      "businesses": [
        {
          "id": "17c64f448c26db3fdab35748",
          "name": "Sunrise Bakery",
          "industry": null,
          "role": "Owner",
          "isSetupComplete": true
        }
      ]
    }
  },
  "GET /v1/setup/drafts": {
    "status": 200,
    "request": null,
    "response": {
      "drafts": [
        {
          "id": "d00d7e1fbe6ff39c76619e7fdfeb4d48",
          "businessName": "Sunrise Bakery",
          "currentStep": 0,
          "updatedAt": "2026-09-20T15:49:51.610Z"
        }
      ]
    }
  },
  "POST /v1/gateway/registry/name-availability": {
    "status": 200,
    "request": {
      "businessName": "Sunrise Bakery",
      "stateOfFormation": "FL"
    },
    "response": {
      "responseId": "322d4eb3-6605-4f6e-b476-9cbd3794ae5c",
      "servedAt": "2026-09-20T15:46:02.369Z",
      "status": "high_conflict",
      "available": false,
      "message": "A strong matching registration was found.",
      "matches": [
        "SUNRISE BAKERY, INC.",
        "SUNRISE BAKERY & CAFE LLC"
      ],
      "source": "florida_sunbiz_quarterly_corporate_cache",
      "sourceUrl": "https://dos.fl.gov/sunbiz/other-services/data-downloads/quarterly-data/",
      "verificationMode": "registry_cache",
      "lastCheckedAt": "2026-09-20T15:46:02.369Z",
      "sourceUpdatedAt": "2026-09-09T08:59:16.311Z",
      "disclaimer": "This is a preliminary, automated check only -- not legal advice, and not a guarantee that a name is available or free of conflict. Underlying registry and tr...",
      "matchDetails": [
        {
          "name": "SUNRISE BAKERY, INC.",
          "matchType": "exact",
          "active": true,
          "status": "Active",
          "entityType": "Domestic Profit",
          "score": 100,
          "matchReason": "\"sunrise bakery\" is an exact match after normalizing suffixes and punctuation"
        },
        {
          "name": "SUNRISE BAKERY & CAFE LLC",
          "matchType": "starts_with",
          "active": true,
          "status": "Active",
          "entityType": "Florida Limited Liability Company",
          "score": 90,
          "matchReason": "\"sunrise bakery and cafe\" starts with your name \"sunrise bakery\""
        }
      ],
      "suggestions": [
        "Sunrise Bakery Group",
        "Sunrise Bakery Partners"
      ]
    }
  },
  "POST /v1/gateway/registry/dba-availability": {
    "status": 200,
    "request": {
      "businessName": "Sunrise Bakery",
      "stateOfFormation": "FL"
    },
    "response": {
      "responseId": "eaeb96ca-2a50-4625-bb32-ccb05bf1d05e",
      "servedAt": "2026-09-20T15:46:03.180Z",
      "status": "manual_verification_required",
      "available": false,
      "message": "Use the official state registry to verify this name.",
      "matches": [],
      "source": "Florida DOS",
      "sourceUrl": "https://dos.fl.gov/sunbiz/search/",
      "verificationMode": "manual",
      "lastCheckedAt": "2026-09-20T15:46:03.180Z",
      "sourceUpdatedAt": null,
      "disclaimer": "This is a preliminary, automated check only -- not legal advice, and not a guarantee that a name is available or free of conflict. Underlying registry and tr..."
    }
  },
  "POST /v1/gateway/registry/trademark-availability": {
    "status": 200,
    "request": {
      "businessName": "Sunrise Bakery"
    },
    "response": {
      "responseId": "f539a7a2-b94b-458c-a80f-a7b367bb9c9a",
      "servedAt": "2026-09-20T15:46:04.511Z",
      "status": "possible_conflict",
      "matches": [
        {
          "serialNumber": "99629547",
          "markLiteralElements": "VET'S SUNRISE BAKERY",
          "ownerName": "Cannoli Capeesh LLC (LIMITED LIABILITY COMPANY; New Jersey, USA)",
          "intlClass": [
            "IC 030"
          ],
          "goodsServices": "IC 030: Bakery goods, namely, Baked goods, namely, breads, rolls, pastries, cakes, cookies, brownies, and Italian baked goods, Cupcakes, Donuts.",
          "live": true
        },
        {
          "serialNumber": "99183318",
          "registrationNumber": "8372152",
          "markLiteralElements": "SUNRISE BAKERY SPECIALIST",
          "ownerName": "BakeMark USA LLC (LIMITED LIABILITY COMPANY; Delaware, USA)",
          "intlClass": [
            "IC 030"
          ],
          "goodsServices": "IC 030: Mirror glazes for bakery goods; glazes for bakery goods being icing.",
          "live": true
        }
      ],
      "source": "uspto_tmsearch",
      "sourceUrl": "https://tmsearch.uspto.gov",
      "lastCheckedAt": "2026-09-20T15:46:04.511Z"
    }
  },
  "POST /v1/gateway/registry/multi-state-availability": {
    "status": 200,
    "request": {
      "businessName": "Sunrise Bakery",
      "states": [
        "FL",
        "GA"
      ]
    },
    "response": {
      "responseId": "36424663-fc9c-4d0a-85e1-c63e26332902",
      "servedAt": "2026-09-20T15:46:05.294Z",
      "businessName": "Sunrise Bakery",
      "results": {
        "FL": {
          "status": "manual_verification_required",
          "available": false,
          "message": "Use the official state registry to verify this name.",
          "matches": [],
          "source": "official_state_registry",
          "sourceUrl": null,
          "verificationMode": "manual",
          "lastCheckedAt": "2026-09-20T15:46:05.294Z",
          "sourceUpdatedAt": null,
          "disclaimer": "This is a preliminary, automated check only -- not legal advice, and not a guarantee that a name is available or free of conflict. Underlying registry and tr..."
        },
        "GA": {
          "status": "manual_verification_required",
          "available": false,
          "message": "Use the official state registry to verify this name.",
          "matches": [],
          "source": "official_state_registry",
          "sourceUrl": null,
          "verificationMode": "manual",
          "lastCheckedAt": "2026-09-20T15:46:05.294Z",
          "sourceUpdatedAt": null,
          "disclaimer": "This is a preliminary, automated check only -- not legal advice, and not a guarantee that a name is available or free of conflict. Underlying registry and tr..."
        }
      }
    }
  },
  "POST /v1/gateway/registry/batch-availability": {
    "status": 200,
    "request": {
      "names": [
        "Sunrise Bakery",
        "Harbor Coffee"
      ],
      "stateOfFormation": "FL"
    },
    "response": {
      "responseId": "64f1c43e-e9ad-4baa-b2c0-498270d25a3f",
      "servedAt": "2026-09-20T15:46:06.087Z",
      "stateOfFormation": "FL",
      "results": [
        {
          "name": "Sunrise Bakery",
          "result": {
            "status": "manual_verification_required",
            "available": false,
            "message": "Use the official state registry to verify this name.",
            "matches": [],
            "source": "official_state_registry",
            "sourceUrl": null,
            "verificationMode": "manual",
            "lastCheckedAt": "2026-09-20T15:46:06.087Z",
            "sourceUpdatedAt": null,
            "disclaimer": "This is a preliminary, automated check only -- not legal advice, and not a guarantee that a name is available or free of conflict. Underlying registry and tr..."
          }
        },
        {
          "name": "Harbor Coffee",
          "result": {
            "status": "manual_verification_required",
            "available": false,
            "message": "Use the official state registry to verify this name.",
            "matches": [],
            "source": "official_state_registry",
            "sourceUrl": null,
            "verificationMode": "manual",
            "lastCheckedAt": "2026-09-20T15:46:06.087Z",
            "sourceUpdatedAt": null,
            "disclaimer": "This is a preliminary, automated check only -- not legal advice, and not a guarantee that a name is available or free of conflict. Underlying registry and tr..."
          }
        }
      ]
    }
  },
  "POST /v1/gateway/registry/name-trend": {
    "status": 200,
    "request": {
      "businessName": "Sunrise",
      "stateOfFormation": "FL"
    },
    "response": {
      "responseId": "1792a3b1-9222-447f-b83f-870ffa345fb9",
      "servedAt": "2026-09-20T15:46:09.884Z",
      "businessName": "Sunrise",
      "recentFilingsCount": 323,
      "period": "12 months",
      "trend": "saturated",
      "topNames": [
        "SUNRISE TO SUNSET MEDIA PRODUCTION GROUP CORP",
        "SUNRISE EDIT COLLECTIVE LLC"
      ],
      "commonCoWords": [
        {
          "word": "inc.",
          "count": 43
        },
        {
          "word": "sunrise,",
          "count": 14
        }
      ],
      "stateOfFormation": "FL"
    }
  },
  "GET /v1/gateway/registry/sync-status": {
    "status": 200,
    "request": null,
    "response": {
      "responseId": "5e383653-ac80-4916-8ebf-4ba188aadab8",
      "servedAt": "2026-09-20T15:46:19.592Z",
      "states": {
        "AL": {
          "entityCoverage": "live_checker",
          "dbaCoverage": "manual"
        },
        "AK": {
          "entityCoverage": "manual",
          "dbaCoverage": "manual"
        },
        "AZ": {
          "entityCoverage": "manual",
          "dbaCoverage": "manual"
        },
        "AR": {
          "entityCoverage": "manual",
          "dbaCoverage": "manual"
        },
        "CA": {
          "entityCoverage": "manual",
          "dbaCoverage": "manual"
        },
        "CO": {
          "entityCoverage": "live_checker",
          "dbaCoverage": "live_checker"
        },
        "CT": {
          "entityCoverage": "live_checker",
          "dbaCoverage": "live_checker"
        },
        "DE": {
          "entityCoverage": "manual",
          "dbaCoverage": "manual"
        },
        "FL": {
          "entityCoverage": "registry_cache",
          "dbaCoverage": "manual",
          "recordCount": 12808069,
          "lastSyncedAt": "2026-09-09T08:59:16.311Z",
          "sourceName": "florida_sunbiz_quarterly_corporate"
        },
        "GA": {
          "entityCoverage": "manual",
          "dbaCoverage": "manual"
        },
        "HI": {
          "entityCoverage": "live_checker",
          "dbaCoverage": "live_checker"
        },
        "ID": {
          "entityCoverage": "live_checker",
          "dbaCoverage": "manual"
        },
        "IL": {
          "entityCoverage": "manual",
          "dbaCoverage": "manual"
        },
        "IN": {
          "entityCoverage": "manual",
          "dbaCoverage": "manual"
        }
      },
      "summary": {
        "total": 56,
        "entity": {
          "liveChecker": 10,
          "registryCache": 2,
          "manual": 44
        },
        "dba": {
          "liveChecker": 7,
          "manual": 49
        },
        "coveragePct": 21
      },
      "memoryCache": {
        "size": 3
      },
      "generatedAt": "2026-09-20T15:46:19.592Z"
    }
  },
  "GET /v1/gateway/registry/business-structures": {
    "status": 200,
    "request": null,
    "response": {
      "responseId": "156cd312-3f14-4c95-8dfc-da248f0d8444",
      "servedAt": "2026-09-20T15:46:45.860Z",
      "structures": [
        {
          "slug": "sole_proprietorship",
          "name": "Sole Proprietorship",
          "category": "legal_entity",
          "family": "sole_proprietorship",
          "aliases": [
            "sole prop",
            "sole trader"
          ],
          "summary": "An unincorporated business owned by one individual, usually with no separate legal entity.",
          "ownership": "One owner.",
          "liability": "Unlimited personal liability.",
          "taxation": "Business income is generally reported directly by the owner.",
          "management": "Owner manages directly.",
          "formation": "Often no state entity filing, though licenses, DBAs, permits, and tax registrations may still be required.",
          "bestFor": [
            "Very small owner-operated businesses",
            "Low-risk services"
          ],
          "cautions": [
            "No liability shield",
            "Harder to raise outside capital"
          ],
          "taxElectionOptions": [
            "sole_proprietor_taxation"
          ]
        },
        {
          "slug": "general_partnership",
          "name": "General Partnership",
          "category": "legal_entity",
          "family": "partnership",
          "aliases": [
            "GP",
            "ordinary partnership"
          ],
          "summary": "An unincorporated business with two or more owners carrying on as co-owners.",
          "ownership": "Two or more partners.",
          "liability": "Partners generally have unlimited personal liability for partnership obligations.",
          "taxation": "Pass-through partnership taxation.",
          "management": "Partners manage unless an agreement says otherwise.",
          "formation": "Can arise by conduct; may require DBA, tax, license, or partnership filings depending on jurisdiction.",
          "bestFor": [
            "Simple co-owned businesses",
            "Short-term low-risk ventures"
          ],
          "cautions": [
            "Each partner can bind the partnership",
            "Personal assets are at risk"
          ],
          "taxElectionOptions": [
            "partnership_taxation"
          ]
        }
      ],
      "count": 72
    }
  },
  "GET /v1/gateway/registry/business-structures/{slug}": {
    "status": 200,
    "request": null,
    "response": {
      "responseId": "d7361db3-356c-47ad-8bba-8835526c401d",
      "servedAt": "2026-09-20T15:46:46.662Z",
      "structure": {
        "slug": "sole_proprietorship",
        "name": "Sole Proprietorship",
        "category": "legal_entity",
        "family": "sole_proprietorship",
        "aliases": [
          "sole prop",
          "sole trader"
        ],
        "summary": "An unincorporated business owned by one individual, usually with no separate legal entity.",
        "ownership": "One owner.",
        "liability": "Unlimited personal liability.",
        "taxation": "Business income is generally reported directly by the owner.",
        "management": "Owner manages directly.",
        "formation": "Often no state entity filing, though licenses, DBAs, permits, and tax registrations may still be required.",
        "bestFor": [
          "Very small owner-operated businesses",
          "Low-risk services"
        ],
        "cautions": [
          "No liability shield",
          "Harder to raise outside capital"
        ],
        "taxElectionOptions": [
          "sole_proprietor_taxation"
        ]
      }
    }
  },
  "POST /v1/gateway/registry/business-structures/recommend": {
    "status": 200,
    "request": {
      "ownerCount": 1,
      "wantsLimitedLiability": true
    },
    "response": {
      "responseId": "cee3bf33-f41d-4708-9725-cd8a1eb77ea7",
      "servedAt": "2026-09-20T15:46:21.975Z",
      "recommendations": [
        {
          "score": 25,
          "reasons": [
            "One owner without liability protection can operate as a sole proprietorship."
          ],
          "structure": {
            "slug": "sole_proprietorship",
            "name": "Sole Proprietorship",
            "category": "legal_entity",
            "family": "sole_proprietorship",
            "aliases": [
              "sole prop",
              "sole trader"
            ],
            "summary": "An unincorporated business owned by one individual, usually with no separate legal entity.",
            "ownership": "One owner.",
            "liability": "Unlimited personal liability.",
            "taxation": "Business income is generally reported directly by the owner.",
            "management": "Owner manages directly.",
            "formation": "Often no state entity filing, though licenses, DBAs, permits, and tax registrations may still be required.",
            "bestFor": [
              "Very small owner-operated businesses",
              "Low-risk services"
            ],
            "cautions": [
              "No liability shield",
              "Harder to raise outside capital"
            ],
            "taxElectionOptions": [
              "sole_proprietor_taxation"
            ]
          }
        }
      ],
      "count": 1
    }
  },
  "POST /v1/gateway/market/research/analyze": {
    "status": 200,
    "request": {
      "businessIdea": "Mobile dog grooming van for apartment communities",
      "formationState": "FL"
    },
    "response": {
      "responseId": "0080cb0f-96af-4c4f-88ea-4c3a37cd41c3",
      "servedAt": "2026-09-20T15:46:24.257Z",
      "summary": "Professional Services was benchmarked in Florida against demand, competition, revenue, startup difficulty, regulatory friction, and data quality using free o...",
      "confidence": "limited",
      "categories": [
        {
          "key": "demand",
          "label": "Demand",
          "score": 65,
          "rationale": "Promising demand (65/100).",
          "reasons": [
            "Florida starts with 21,928,881 residents; the practical local market is estimated at 21,928,881 people. Practical local market uses state-level population be...",
            "94,623 employer establishments already operate in this category in Florida — a high count suggesting a saturated, crowded market."
          ],
          "primarySource": {
            "name": "U.S. Census ACS",
            "url": "https://www.census.gov/programs-surveys/acs"
          },
          "evidence": [
            {
              "title": "Population",
              "value": "21928881",
              "detail": "Florida total population from ACS 5-year profile.",
              "source": "U.S. Census ACS",
              "sourceUrl": "https://api.census.gov/data/2023/acs/acs5/profile?get=NAME%2CDP05_0001E%2CDP05_0001M%2CDP03_0062E%2CDP03_0062M%2CDP03_0119PE%2CDP03_0119PM%2CDP03_0009PE%2CDP...",
              "quality": "strong",
              "category": "demand"
            },
            {
              "title": "Median household income",
              "value": "$71,711",
              "detail": "Florida median household income from ACS 5-year profile.",
              "source": "U.S. Census ACS",
              "sourceUrl": "https://api.census.gov/data/2023/acs/acs5/profile?get=NAME%2CDP05_0001E%2CDP05_0001M%2CDP03_0062E%2CDP03_0062M%2CDP03_0119PE%2CDP03_0119PM%2CDP03_0009PE%2CDP...",
              "quality": "strong",
              "category": "demand"
            }
          ],
          "subSignals": [
            {
              "label": "Practical local-market size",
              "rawValue": "21,928,881",
              "meaning": "Estimates the reachable local customer base in Florida.",
              "computation": "Headcount tier: practical local-market population is 21,928,881 and is in decile 10/10 for state geographies -> decile x 32/10 (32/32 pts here) -> 32/32 pts.",
              "source": "U.S. Census ACS",
              "sourceUrl": "https://data.census.gov/table?q=DP05",
              "quality": "strong",
              "score": 32,
              "maxScore": 32,
              "available": true
            },
            {
              "label": "Population density",
              "rawValue": "Unavailable",
              "meaning": "How concentrated the local population is. A compact market usually supports local discovery, foot traffic, and shorter service radius better than the same he...",
              "computation": "Density tier: real-data fallback density deciles from observed U.S. place/county density data; unavailable is excluded and redistributed Unavailable data: di...",
              "source": "U.S. Census ACS / TIGERweb land area",
              "sourceUrl": "https://data.census.gov/table?q=DP05",
              "quality": "limited",
              "score": 0,
              "maxScore": 8,
              "available": false
            }
          ]
        },
        {
          "key": "competition",
          "label": "Competition",
          "score": 50,
          "rationale": "Fair competitive landscape (50/100).",
          "reasons": [
            "Nearby direct competitors found: 2 direct from Google Places (0 adjacent excluded); 49 direct from Foursquare (0 adjacent excluded) - blended (averaged) into..."
          ],
          "primarySource": {
            "name": "Google Places",
            "url": "https://developers.google.com/maps/documentation/places/web-service/text-search"
          },
          "evidence": [
            {
              "title": "QCEW establishments",
              "value": "149324",
              "detail": "Private-sector annual average employer establishments from the same QCEW industry/state slice.",
              "source": "BLS QCEW",
              "sourceUrl": "https://data.bls.gov/cew/data/api/2024/a/industry/54.csv",
              "quality": "medium",
              "category": "competition"
            },
            {
              "title": "Google competitor set",
              "value": "2 direct matches",
              "detail": "Google Places returned 2 candidate matches; 2 were counted as direct or very similar competitors and 0 adjacent results were excluded. Counted examples inclu...",
              "source": "Google Places",
              "sourceUrl": "https://developers.google.com/maps/documentation/places/web-service/text-search",
              "quality": "medium",
              "category": "competition"
            }
          ],
          "subSignals": [
            {
              "label": "Local competitive density",
              "rawValue": "25.5",
              "meaning": "The filtered count of nearby direct or very similar businesses across independent place-search sources, normalized against what is expected for this category...",
              "computation": "Direct competitor count from 2 direct from Google Places (0 adjacent excluded); 49 direct from Foursquare (0 adjacent excluded) is normalized by category, ge...",
              "source": "Google Places, Foursquare Places",
              "sourceUrl": "https://developers.google.com/maps/documentation/places/web-service/text-search",
              "quality": "strong",
              "score": 20,
              "maxScore": 40,
              "available": true
            },
            {
              "label": "Incumbent strength",
              "rawValue": "61 avg reviews/competitor (121 total); 5.0 avg rating",
              "meaning": "Whether a typical nearby competitor looks entrenched. High average reviews per competitor and high ratings make incumbents harder to displace than a plain co...",
              "computation": "Only 2 matched competitor(s) with 121 review(s) total - too thin a sample to score confidently (needs >=3 competitors and >=10 reviews), so this is treated a...",
              "source": "Google Places",
              "sourceUrl": "https://developers.google.com/maps/documentation/places/web-service/place-data-fields",
              "quality": "limited",
              "score": 0,
              "maxScore": 20,
              "available": false
            }
          ]
        }
      ],
      "overallScore": 57,
      "riskFlags": [
        "Foursquare found several nearby matching places, so validate how this idea will stand out locally.",
        "High employer-establishment count suggests meaningful competition or a crowded category."
      ],
      "recommendedNextActions": [
        "Proceed carefully and validate pricing or customer demand before formation.",
        "Re-run this score after business name, structure, and plan assumptions are updated."
      ],
      "sourcesUsed": [
        "U.S. Census ACS",
        "Census County Business Patterns"
      ],
      "paidSourcesExcluded": [
        "Yelp Fusion",
        "Data Axle"
      ],
      "disclaimer": "This is an automated, preliminary estimate only -- not financial, legal, or business advice, and not a guarantee of real-world outcomes. It is built from pub..."
    }
  },
  "GET /v1/gateway/market/scoring-methodology": {
    "status": 200,
    "request": null,
    "response": {
      "responseId": "d73d30c2-d7d9-4f2b-8dd7-f6b3b2f7cc01",
      "servedAt": "2026-09-20T15:46:25.071Z",
      "overview": "Every category is scored independently on its own 0-100 scale — a business does not need to be weak in one category to score well in another. Local-serving b...",
      "redistribution": "When a sub-signal's underlying data is unavailable for a given request (e.g. an API key is not configured, or a government source returned nothing usable), t...",
      "overallScore": "`overallScore` is a weighted mean across present core categories. Local-serving and national-scope businesses use Demand 28, Revenue 28, Competition 14, Star...",
      "categories": [
        {
          "key": "demand",
          "label": "Demand",
          "description": "For local-serving businesses: how big and how well-funded the potential customer base is in the formation city/county/state. For national-scope businesses: l...",
          "subSignals": [
            {
              "label": "Practical local-market size",
              "maxPoints": 32,
              "description": "Estimates the reachable local customer base, not only the incorporated city limit. The API starts with the most-specific ACS population available. For place-...",
              "sourceUrl": "https://data.census.gov/table?q=DP05"
            },
            {
              "label": "Population density",
              "maxPoints": 8,
              "description": "People per square mile for the same resolved place/county, computed from ACS population and Census Gazetteer land area. It uses like-kind density deciles (pl...",
              "sourceUrl": "https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html"
            }
          ]
        },
        {
          "key": "competition",
          "label": "Competition",
          "description": "For local-serving businesses: how crowded the category is near the formation city, using nearby place-search and local establishment density. For national-sc...",
          "subSignals": [
            {
              "label": "Local competitive density",
              "maxPoints": 40,
              "description": "Nearby place-search results are filtered to direct or very similar competitors first, excluding adjacent businesses when they do not perform the same service...",
              "sourceUrl": "https://developers.google.com/maps/documentation/places/web-service/text-search"
            },
            {
              "label": "Incumbent strength",
              "maxPoints": 20,
              "description": "Google review volume and average rating estimate how entrenched nearby competitors are. More reviews and stronger ratings reduce the score because those comp...",
              "sourceUrl": "https://developers.google.com/maps/documentation/places/web-service/place-data-fields"
            }
          ]
        }
      ]
    }
  },
  "GET /v1/setup/drafts/{id}": {
    "status": 200,
    "request": null,
    "response": {
      "id": "d00d7e1fbe6ff39c76619e7fdfeb4d48",
      "draft": {
        "businessName": "Sunrise Bakery",
        "stateOfFormation": "FL"
      },
      "updatedAt": "2026-09-20T15:49:51.610Z",
      "version": 2
    }
  },
  "GET /v1/setup/businesses/{id}/members": {
    "status": 200,
    "request": null,
    "response": {
      "hasMore": false,
      "members": [
        {
          "id": "5473e7403d4a4181b6a3f0a8",
          "businessId": "17c64f448c26db3fdab35748",
          "userId": "ba532ed2fe1353edee683cffa7b37988",
          "role": "Owner",
          "invitedByUserId": null,
          "invitedAt": null,
          "acceptedAt": "2026-09-20T15:49:51.659Z",
          "createdAt": "2026-09-20T15:49:51Z",
          "updatedAt": "2026-09-20T15:49:51Z",
          "user": {
            "email": "you@example.com",
            "firstName": "Ada",
            "lastName": "Lovelace"
          }
        }
      ],
      "emailInvites": []
    }
  },
  "GET /v1/setup/invites": {
    "status": 200,
    "request": null,
    "response": {
      "hasMore": false,
      "invites": []
    }
  },
  "GET /v1/gateway/services": {
    "status": 200,
    "request": null,
    "response": {
      "services": [
        {
          "service": "desk_api",
          "name": "Desk API",
          "description": "Read access to your own account.",
          "basePath": "/v1",
          "available": true
        },
        {
          "service": "registry_api",
          "name": "Registry API",
          "description": "Business registry lookups.",
          "basePath": "/v1/gateway/registry",
          "available": true
        }
      ]
    }
  },
  "POST /v1/gateway/api-keys/{id}/services": {
    "status": 200,
    "request": {
      "service": "market_validation_api"
    },
    "response": {
      "apiKey": {
        "id": "3f1c2c0e-7a51-4f6e-9a0b-6b0c1f7e2d11",
        "label": "my server",
        "keyPrefix": "deskgw_a1b2c",
        "createdAt": "2026-09-01T12:00:00Z",
        "lastUsedAt": "2026-09-19T08:30:00Z",
        "expiresAt": null,
        "deskScopes": [
          "profile",
          "drafts",
          "businesses"
        ],
        "rateLimitPerMinute": null,
        "services": [
          "desk_api",
          "registry_api",
          "market_validation_api"
        ],
        "suspended": false
      }
    }
  },
  "DELETE /v1/gateway/api-keys/{id}/services/{service}": {
    "status": 200,
    "request": null,
    "response": {
      "apiKey": {
        "id": "3f1c2c0e-7a51-4f6e-9a0b-6b0c1f7e2d11",
        "label": "my server",
        "keyPrefix": "deskgw_a1b2c",
        "createdAt": "2026-09-01T12:00:00Z",
        "lastUsedAt": "2026-09-19T08:30:00Z",
        "expiresAt": null,
        "deskScopes": [
          "profile",
          "drafts",
          "businesses"
        ],
        "rateLimitPerMinute": null,
        "services": [
          "desk_api",
          "registry_api"
        ],
        "suspended": false
      }
    }
  },
  "GET /v1/gateway/api-keys": {
    "status": 200,
    "request": null,
    "response": {
      "apiKeys": [
        {
          "id": "3f1c2c0e-7a51-4f6e-9a0b-6b0c1f7e2d11",
          "label": "my server",
          "keyPrefix": "deskgw_a1b2c",
          "createdAt": "2026-09-01T12:00:00Z",
          "lastUsedAt": "2026-09-19T08:30:00Z",
          "expiresAt": null,
          "services": [
            "desk_api",
            "registry_api"
          ],
          "suspended": false
        }
      ]
    }
  },
  "POST /v1/gateway/api-keys": {
    "status": 201,
    "request": {
      "label": "my server",
      "services": [
        "desk_api",
        "registry_api"
      ],
      "expiresInDays": 90
    },
    "response": {
      "apiKey": {
        "id": "3f1c2c0e-7a51-4f6e-9a0b-6b0c1f7e2d11",
        "label": "my server",
        "keyPrefix": "deskgw_a1b2c",
        "createdAt": "2026-09-20T12:00:00Z",
        "lastUsedAt": null,
        "expiresAt": "2026-12-19T12:00:00Z",
        "services": [
          "desk_api",
          "registry_api"
        ],
        "key": "deskgw_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4 (shown once, never again)"
      }
    }
  },
  "GET /v1/gateway/api-keys/{id}/usage": {
    "status": 200,
    "request": null,
    "response": {
      "keyId": "3f1c2c0e-7a51-4f6e-9a0b-6b0c1f7e2d11",
      "days": 30,
      "lastUsedAt": "2026-09-19T08:30:00Z",
      "expiresAt": null,
      "idleExpiryDays": 180,
      "totals": {
        "calls": 42,
        "errors": 3
      },
      "daily": [
        {
          "day": "2026-09-19",
          "calls": 30,
          "errors": 2
        },
        {
          "day": "2026-09-18",
          "calls": 12,
          "errors": 1
        }
      ],
      "limits": [
        {
          "service": "desk_api",
          "perMinute": 60,
          "note": "Each key may make 60 calls a minute to the Desk API, and every account 300 across all its keys and devices."
        }
      ]
    }
  },
  "POST /v1/gateway/api-keys/{id}/suspend": {
    "status": 200,
    "request": null,
    "response": {
      "ok": true,
      "suspended": true
    }
  },
  "POST /v1/gateway/api-keys/{id}/resume": {
    "status": 200,
    "request": null,
    "response": {
      "ok": true,
      "suspended": false
    }
  }
};
