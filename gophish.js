const { Agent } = require('undici');
const config = require('./config');
const { withRetries } = require('./retry');

const dispatcher = config.gophishBaseUrl.startsWith('https:')
  ? new Agent({ connect: { rejectUnauthorized: config.gophishRejectUnauthorized } }) : undefined;

async function request(method, path, body) {
  const response = await fetch(`${config.gophishBaseUrl}${path}`, {
    method,
    headers: { Authorization: config.gophishApiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(dispatcher ? { dispatcher } : {}),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!response.ok) {
    const error = new Error(`GoPhish ${method} ${path} failed (${response.status}): ${text}`);
    error.status = response.status;
    throw error;
  }
  return parsed;
}

function goRequest(method, path, body, context) {
  return withRetries(() => request(method, path, body), {
    attempts: config.retryAttempts,
    baseDelayMs: config.retryBaseDelayMs,
    onRetry: (error, attempt, delay) => console.error(new Date().toISOString(), JSON.stringify({
      level: 'warn', employee_id: context?.employee_id, step: context?.step,
      message: error.message, retry: attempt, delay_ms: delay,
    })),
  });
}

async function createGroup(employee) {
  return goRequest('POST', '/groups/', {
    name: `grp_${employee.employee_id}_${Date.now()}`,
    targets: [{ email: employee.email, first_name: employee.first_name, last_name: employee.last_name, position: employee.position || '' }],
  }, { employee_id: employee.employee_id, step: 'create group' });
}

async function launchCampaign({ employee, decision, groupName }) {
  const launchDate = new Date(Date.now() + config.launchDelayMinutes * 60_000).toISOString();
  const campaignName = `camp_${employee.employee_id}_${decision.factor}_${decision.difficulty}_${Date.now()}`;
  const response = await goRequest('POST', '/campaigns/', {
    name: campaignName,
    template: { name: decision.template_id },
    page: { name: config.defaultLandingPageName },
    smtp: { name: config.sendingProfileName },
    groups: [{ name: groupName }],
    url: process.env.GOPHISH_CAMPAIGN_URL || 'http://127.0.0.1',
    launch_date: launchDate,
  }, { employee_id: employee.employee_id, step: 'launch campaign' });
  return { ...response, launch_date: launchDate };
}

async function getCampaigns() {
  return goRequest('GET', '/campaigns/', undefined, { step: 'fetch campaigns' });
}

async function getCampaignResults(campaignId) {
  return goRequest('GET', `/campaigns/${encodeURIComponent(campaignId)}/results`, undefined,
    { campaign_id: campaignId, step: 'fetch campaign results' });
}

async function completeCampaign(campaignId) {
  return goRequest('GET', `/campaigns/${encodeURIComponent(campaignId)}/complete`, undefined,
    { campaign_id: campaignId, step: 'complete campaign' });
}

module.exports = { createGroup, launchCampaign, getCampaigns, getCampaignResults, completeCampaign };
