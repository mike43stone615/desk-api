// node samples/02-market-analysis.mjs "Mobile dog grooming van" FL
import { call, fail } from './_client.mjs';

const [idea = 'Mobile dog grooming van for apartment communities', state = 'FL'] = process.argv.slice(2);
const r = await call('POST', '/v1/gateway/market/research/analyze', { businessIdea: idea, formationState: state });
if (r.status === 429 && r.json?.code === 'market_analysis_daily_cap') {
  console.error('This key has used its market analyses for today. Ask for a higher limit or try tomorrow.');
  process.exit(1);
}
if (r.status !== 200) fail(r);
console.log(`Overall score: ${r.json.overallScore} (confidence: ${r.json.confidence})`);
console.log(r.json.summary);
for (const flag of r.json.riskFlags ?? []) console.log(` - ${flag}`);
