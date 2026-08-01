#!/usr/bin/env node
import { readFileSync } from "node:fs";

const REQUIRED_COLUMNS = [
  "dataset_year",
  "area_code",
  "area_name",
  "state_code",
  "occupation_code",
  "occupation_title",
  "employment",
  "hourly_mean_wage",
  "annual_mean_wage",
  "hourly_median_wage",
  "annual_median_wage",
  "source_url",
];

const STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA",
  "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
  "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX",
  "UT", "VT", "VA", "WA", "WV", "WI", "WY", "PR", "GU", "VI",
]);

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node scripts/validate-oews-compact.mjs <state-all-occupations.tsv>");
  process.exit(1);
}

const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
if (lines.length < 2) fail("The file needs a header row and at least one data row.");

const headers = lines[0].split("\t");
const missingColumns = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
if (missingColumns.length > 0) {
  fail(`Missing required column(s): ${missingColumns.join(", ")}`);
}

const index = Object.fromEntries(headers.map((header, i) => [header, i]));
const seenStates = new Set();
const errors = [];

for (let lineNumber = 2; lineNumber <= lines.length; lineNumber += 1) {
  const cells = lines[lineNumber - 1].split("\t");
  const row = (column) => cells[index[column]]?.trim() ?? "";
  const state = row("state_code").toUpperCase();
  const datasetYear = Number(row("dataset_year"));
  const occupationCode = row("occupation_code") || "00-0000";

  if (!Number.isInteger(datasetYear) || datasetYear < 2000) {
    errors.push(`line ${lineNumber}: dataset_year must be a four-digit year`);
  }
  if (!STATE_CODES.has(state)) {
    errors.push(`line ${lineNumber}: state_code must be a U.S. state, DC, or territory abbreviation`);
  }
  if (occupationCode !== "00-0000") {
    errors.push(`line ${lineNumber}: occupation_code must be 00-0000 for this compact cache`);
  }
  if (!row("area_code")) errors.push(`line ${lineNumber}: area_code is required`);
  if (!row("area_name")) errors.push(`line ${lineNumber}: area_name is required`);
  if (!row("annual_mean_wage")) errors.push(`line ${lineNumber}: annual_mean_wage is required`);

  for (const column of ["employment", "hourly_mean_wage", "annual_mean_wage", "hourly_median_wage", "annual_median_wage"]) {
    const value = row(column);
    if (value && !Number.isFinite(Number(value))) {
      errors.push(`line ${lineNumber}: ${column} must be numeric or empty`);
    }
  }

  if (state) seenStates.add(state);
}

if (errors.length > 0) {
  for (const error of errors.slice(0, 30)) console.error(error);
  if (errors.length > 30) console.error(`...and ${errors.length - 30} more error(s)`);
  process.exit(1);
}

console.log(`OEWS compact file is valid: ${lines.length - 1} row(s), ${seenStates.size} state/territory code(s).`);
if (seenStates.size < STATE_CODES.size) {
  const missingStates = [...STATE_CODES].filter((state) => !seenStates.has(state));
  console.warn(`Missing state/territory code(s): ${missingStates.join(", ")}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

