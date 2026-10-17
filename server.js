const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const config = require('./config');
const {
  getAllEmployees,
  addEmployee,
  updateEmployee,
  deleteEmployee,
  getHistoryFiltered,
  getSimulationHistoryFor,
  getEmployeeById,
  markCampaignComplete,
  getCampaignCompletionStates,
  getPendingDecisions,
  getPendingDecision,
  addPendingDecision,
  deletePendingDecision,
} = require('./db');
const { completeCampaign, getCampaigns } = require('./gophish');
const { launchEmployeeSimulationWithDecision, prepareSelectedEmployees } = require('./run');
const { pollResults } = require('./results-poller');
const { TEMPLATE_LIBRARY } = require('./ai-decision');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function validateEmployee(body) {
  const employee = {
    employee_id: String(body?.employee_id || '').trim(),
    email: String(body?.email || '').trim(),
    first_name: String(body?.first_name || '').trim(),
    last_name: String(body?.last_name || '').trim(),
    position: String(body?.position || '').trim(),
    department: String(body?.department || '').trim(),
  };
  if (!employee.employee_id) throw new Error('employee_id is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employee.email)) throw new Error('A valid email is required');
  if (!employee.first_name) throw new Error('first_name is required');
  if (!employee.last_name) throw new Error('last_name is required');
  if (!departments.includes(employee.department)) throw new Error(`department must be one of: ${departments.join(', ')}`);
  return employee;
}

function sendError(response, error, status = 400) {
  const duplicate = error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE';
  response.status(duplicate ? 409 : status).json({ error: duplicate ? 'employee_id already exists' : error.message });
}

const departments = [...new Set(TEMPLATE_LIBRARY.map(template => template.department))].sort();

async function reconcileCampaignCompletion() {
  const campaigns = await getCampaigns();
  const localStates = new Map(getCampaignCompletionStates().map(row => [String(row.campaign_id), row]));
  const remoteIds = new Set();
  const mismatches = [];

  for (const campaign of campaigns) {
    const campaignId = String(campaign.id);
    remoteIds.add(campaignId);
    const local = localStates.get(campaignId);
    if (!local) continue;
    const remoteCompleted = String(campaign.status || '').toLowerCase() === 'completed';
    const localCompleted = Number(local.completed) === 1;
    if (localCompleted !== remoteCompleted) {
      const mismatch = {
        campaign_id: campaign.id,
        local_completed: localCompleted,
        gophish_status: campaign.status,
        row_count: local.row_count,
      };
      mismatches.push(mismatch);
      console.error(new Date().toISOString(), JSON.stringify({ level: 'warn', type: 'completion_status_mismatch', ...mismatch }));
    }
  }

  for (const [campaignId, local] of localStates) {
    if (!remoteIds.has(campaignId)) {
      const mismatch = {
        campaign_id: campaignId,
        local_completed: Number(local.completed) === 1,
        gophish_status: 'campaign not returned by GoPhish',
        row_count: local.row_count,
      };
      mismatches.push(mismatch);
      console.error(new Date().toISOString(), JSON.stringify({ level: 'warn', type: 'completion_status_mismatch', ...mismatch }));
    }
  }
  return { campaigns_checked: campaigns.length, mismatches };
}

app.get('/api/employees', (_request, response) => response.json(getAllEmployees()));

app.get('/api/departments', (_request, response) => response.json(departments));

app.post('/api/employees', (request, response) => {
  try { response.status(201).json(addEmployee(validateEmployee(request.body))); }
  catch (error) { sendError(response, error); }
});

app.put('/api/employees/:id', (request, response) => {
  try {
    const employee = validateEmployee(request.body);
    const updated = updateEmployee(request.params.id, employee);
    if (!updated) return response.status(404).json({ error: 'Employee not found' });
    return response.json(updated);
  } catch (error) { return sendError(response, error); }
});

app.delete('/api/employees/:id', (request, response) => {
  try {
    const result = deleteEmployee(request.params.id);
    if (!result.changes) return response.status(404).json({ error: 'Employee not found' });
    return response.status(204).send();
  } catch (error) { return sendError(response, error, 500); }
});

app.get('/api/history', (request, response) => {
  try {
    return response.json(getHistoryFiltered({ employeeId: request.query.employee_id, outcome: request.query.outcome }));
  } catch (error) { return sendError(response, error, 500); }
});

app.get('/api/employees/:id/history', (request, response) => {
  try { return response.json(getSimulationHistoryFor(request.params.id)); }
  catch (error) { return sendError(response, error, 500); }
});

app.get('/api/pending-decisions', (_request, response) => {
  try { return response.json(getPendingDecisions()); }
  catch (error) { return sendError(response, error, 500); }
});

app.post('/api/pending-decisions/:id/approve', async (request, response) => {
  const pendingId = request.params.id;
  try {
    const pending = getPendingDecision(pendingId);
    if (!pending) return response.status(404).json({ error: 'Pending decision not found' });
    const employee = getEmployeeById(pending.employee_id);
    if (!employee) return response.status(409).json({ error: `Employee ${pending.employee_id} no longer exists` });
    const launched = await launchEmployeeSimulationWithDecision(employee, pending.decision);
    deletePendingDecision(pendingId);
    return response.json({
      status: 'success', employee_id: employee.employee_id, employee_name: `${employee.first_name} ${employee.last_name}`,
      factor: launched.decision.factor, difficulty: launched.decision.difficulty,
      template_id: launched.decision.template_id, campaign_id: launched.campaign.id,
    });
  } catch (error) {
    console.error(new Date().toISOString(), JSON.stringify({ level: 'error', pending_decision_id: pendingId, step: error.step || 'approve pending decision', message: error.message }));
    return sendError(response, error, 502);
  }
});

app.post('/api/pending-decisions/:id/reject', (request, response) => {
  try {
    const result = deletePendingDecision(request.params.id);
    if (!result.changes) return response.status(404).json({ error: 'Pending decision not found' });
    return response.json({ status: 'rejected', id: request.params.id });
  } catch (error) { return sendError(response, error, 500); }
});

app.post('/api/campaigns/:campaignId/complete', async (request, response) => {
  const campaignId = request.params.campaignId;
  try {
    await completeCampaign(campaignId);
    const result = markCampaignComplete(campaignId);
    return response.json({ campaign_id: campaignId, completed: true, rows_updated: result.changes });
  } catch (error) {
    console.error(new Date().toISOString(), JSON.stringify({
      level: 'error', campaign_id: campaignId, step: 'mark campaign complete', message: error.message,
    }));
    return response.status(error.status === 404 ? 404 : 502).json({
      error: `GoPhish could not mark campaign ${campaignId} complete: ${error.message}`,
    });
  }
});

app.get('/api/campaigns/reconcile', async (_request, response) => {
  try {
    return response.json(await reconcileCampaignCompletion());
  } catch (error) {
    console.error(new Date().toISOString(), JSON.stringify({ level: 'error', step: 'reconcile campaign completion', message: error.message }));
    return sendError(response, error, 502);
  }
});

app.post('/api/simulations/launch', async (request, response) => {
  const employeeIds = request.body?.employee_ids;
  if (!Array.isArray(employeeIds) || employeeIds.length === 0 || employeeIds.some(id => typeof id !== 'string' || !id.trim())) {
    return response.status(400).json({ error: 'employee_ids must be a non-empty array of employee ID strings' });
  }
  try {
    const batchId = randomUUID();
    const prepared = await prepareSelectedEmployees([...new Set(employeeIds.map(id => id.trim()))]);
    const results = prepared.map(result => {
      if (result.status !== 'decision_ready') return result;
      const pending = addPendingDecision({ batchId, employeeId: result.employee_id, decision: result.decision });
      return { ...result, status: 'awaiting_review', pending_decision_id: pending.id };
    });
    return response.json({ batch_id: batchId, results });
  } catch (error) {
    console.error(new Date().toISOString(), JSON.stringify({ level: 'error', step: 'manual simulation launch', message: error.message }));
    return sendError(response, error, 500);
  }
});

app.post('/api/results/poll-now', async (_request, response) => {
  try {
    const summary = await pollResults({ returnSummary: true });
    return response.json({ campaigns_checked: summary.campaignsChecked, logged: summary.logged });
  } catch (error) {
    console.error(new Date().toISOString(), JSON.stringify({ level: 'error', step: 'manual results poll', message: error.message }));
    return sendError(response, error, 502);
  }
});

app.get(/.*/, (_request, response) => response.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(config.port, '127.0.0.1', () => {
  console.log(`Employee admin UI running at http://127.0.0.1:${config.port}`);
  reconcileCampaignCompletion().catch(error => {
    console.error(new Date().toISOString(), JSON.stringify({ level: 'error', step: 'startup campaign reconciliation', message: error.message }));
  });
});
