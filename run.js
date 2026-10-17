const { getEmployeesDueForSimulation, getSimulationHistoryFor, recordLaunchedCampaign, getEmployeeById } = require('./db');
const { decideSimulationParams } = require('./ai-decision');
const { createGroup, launchCampaign } = require('./gophish');

async function decideEmployeeSimulation(employee) {
  let history;
  try {
    history = getSimulationHistoryFor(employee.employee_id);
  } catch (error) {
    error.step = 'load employee history';
    throw error;
  }

  let decision;
  try {
    decision = await decideSimulationParams(employee, history);
  } catch (error) {
    error.step = 'AI decision';
    throw error;
  }

  return decision;
}

async function launchEmployeeSimulationWithDecision(employee, decision) {
  let group;
  try {
    group = await createGroup(employee);
  } catch (error) {
    error.step = 'GoPhish group creation';
    throw error;
  }

  let campaign;
  try {
    campaign = await launchCampaign({ employee, decision, groupName: group.name });
  } catch (error) {
    error.step = 'GoPhish campaign creation';
    throw error;
  }

  let row;
  try {
    row = recordLaunchedCampaign({
      employee_id: employee.employee_id, factor: decision.factor, difficulty: decision.difficulty,
      template_id: decision.template_id, campaign_id: String(campaign.id), technique: decision.technique,
      scenario: decision.scenario, reasoning: decision.reasoning,
      launched_at: campaign.launch_date || new Date().toISOString(),
    });
  } catch (error) {
    error.step = 'record launched campaign';
    throw error;
  }

  return { employee, decision, campaign, row };
}

async function launchEmployeeSimulation(employee) {
  const decision = await decideEmployeeSimulation(employee);
  return launchEmployeeSimulationWithDecision(employee, decision);
}

async function runSimulationCycle() {
  const employees = getEmployeesDueForSimulation();
  console.log(new Date().toISOString(), `Starting simulation run for ${employees.length} employee(s)`);
  const results = [];
  for (const employee of employees) {
    try {
      const launched = await launchEmployeeSimulation(employee);
      results.push(launched.row);
      console.log(new Date().toISOString(), JSON.stringify({ level: 'info', employee_id: employee.employee_id, step: 'completed', campaign_id: launched.campaign.id }));
    } catch (error) {
      console.error(new Date().toISOString(), JSON.stringify({ level: 'error', employee_id: employee.employee_id, step: error.step || 'employee pipeline', message: error.message, stack: error.stack }));
    }
  }
  return results;
}

async function prepareSelectedEmployees(employeeIds) {
  const results = [];
  for (const employeeId of employeeIds) {
    let employee;
    try {
      employee = getEmployeeById(employeeId);
    } catch (error) {
      results.push({ employee_id: employeeId, status: 'failure', step: 'load employee', error: error.message });
      console.error(new Date().toISOString(), JSON.stringify({ level: 'error', employee_id: employeeId, step: 'load employee', message: error.message, stack: error.stack }));
      continue;
    }
    if (!employee) {
      results.push({ employee_id: employeeId, status: 'failure', error: 'Employee not found' });
      continue;
    }
    try {
      const decision = await decideEmployeeSimulation(employee);
      results.push({
        employee_id: employee.employee_id,
        employee_name: `${employee.first_name} ${employee.last_name}`,
        status: 'decision_ready',
        decision,
      });
    } catch (error) {
      results.push({
        employee_id: employee.employee_id,
        employee_name: `${employee.first_name} ${employee.last_name}`,
        status: 'failure',
        step: error.step || 'employee pipeline',
        error: error.message,
      });
      console.error(new Date().toISOString(), JSON.stringify({ level: 'error', employee_id: employee.employee_id, step: error.step || 'employee pipeline', message: error.message, stack: error.stack }));
    }
  }
  return results;
}

module.exports = {
  runSimulationCycle,
  decideEmployeeSimulation,
  launchEmployeeSimulation,
  launchEmployeeSimulationWithDecision,
  prepareSelectedEmployees,
};
