const {
  getEmployeeByEmail,
  hasLoggedOutcome,
  recordResult,
  markCampaignComplete,
} = require('./db');
const {
  getCampaigns,
  getCampaignResults,
  completeCampaign,
} = require('./gophish');

const TERMINAL_OUTCOMES = new Set(['clicked', 'submitted', 'reported']);

function mapOutcome(status) {
  return {
    'Clicked Link': 'clicked',
    'Submitted Data': 'submitted',
    'Email Reported': 'reported',
    'Email Opened': 'opened',
    'Email Sent': 'sent_no_action',
  }[status] || 'unknown';
}

function parseCampaignName(name) {
  const match = /^camp_(.+)_([^_]+)_([^_]+)_([^_]+)$/.exec(String(name || ''));
  if (!match) throw new Error(`Campaign name does not match camp_<employee_id>_<factor>_<difficulty>_<timestamp>: ${name}`);
  return { employeeIdFromName: match[1], factor: match[2], difficulty: match[3], timestamp: match[4] };
}

function normalizeResults(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  throw new Error('GoPhish campaign results response did not contain a results array');
}

async function pollResults({ returnSummary = false } = {}) {
  let campaigns;
  try {
    campaigns = await getCampaigns();
  } catch (error) {
    console.error(new Date().toISOString(), JSON.stringify({ level: 'error', step: 'fetch campaigns', message: error.message }));
    return returnSummary ? { campaignsChecked: 0, logged: 0, results: [] } : [];
  }

  if (!Array.isArray(campaigns)) {
    console.error(new Date().toISOString(), JSON.stringify({ level: 'error', step: 'fetch campaigns', message: 'GoPhish campaigns response was not an array' }));
    return returnSummary ? { campaignsChecked: 0, logged: 0, results: [] } : [];
  }

  const logged = [];
  let campaignsChecked = 0;
  for (const campaign of campaigns) {
    const campaignId = campaign?.id;
    if (String(campaign?.status || '').toLowerCase() === 'completed') continue;
    campaignsChecked += 1;

    let parsed;
    try {
      parsed = parseCampaignName(campaign.name);
    } catch (error) {
      console.error(new Date().toISOString(), JSON.stringify({ level: 'error', campaign_id: campaignId, step: 'parse campaign name', message: error.message }));
      continue;
    }

    let results;
    try {
      // The supplied n8n flow fetched this endpoint after listing campaigns.
      results = normalizeResults(await getCampaignResults(campaignId));
    } catch (error) {
      console.error(new Date().toISOString(), JSON.stringify({ level: 'error', campaign_id: campaignId, step: 'fetch campaign results', message: error.message }));
      continue;
    }

    let completionRequested = false;
    for (const result of results) {
      const email = result?.email;
      try {
        if (!email) throw new Error('GoPhish result has no email');
        const outcome = mapOutcome(result.status);
        if (hasLoggedOutcome(campaignId, email, outcome)) continue;

        const employee = getEmployeeByEmail(email);
        const lastChecked = new Date().toISOString();
        const row = recordResult({
          employee_id: employee?.employee_id ?? null,
          campaign_id: campaignId,
          email,
          first_name: result.first_name,
          last_name: result.last_name,
          position: result.position,
          factor: parsed.factor,
          difficulty: parsed.difficulty,
          template_id: campaign.template?.id ?? campaign.template?.name,
          technique: null,
          scenario: null,
          launched_at: campaign.launch_date || lastChecked,
          outcome,
          raw_status: result.status,
          last_checked: lastChecked,
        });
        logged.push(row);

        if (TERMINAL_OUTCOMES.has(outcome) && !completionRequested) {
          completionRequested = true;
          try {
            await completeCampaign(campaignId);
            // Keep SQLite aligned only after GoPhish confirms completion.
            markCampaignComplete(campaignId);
          } catch (error) {
            console.error(new Date().toISOString(), JSON.stringify({ level: 'error', campaign_id: campaignId, email, step: 'complete campaign', message: error.message }));
          }
        }
      } catch (error) {
        console.error(new Date().toISOString(), JSON.stringify({ level: 'error', campaign_id: campaignId, email, step: 'process result', message: error.message, stack: error.stack }));
      }
    }
  }
  console.log(new Date().toISOString(), `Results poll complete: recorded ${logged.length} new outcome(s)`);
  return returnSummary ? { campaignsChecked, logged: logged.length, results: logged } : logged;
}

module.exports = { pollResults, mapOutcome, parseCampaignName };
