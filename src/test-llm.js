'use strict';
// Verify the LLM (Azure OpenAI or OpenAI) grounding works end-to-end.
// Run: npm run test:llm   (makes one small real call)
const config = require('./config');
const { groundNarration } = require('./grounding');

const sampleProjects = [
  { projectId: 'P-DM', name: 'ProcessX TranXform Project (DM)', tasks: [
    { taskId: 'T-VAL', name: 'Validation' }, { taskId: 'T-MTG', name: 'Project Meetings' } ] },
  { projectId: 'P-CL', name: 'ProcessX AI Clinical', tasks: [
    { taskId: 'T-GOV', name: 'Governance' }, { taskId: 'T-PM', name: 'Project Meetings' } ] },
];
const narration = '3 hours on validation for the DM project today and 2 meetings on AI clinical governance';

(async () => {
  const provider = config.llm.azureEndpoint ? `Azure OpenAI (deployment="${config.llm.azureDeployment}", api=${config.llm.azureApiVersion})`
    : config.llm.openaiApiKey ? `OpenAI (${config.llm.openaiModel})` : 'NONE';
  console.log('LLM provider:', provider);
  if (provider === 'NONE') { console.error('❌ No LLM configured. Set AZURE_OPENAI_* or OPENAI_API_KEY in .env.'); process.exit(1); }
  console.log('Narration:', JSON.stringify(narration), '\n');
  try {
    const r = await groundNarration(narration, sampleProjects);
    if (r.error) throw new Error(r.error);
    console.log('PASS - grounding returned', r.entries.length, 'entries:');
    for (const e of r.entries) {
      console.log(`  • ${e.projectName} / ${e.taskName} — ${e.durationMin} min  (conf ${e.confidence}${e.needsConfirmation ? ', NEEDS CONFIRMATION: ' + e.issues.join('; ') : ''})`);
    }
    console.log('\n✅ LLM grounding works.');
  } catch (err) {
    console.error('\n❌ FAIL -', err.message);
    console.error('Check AZURE_OPENAI_ENDPOINT/KEY/DEPLOYMENT and that the deployment supports JSON mode.');
    process.exit(1);
  }
})();
