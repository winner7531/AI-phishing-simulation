const Database = require('better-sqlite3');
const config = require('./config');

const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    employee_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    position TEXT,
    department TEXT
  );
  CREATE TABLE IF NOT EXISTS simulation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT,
    factor TEXT,
    difficulty INTEGER,
    template_id TEXT,
    campaign_id INTEGER,
    technique TEXT,
    scenario TEXT,
    launched_at TEXT,
    outcome TEXT,
    outcome_updated_at TEXT,
    email TEXT,
    first_name TEXT,
    last_name TEXT,
    position TEXT,
    raw_status TEXT,
    last_checked TEXT,
    reasoning TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (employee_id) REFERENCES employees(employee_id)
  );
  CREATE INDEX IF NOT EXISTS idx_simulation_history_employee ON simulation_history(employee_id);
  CREATE INDEX IF NOT EXISTS idx_simulation_history_launched_at ON simulation_history(launched_at);
  CREATE TABLE IF NOT EXISTS pending_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    decision_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pending_decisions_employee ON pending_decisions(employee_id);
`);

function historyColumns() {
  return db.prepare(`PRAGMA table_info(simulation_history)`).all();
}

function migrateSimulationHistorySchema() {
  let columns = historyColumns();
  const names = new Set(columns.map(column => column.name));

  // The original send-workflow schema made employee_id NOT NULL. Result rows
  // must support unmatched GoPhish emails, so migrate it transactionally while
  // copying every existing row. No existing history is discarded.
  const employeeIdColumn = columns.find(column => column.name === 'employee_id');
  if (employeeIdColumn?.notnull === 1) {
    const desiredColumns = [
      'id', 'employee_id', 'factor', 'difficulty', 'template_id', 'campaign_id',
      'technique', 'scenario', 'launched_at', 'outcome', 'outcome_updated_at',
      'email', 'first_name', 'last_name', 'position', 'raw_status', 'last_checked', 'reasoning', 'completed',
    ];
    const expressions = desiredColumns.map(name => {
      if (names.has(name)) return `"${name}"`;
      return name === 'completed' ? '0' : 'NULL';
    });

    db.exec('DROP INDEX IF EXISTS idx_simulation_history_employee; DROP INDEX IF EXISTS idx_simulation_history_launched_at;');
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE simulation_history_migrated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id TEXT,
          factor TEXT,
          difficulty INTEGER,
          template_id TEXT,
          campaign_id INTEGER,
          technique TEXT,
          scenario TEXT,
          launched_at TEXT,
          outcome TEXT,
          outcome_updated_at TEXT,
          email TEXT,
          first_name TEXT,
          last_name TEXT,
          position TEXT,
          raw_status TEXT,
          last_checked TEXT,
          reasoning TEXT,
          completed INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (employee_id) REFERENCES employees(employee_id)
        )
      `);
      db.prepare(`
        INSERT INTO simulation_history_migrated (${desiredColumns.map(name => `"${name}"`).join(', ')})
        SELECT ${expressions.join(', ')} FROM simulation_history
      `).run();
      db.exec('DROP TABLE simulation_history; ALTER TABLE simulation_history_migrated RENAME TO simulation_history;');
    });
    migrate();
    columns = historyColumns();
    names.clear();
    for (const column of columns) names.add(column.name);
  }

  const columnDefinitions = {
    email: 'TEXT', first_name: 'TEXT', last_name: 'TEXT', position: 'TEXT',
    raw_status: 'TEXT', last_checked: 'TEXT', reasoning: 'TEXT', completed: 'INTEGER NOT NULL DEFAULT 0',
  };
  for (const [name, definition] of Object.entries(columnDefinitions)) {
    if (!names.has(name)) db.exec(`ALTER TABLE simulation_history ADD COLUMN ${name} ${definition}`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_simulation_history_employee ON simulation_history(employee_id);
    CREATE INDEX IF NOT EXISTS idx_simulation_history_launched_at ON simulation_history(launched_at);
    CREATE INDEX IF NOT EXISTS idx_simulation_history_outcome_key
      ON simulation_history(campaign_id, email, outcome);
  `);
}

migrateSimulationHistorySchema();

function getEmployeesDueForSimulation() {
  return db.prepare(`
    SELECT e.*
    FROM employees e
    LEFT JOIN simulation_history h ON h.employee_id = e.employee_id
    GROUP BY e.employee_id
    HAVING MAX(h.launched_at) IS NULL
       OR julianday(MAX(h.launched_at)) <= julianday('now', ?)
    ORDER BY e.employee_id
  `).all(`-${config.dueAfterDays} days`);
}

function getSimulationHistoryFor(employeeId) {
  return db.prepare(`
    SELECT id, employee_id, email, first_name, last_name, position,
           factor, difficulty, template_id, campaign_id, technique, scenario,
           launched_at, outcome, raw_status, last_checked,
           COALESCE(reasoning, (SELECT h2.reasoning FROM simulation_history h2 WHERE h2.campaign_id = simulation_history.campaign_id AND h2.reasoning IS NOT NULL LIMIT 1)) AS reasoning,
           completed, outcome_updated_at
    FROM simulation_history WHERE employee_id = ? ORDER BY launched_at ASC, id ASC
  `).all(employeeId);
}

function getAllEmployees() {
  return db.prepare(`
    SELECT employee_id, email, first_name, last_name, position, department
    FROM employees ORDER BY employee_id ASC
  `).all();
}

function getEmployeeById(employeeId) {
  return db.prepare(`
    SELECT employee_id, email, first_name, last_name, position, department
    FROM employees WHERE employee_id = ? LIMIT 1
  `).get(employeeId);
}

function addEmployee(employee) {
  db.prepare(`
    INSERT INTO employees (employee_id, email, first_name, last_name, position, department)
    VALUES (@employee_id, @email, @first_name, @last_name, @position, @department)
  `).run(employee);
  return db.prepare(`SELECT * FROM employees WHERE employee_id = ?`).get(employee.employee_id);
}

function updateEmployee(originalEmployeeId, employee) {
  const update = db.transaction(() => {
    const migrationEmployeeId = `__employee_migration__${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (originalEmployeeId !== employee.employee_id) {
      db.prepare(`UPDATE simulation_history SET employee_id = ? WHERE employee_id = ?`)
        .run(migrationEmployeeId, originalEmployeeId);
    }
    db.prepare(`
      UPDATE employees
      SET employee_id = @employee_id, email = @email, first_name = @first_name,
          last_name = @last_name, position = @position, department = @department
      WHERE employee_id = @original_employee_id
    `).run({ ...employee, original_employee_id: originalEmployeeId });

    if (originalEmployeeId !== employee.employee_id) {
      db.prepare(`UPDATE simulation_history SET employee_id = ? WHERE employee_id = ?`)
        .run(employee.employee_id, migrationEmployeeId);
    }
    return db.prepare(`SELECT * FROM employees WHERE employee_id = ?`).get(employee.employee_id);
  });
  return update();
}

