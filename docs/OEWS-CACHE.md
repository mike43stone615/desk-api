# BLS OEWS Wage Cache

Desk uses BLS Occupational Employment and Wage Statistics (OEWS) as a wage-cost benchmark in market research. The live BLS files are large and are sometimes blocked from server-side automated downloads, so Desk keeps a compact state-level cache in D1.

## What is cached

The current cache stores the statewide `All Occupations` row for each U.S. state, DC, and Puerto Rico. This gives Desk a broad local labor-cost benchmark without putting a large BLS import in the user request path.

D1 tables:

- `oews_wage_rows`
- `oews_import_runs`

R2 staging key:

- `labor/oews/state-all-occupations.tsv`

## Compact TSV format

Upload a tab-separated file with this header:

```text
dataset_year	area_code	area_name	state_code	occupation_code	occupation_title	employment	hourly_mean_wage	annual_mean_wage	hourly_median_wage	annual_median_wage	source_url
```

Example row:

```text
2025	0100000	Alabama	AL	00-0000	All Occupations	2100000	26.50	55120	21.10	43890	https://www.bls.gov/oes/tables.htm
```

Numeric cells should use plain numbers only. Use an empty cell when BLS suppresses or omits a value.

## Refresh flow

1. Download the official state OEWS data from BLS.
2. Convert the state-level `All Occupations` rows to the compact TSV format above.
3. Upload the TSV to R2:

```bash
npx wrangler r2 object put desk-api-storage/labor/oews/state-all-occupations.tsv --file ./state-all-occupations.tsv
```

4. Trigger the Desk import:

```bash
curl -X POST https://api.deskbusiness.co/admin/oews/import \
  -H "Authorization: Bearer <admin-session-token>"
```

5. Confirm the cache status:

```bash
curl https://api.deskbusiness.co/admin/oews/status \
  -H "Authorization: Bearer <admin-session-token>"
```

The daily scheduled job also checks whether the cache is stale and attempts a refresh.

## Official sources

- BLS OEWS tables: https://www.bls.gov/oes/tables.htm
- BLS OEWS time-series files: https://download.bls.gov/pub/time.series/oe/
- Current state OEWS ZIP path used by BLS: https://www.bls.gov/oes/special-requests/oesm25st.zip

## Why this is not a separate API

OEWS wage rows are static reference data. Keeping them in `desk-api` avoids another service, keeps market research fast, and lets the existing admin table view show import runs and cached rows.
