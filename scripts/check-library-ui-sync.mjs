// The API Library's web pages (library-ui/) are a COPY of the desk_business web app (web_app/public) with a short,
// known list of differences: the name, where sign-in leads, same-origin API, and no business pages. This check applies
// exactly those differences to the web app's files and compares the result with library-ui/, so any other drift
// (a fix made in one place and forgotten in the other) is found.
//
//   node scripts/check-library-ui-sync.mjs                       # compare (exit 1 on drift)
//   node scripts/check-library-ui-sync.mjs --fix                 # rewrite library-ui/ from the web app
//   node scripts/check-library-ui-sync.mjs --web <dir> --lib <dir>
//
// If a difference below stops matching (because the web app's file changed there), the check says so: update the rule.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const fix = args.includes('--fix');
const WEB = path.resolve(opt('--web', 'C:/Users/User/desk_business/web_app/public'));
const LIB = path.resolve(opt('--lib', path.join(process.cwd(), 'library-ui')));

/** Web-app files that are shared with the library site, and what differs (each `from` must occur). */
const RULES = {
  'style.css': [],
  'desk_logo.png': [],
  'fonts/inter-latin-wght-normal.woff2': [],
  'fonts/inter-latin-ext-wght-normal.woff2': [],
  'fonts/OFL-Inter-LICENSE.txt': [],
  'pages/developer.js': [],
  'index.html': [['<title>Desk Business</title>', '<title>Desk API Library</title>']],
  'pages/auth.js': [
    ["signIn: 'Start and run your business in minutes.',", "signIn: 'Build on business data with your own API keys.',"],
    ["navigate(takeReturnPath() || '/businesses', { replace: true });", "navigate(takeReturnPath() || '/developer', { replace: true });"],
    ['<h1>Desk <span class="brand-business">Business</span></h1>', '<h1>Desk <span class="brand-business">API Library</span></h1>'],
  ],
  'app.js': [
    [`export const API_BASE = IS_LOCAL_DEV
  ? (window.__DESK_API_BASE__ ?? '')
  : 'https://api.deskbusiness.co';`, `// This copy is served by desk-api itself (api.deskbusiness.co), so the API is
// same-origin: relative URLs, and the session cookie is first-party.
export const API_BASE = '';`],
    ["  navigate('/businesses', { replace: true });\n}", "  navigate('/developer', { replace: true });\n}"],
    ["const path = url.pathname === '/' ? '/businesses' : url.pathname;", "const path = url.pathname === '/' ? '/developer' : url.pathname;"],
    ["return navigate(takeReturnPath() || '/businesses', { replace: true });", "return navigate(takeReturnPath() || '/developer', { replace: true });"],
    ["      } else if (path === '/admin/tables' && !isAdminEmail(state.user.email)) {\n        return navigate('/businesses', { replace: true });", "      } else if (path === '/admin/tables' && !isAdminEmail(state.user.email)) {\n        return navigate('/developer', { replace: true });"],
    ["  backBtn.hidden = path !== '/businesses/setup' && path !== '/admin/tables' && path !== '/developer' && path !== '/account/sessions';", "  // The API Library is this site's only signed-in page: nothing to go back to.\n  backBtn.hidden = true;"],
    ["  const showSwitchBusiness = path !== '/businesses';\n  const showApiLibrary = path !== '/developer';\n  const showDevices = path !== '/account/sessions';", "  const showSwitchBusiness = false; // no business pages on this site\n  const showApiLibrary = false; // already on it"],
    ["        ${showDevices ? `<button type=\"button\" class=\"profile-item\" id=\"devices-item\">${icon('devices')} Signed-in devices</button>` : ''}\n", ''],
    ["  const devicesItem = document.getElementById('devices-item');\n  if (devicesItem) devicesItem.addEventListener('click', () => { dropdown.hidden = true; navigate('/account/sessions'); });\n", ''],
    ['  devices: \'<rect x="2" y="4" width="14" height="10" rx="1.5"/><path d="M6 18h6M9 14v4"/><rect x="18" y="8" width="4" height="11" rx="1"/>\',\n', ''],
    ["    import('./pages/reset-password.js'),\n    import('./pages/confirm-email.js'),\n    import('./pages/businesses.js'),\n    import('./pages/setup-wizard.js'),\n    import('./pages/admin-tables.js'),\n", ''],
    ["    import('./pages/sessions.js'),\n", ''],
  ],
};

function listFiles(dir, prefix = '') {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full, `${prefix}${name}/`) : [`${prefix}${name}`];
  });
}

const problems = [];
const expected = new Map();
for (const [file, rules] of Object.entries(RULES)) {
  const src = path.join(WEB, file);
  if (!existsSync(src)) { problems.push(`${file}: missing from the web app (${src})`); continue; }
  const isText = !/\.(png|woff2)$/.test(file);
  let content = isText ? readFileSync(src, 'utf8') : readFileSync(src);
  for (const [from, to] of rules) {
    if (!content.includes(from)) { problems.push(`${file}: a rule no longer matches the web app's file (update the rule): ${JSON.stringify(from.slice(0, 80))}`); continue; }
    content = content.replace(from, () => to);
  }
  expected.set(file, content);
}

for (const [file, content] of expected) {
  const dest = path.join(LIB, file);
  if (fix) { mkdirSync(path.dirname(dest), { recursive: true }); writeFileSync(dest, content); continue; }
  if (!existsSync(dest)) { problems.push(`${file}: missing from library-ui`); continue; }
  const actual = /\.(png|woff2)$/.test(file) ? readFileSync(dest) : readFileSync(dest, 'utf8');
  const same = typeof content === 'string' ? content.replace(/\r\n/g, '\n') === actual.replace(/\r\n/g, '\n') : Buffer.compare(content, actual) === 0;
  if (!same) problems.push(`${file}: library-ui differs from the web app beyond the known differences`);
}
if (!fix) {
  for (const file of listFiles(LIB)) if (!expected.has(file)) problems.push(`${file}: in library-ui but not covered by a rule (a page that is not shared?)`);
}

if (fix) console.log(`library-ui rewritten from ${WEB} (${expected.size} files).`);
else if (problems.length === 0) console.log(`library-ui matches the web app apart from the ${Object.values(RULES).flat().length} known differences (${expected.size} files checked).`);
else { console.error(problems.map((p) => `  - ${p}`).join('\n')); console.error(`\n${problems.length} problem(s). Fix the drift, or run with --fix to copy the web app's files over library-ui.`); process.exit(1); }