function deleteEmployee(employeeId) {
  const remove = db.transaction(() => {
    // Keep campaign history, but make it an unmatched historical record.
    db.prepare(`UPDATE simulation_history SET employee_id = NULL WHERE employee_id = ?`).run(employeeId);
    return db.prepare(`DELETE FROM employees WHERE employee_id = ?`).run(employeeId);
  });
  return remove();
}

function getHistoryFiltered({ employeeId, outcome } = {}) {
  const clauses = [];
  const values = [];
  if (employeeId) {
    clauses.push('employee_id = ?');
    values.push(employeeId);
  }
  if (outcome) {
    clauses.push('outcome = ?');
    values.push(outcome);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT id, employee_id, email, factor, difficulty, outcome, campaign_id,
           last_checked, completed, raw_status, first_name, last_name, position,
           template_id, technique, scenario, launched_at,
           COALESCE(reasoning, (SELECT h2.reasoning FROM simulation_history h2 WHERE h2.campaign_id = simulation_history.campaign_id AND h2.reasoning IS NOT NULL LIMIT 1)) AS reasoning,
           outcome_updated_at
    FROM simulation_history ${where}
    ORDER BY COALESCE(last_checked, launched_at) DESC, id DESC
  `).all(...values);
}

function markCampaignComplete(campaignId) {
  return db.prepare(`UPDATE simulation_history SET completed = 1 WHERE campaign_id = ?`).run(campaignId);
}

function getPendingDecisions() {
  return db.prepare(`
    SELECT p.id, p.batch_id, p.employee_id, p.decision_json, p.created_at,
           e.email, e.first_name, e.last_name, e.position, e.department
    FROM pending_decisions p
    LEFT JOIN employees e ON e.employee_id = p.employee_id
    ORDER BY p.created_at ASC, p.id ASC
  `).all().map(row => ({
    id: row.id,
    batch_id: row.batch_id,
    employee_id: row.employee_id,
    created_at: row.created_at,
    employee: {
      email: row.email, first_name: row.first_name, last_name: row.last_name,
      position: row.position, department: row.department,
    },
    decision: JSON.parse(row.decision_json),
  }));
}

function getPendingDecision(id) {
  const row = db.prepare(`
    SELECT p.id, p.batch_id, p.employee_id, p.decision_json, p.created_at,
           e.email, e.first_name, e.last_name, e.position, e.department
    FROM pending_decisions p
    LEFT JOIN employees e ON e.employee_id = p.employee_id
    WHERE p.id = ?
  `).get(id);
  if (!row) return undefined;
  return {
    id: row.id,
    batch_id: row.batch_id,
    employee_id: row.employee_id,
    created_at: row.created_at,
    employee: {
      email: row.email, first_name: row.first_name, last_name: row.last_name,
      position: row.position, department: row.department,
    },
    decision: JSON.parse(row.decision_json),
  };
}

function addPendingDecision({ batchId, employeeId, decision }) {
  const createdAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO pending_decisions (batch_id, employee_id, decision_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(batchId, employeeId, JSON.stringify(decision), createdAt);
  return { id: result.lastInsertRowid, batch_id: batchId, employee_id: employeeId, created_at: createdAt, decision };
}

function deletePendingDecision(id) {
  return db.prepare(`DELETE FROM pending_decisions WHERE id = ?`).run(id);
}

function getCampaignCompletionStates() {
  return db.prepare(`
    SELECT campaign_id, MAX(completed) AS completed, COUNT(*) AS row_count
    FROM simulation_history
    WHERE campaign_id IS NOT NULL
    GROUP BY campaign_id
  `).all();
}

function getEmployeeByEmail(email) {
  return db.prepare(`
    SELECT employee_id, email, first_name, last_name, position, department
    FROM employees WHERE email = ? LIMIT 1
  `).get(email);
}

function hasLoggedOutcome(campaignId, email, outcome) {
  return Boolean(db.prepare(`
    SELECT 1 FROM simulation_history
    WHERE campaign_id = ? AND email = ? AND outcome = ? LIMIT 1
  `).get(campaignId, email, outcome));
}

function recordResult(result) {
  const inserted = db.prepare(`
    INSERT INTO simulation_history
      (employee_id, factor, difficulty, template_id, campaign_id, technique, scenario,
       launched_at, outcome, email, first_name, last_name, position, raw_status, last_checked, reasoning)
    VALUES (@employee_id, @factor, @difficulty, @template_id, @campaign_id, @technique, @scenario,
            @launched_at, @outcome, @email, @first_name, @last_name, @position, @raw_status, @last_checked,
            (SELECT reasoning FROM simulation_history WHERE campaign_id = @campaign_id AND reasoning IS NOT NULL LIMIT 1))
  `).run({
    employee_id: result.employee_id ?? null,
    factor: result.factor ?? null,
    difficulty: result.difficulty ?? null,
    template_id: result.template_id ?? null,
    campaign_id: result.campaign_id,
    technique: result.technique ?? null,
    scenario: result.scenario ?? null,
    launched_at: result.launched_at ?? result.last_checked,
    outcome: result.outcome,
    email: result.email,
    first_name: result.first_name ?? null,
    last_name: result.last_name ?? null,
    position: result.position ?? null,
    raw_status: result.raw_status ?? null,
    last_checked: result.last_checked,
  });
  return { id: inserted.lastInsertRowid, ...result };
}

function recordLaunchedCampaign(campaign) {
  const result = db.prepare(`
    INSERT INTO simulation_history
      (employee_id, factor, difficulty, template_id, campaign_id, technique, scenario, launched_at, outcome, reasoning)
    VALUES (@employee_id, @factor, @difficulty, @template_id, @campaign_id, @technique, @scenario, @launched_at, NULL, @reasoning)
  `).run(campaign);
  return { id: result.lastInsertRowid, ...campaign, outcome: null };
}

function updateSimulationOutcome(id, outcome) {
  return db.prepare(`UPDATE simulation_history SET outcome = ?, outcome_updated_at = ? WHERE id = ?`)
    .run(outcome, new Date().toISOString(), id);
}

module.exports = {
  db, getEmployeesDueForSimulation, getSimulationHistoryFor, getAllEmployees, getEmployeeById,
  addEmployee, updateEmployee, deleteEmployee, getHistoryFiltered, getEmployeeByEmail,
  hasLoggedOutcome, recordResult, recordLaunchedCampaign, markCampaignComplete,
  getCampaignCompletionStates, getPendingDecisions, getPendingDecision,
  addPendingDecision, deletePendingDecision, updateSimulationOutcome,
};
