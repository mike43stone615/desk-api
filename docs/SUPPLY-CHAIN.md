# What we ship, and what we check

- **Bill of materials**: `npm run sbom` writes `sbom.cdx.json` (CycloneDX) listing every production dependency and its
  licence, and fails if one is copyleft (GPL, AGPL, SSPL, BUSL) or has no licence. September 2026: 251 production
  components, all permissive (125 MIT, 90 Apache-2.0, 18 ISC, 13 BSD-3-Clause, 4 BlueOak-1.0.0, 1 BSD-2-Clause).
- **Known vulnerabilities**: `npm audit --omit=dev` (run before a release; the CI test job runs it too).
- **Secrets in the repository and its history**: `npm run scan:secrets -- <repo> [<repo> ...]` scans the files and every
  commit for private keys, API keys and tokens, and database passwords, printing where and what kind, never the secret.
  September 2026 result for all six repositories: clean, apart from **one real finding**: a Google Static Maps API key
  that had been committed in `desk_business/.vscode/launch.json` (now removed from the file; it remains in history, so
  rotate or restrict that key in the Google Cloud console). Reviewed and judged harmless: throwaway `postgres` passwords in
  CI service containers and a placeholder test key; and the retired local Docker stack's own database password (not any
  live database's).
- **Pinned tools**: Node 24 (`engines`, `.node-version`, and both workflows), dependencies pinned by `package-lock.json`,
  installed with `npm ci`.
