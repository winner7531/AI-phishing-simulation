# Phishing Simulation Platform

A local phishing-awareness simulation platform that uses AI-assisted scenario selection, GoPhish campaign orchestration, SQLite-based employee and campaign history, scheduled result polling, and a browser-based administration interface.

The current application is implemented entirely in Node.js. n8n was used during the original development phase to connect employee data and the GoPhish API and to prototype the deterministic workflow and AI decision flow. That n8n workflow was later converted into application code. n8n is not required by the current runtime.

## Responsible Use and Authorization

This project is intended only for authorized, controlled security-awareness simulations. Before sending any campaign, obtain written authorization, define the target scope, notify the appropriate security and legal stakeholders, and use only approved test recipients and infrastructure.

- Never use this tool to collect real credentials or sensitive personal data.
- Use controlled landing pages and safe, non-destructive scenarios.
- Protect employee identities, email addresses, campaign data, and behavioral results.
- Keep the admin interface restricted to authorized operators.
- Review all simulations against organizational policy and applicable laws.
- Rotate credentials if they appear in shared workflow exports or logs.

## Architecture

```text
                         +----------------------+
                         | Browser Admin UI      |
                         | public/index.html     |
                         +----------+-----------+
                                    | REST API
                         +----------v-----------+
                         | Express API Server   |
                         | server.js            |
                         +-----+----------+-----+
                               |          |
                    +----------v---------+  +---------v----------+
                    | SQLite Database    |  | AI Decision Engine |
                    | db.js              |  | Gemini / Ollama    |
                    +----------+---------+  +---------+----------+
                               |                       |
                               +----------+------------+
                                          |
                                +---------v----------+
                                | GoPhish REST API   |
                                | Groups, campaigns, |
                                | results            |
                                +--------------------+

 Scheduled jobs:
 index.js -> run.js -> AI decision -> GoPhish campaign
 index.js -> results-poller.js -> GoPhish results -> SQLite
```

## Current Technology Stack

### Backend

- Node.js 18 or newer
- CommonJS JavaScript
- Express 5.1 for the local HTTP server and REST API
- `better-sqlite3` for SQLite access
- `node-cron` for scheduled jobs
- `dotenv` for environment configuration
- `undici` for GoPhish HTTPS requests and TLS configuration
- Native Node.js `fetch` for AI provider requests

### Database

- SQLite with Write-Ahead Logging enabled
- Automatic table creation
- Startup schema migration for older `simulation_history` schemas
- Indexes for employees, launch dates, campaigns, and outcome deduplication

### AI Providers

- Google Gemini as the primary AI provider
- Local Ollama as the fallback provider
- Structured JSON decision validation before a campaign can be launched

### External Service

- GoPhish REST API

### Frontend

- Plain HTML, CSS, and browser JavaScript
- No React, Vue, Angular, frontend framework, bundler, or build step

### Testing

- Node.js built-in `node:test` runner
- `node:assert/strict`

## Project History: n8n to Node.js

The project originally used n8n as the orchestration layer. The n8n workflow connected employee data and results to GoPhish through HTTP API nodes, performed deterministic factor and difficulty selection in JavaScript nodes, and used Gemini/Ollama LangChain nodes for AI-assisted campaign decisions.

The original flow included:

1. Reading employee records from Google Sheets
2. Reading historical simulation results from Google Sheets
3. Running deterministic factor and difficulty selection
4. Asking Gemini or Ollama for structured campaign parameters
5. Selecting an existing GoPhish template
6. Creating a GoPhish group
7. Creating a GoPhish landing page
8. Launching a GoPhish campaign
9. Writing or reading campaign results

The workflow was then converted into the current standalone application. The current implementation replaces:

| Original n8n responsibility | Current Node.js implementation |
|---|---|
| n8n workflow orchestration | `index.js`, `run.js`, and `results-poller.js` |
| Google Sheets employee/history storage | SQLite through `db.js` |
| n8n JavaScript decision nodes | `ai-decision.js` and application logic |
| n8n Gemini/Ollama nodes | Direct Gemini and Ollama HTTP requests |
| n8n GoPhish HTTP nodes | `gophish.js` |
| n8n manual workflow interaction | Express API and `public/index.html` |
| n8n schedule/trigger nodes | `node-cron` in `index.js` |

Historical n8n workflow exports are intentionally excluded from this repository. The migration summary above documents their role without publishing workflow exports that may contain service identifiers, configuration, or other sensitive data.

## Repository Structure

```text
.
├── .env.example            # Environment variable template (copy to .env locally)
├── .gitignore              # Ignores secrets, databases, logs, and dependencies
├── package.json            # Dependencies and npm scripts
├── package-lock.json       # Locked dependency versions
├── index.js                # Entry point and cron scheduler
├── config.js               # Environment loading and validation
├── db.js                   # SQLite schema, migrations, and queries
├── retry.js                # Retry and transient-error handling
├── ai-decision.js          # Gemini/Ollama decision engine
├── gophish.js              # GoPhish REST API client
├── run.js                  # Simulation and campaign-launch pipeline
├── results-poller.js       # GoPhish result polling and persistence
├── server.js               # Express API and local admin server
├── public/index.html        # Admin interface
└── test/ai-decision.test.js # AI provider tests
```

## Runtime Components

### `index.js`

Starts the scheduled simulation sender and results poller. It also supports one-time execution through command-line flags.

### `config.js`

Loads and validates environment variables for GoPhish, Gemini, Ollama, cron schedules, SQLite, retries, and the Express server.

### `db.js`

Owns SQLite connection management, schema creation, migrations, employee CRUD operations, simulation history, pending AI decisions, result deduplication, and campaign completion tracking.

### `ai-decision.js`

Builds the AI prompt, calls Gemini, falls back to Ollama after transient Gemini failures, parses JSON responses, and validates all decision fields.

### `gophish.js`

Provides GoPhish operations for creating groups, creating campaigns, listing campaigns, fetching results, and completing campaigns.

### `run.js`

Implements the campaign-launch pipeline:

```text
Find due employees
  -> Load employee history
  -> Generate AI decision
  -> Validate decision
  -> Create one-person GoPhish group
  -> Create scheduled GoPhish campaign
  -> Record campaign in SQLite
```

Employees are processed sequentially so one employee failure does not stop the rest of the batch.

### `results-poller.js`

Fetches active campaigns from GoPhish, reads their results, maps GoPhish statuses to normalized outcomes, deduplicates records, matches result emails to employees, and completes campaigns with terminal outcomes.

### `server.js`

Runs the local Express administration server and exposes the REST API used by the browser UI. It also reconciles local campaign completion state against GoPhish when the server starts.

### `public/index.html`

Single-page local administration interface implemented with native browser JavaScript. It supports employee management, manual simulation preparation, AI decision review, history filtering, result polling, and campaign completion.

## Simulation Flow

The scheduled send flow is:

1. Select employees with no previous launch or whose latest launch is older than `SIMULATION_INTERVAL_DAYS`.
2. Load each employee's simulation history.
3. Ask Gemini for the next simulation parameters.
4. Retry transient Gemini errors.
5. Fall back to Ollama if Gemini remains unavailable.
6. Validate the returned structured decision.
7. Create a one-person GoPhish group.
8. Create a delayed GoPhish campaign.
9. Store the campaign and AI reasoning in `simulation_history`.

The AI decision contains:

```json
{
  "technique": "email",
  "factor": "authority",
  "scenario": "A routine finance approval request",
  "difficulty": 2,
  "variant": "A",
  "target_employee_id": "emp-001",
  "template_id": "FIN-AUTH-01",
  "reasoning": "Authority is appropriate for this role"
}
```

Supported techniques are `email`, `sms`, `qr`, `phone_call`, and `collab_channel`.

Supported factors are `trust`, `fear`, `scarcity`, `curiosity`, `authority`, and `urgency`.

Difficulty is restricted to an integer from 1 through 5. The selected template must exist in the fixed template library, and the target employee ID must match the employee being processed.

## AI Provider Failover

```text
Gemini
  -> success: validate and use decision
  -> transient failure: retry with exponential backoff
  -> retries exhausted: call local Ollama

Ollama
  -> success: validate and use decision
  -> failure: return combined provider error
```

Transient errors include HTTP 429, 5xx responses, connection resets, timeouts, refused connections, and DNS failures.

## Manual Approval Flow

Manual launches from the admin UI intentionally use a review step:

```text
Select employees
  -> Generate AI decisions
  -> Store in pending_decisions
  -> Administrator reviews decision and reasoning
  -> Approve or reject
  -> Approved decision launches GoPhish campaign
```

Scheduled launches do not use the pending-review queue.

## GoPhish Integration

The standalone service expects these GoPhish resources to already exist:

- Email templates
- Landing page
- Sending profile

The service creates a temporary group for each employee and then creates a campaign referencing the configured template, landing page, sending profile, and group.

### GoPhish setup

The standalone service does not create templates, landing pages, or sending profiles. Create these resources in GoPhish before launching a campaign, either through the GoPhish web UI or its REST API. The names must match `DEFAULT_LANDING_PAGE_NAME` and `SENDING_PROFILE_NAME` in `.env`.

The fixed template library used by the AI decision engine is defined in [`ai-decision.js`](./ai-decision.js), in the `TEMPLATE_LIBRARY` constant. Current template IDs include `FIN-AUTH-01`, `FIN-FEAR-01`, `FIN-SCAR-01`, `FIN-CUR-01`, `FIN-TRUST-01`, `FIN-URG-01`, `ENG-AUTH-01`, `ENG-SCAR-01`, `ENG-URG-01`, and `ENG-CUR-01`. Each corresponding template must exist in GoPhish with the same name.

Example resource-creation requests are shown below. Replace the API key, content, sender details, and SMTP host with values approved for your authorized lab. The exact sending-profile fields can vary slightly by GoPhish version, so verify them against the GoPhish API/UI installed in your environment.

```bash
GOPHISH_API_KEY='replace-me'
GOPHISH_URL='https://127.0.0.1:3333/api'

# Local GoPhish installations commonly use a self-signed certificate.
curl -k -X POST "$GOPHISH_URL/pages/" \
  -H "Authorization: $GOPHISH_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "phishing simulation landing page",
    "html": "<html><body><h1>Security Awareness Test</h1><p>This is a controlled training page.</p></body></html>",
    "capture_credentials": false,
    "capture_passwords": false,
    "redirect_url": "https://example.com"
  }'

# Create an approved, non-sensitive training template.
curl -k -X POST "$GOPHISH_URL/templates/" \
  -H "Authorization: $GOPHISH_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "FIN-AUTH-01",
    "subject": "Controlled security awareness exercise",
    "text": "This is an authorized security-awareness exercise.",
    "html": "<html><body><p>This is an authorized security-awareness exercise.</p></body></html>"
  }'

# Create an SMTP sending profile using your approved lab relay.
curl -k -X POST "$GOPHISH_URL/smtp/" \
  -H "Authorization: $GOPHISH_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "phishing simulation sending profile",
    "interface_type": "SMTP",
    "from_address": "security-awareness@example.test",
    "host": "smtp.example.test:587",
    "username": "replace-me",
    "password": "replace-me",
    "ignore_cert_errors": false
  }'
```

Create every template ID that the AI may select, or restrict `TEMPLATE_LIBRARY` to the templates available in your GoPhish instance. Then set the matching names in `.env` and verify the GoPhish API key has permission to create groups and campaigns.

Campaign names use this format:

```text
camp_<employee_id>_<factor>_<difficulty>_<timestamp>
```

The results poller uses this name to recover campaign factor and difficulty metadata.

## Results Polling

GoPhish statuses are normalized as follows:

| GoPhish status | Stored outcome |
|---|---|
| `Clicked Link` | `clicked` |
| `Submitted Data` | `submitted` |
| `Email Reported` | `reported` |
| `Email Opened` | `opened` |
| `Email Sent` | `sent_no_action` |
| Other status | `unknown` |

Terminal outcomes are `clicked`, `submitted`, and `reported`. When a terminal outcome is found, the poller requests campaign completion from GoPhish and marks the local SQLite campaign rows as completed after the remote request succeeds.

Result records are deduplicated by campaign ID, email, and normalized outcome. If a result email does not match a local employee, the result is retained with a `NULL` employee ID.

## Database Schema

### `employees`

Stores simulation targets:

- `employee_id` — primary key
- `email`
- `first_name`
- `last_name`
- `position`
- `department`

### `simulation_history`

Stores campaign launches and outcomes, including employee identity, campaign ID, factor, difficulty, template ID, technique, scenario, launch timestamp, normalized outcome, raw GoPhish status, last checked timestamp, AI reasoning, and completion status.

### `pending_decisions`

Stores manual-review decisions with a pending decision ID, batch ID, employee ID, serialized decision JSON, and creation timestamp.

## Admin API

### Employee management

```text
GET    /api/employees
POST   /api/employees
PUT    /api/employees/:id
DELETE /api/employees/:id
GET    /api/departments
```

### History

```text
GET /api/history
GET /api/history?employee_id=<id>
GET /api/history?outcome=<outcome>
GET /api/employees/:id/history
```

### Manual simulations

```text
POST /api/simulations/launch
```

### Pending decisions

```text
GET  /api/pending-decisions
POST /api/pending-decisions/:id/approve
POST /api/pending-decisions/:id/reject
```

### Results and completion

```text
POST /api/results/poll-now
POST /api/campaigns/:campaignId/complete
GET  /api/campaigns/reconcile
```

## Configuration

Copy the example configuration:

```bash
cp .env.example .env
```

Required credentials:

```env
GOPHISH_API_KEY=replace-me
GEMINI_API_KEY=replace-me
```

Important configuration variables:

```env
GOPHISH_BASE_URL=https://127.0.0.1:3333/api
# Set false only for a local GoPhish instance using a self-signed certificate.
GOPHISH_REJECT_UNAUTHORIZED=true
GEMINI_MODEL=gemini-2.0-flash
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:8b
CRON_SCHEDULE=0 * * * *
POLL_CRON_SCHEDULE=*/15 * * * *
DATABASE_PATH=./phishing-simulation.sqlite3
SIMULATION_INTERVAL_DAYS=30
LAUNCH_DELAY_MINUTES=1
DEFAULT_LANDING_PAGE_NAME=phishing simulation landing page
SENDING_PROFILE_NAME=phishing simulation sending profile
GOPHISH_CAMPAIGN_URL=http://127.0.0.1
RETRY_ATTEMPTS=3
RETRY_BASE_DELAY_MS=500
PORT=3000
```

## Installation and Usage

Install dependencies and create a local configuration file:

```bash
npm install
cp .env.example .env
```

Set valid GoPhish and Gemini credentials in `.env`. Confirm the GoPhish template, landing page, and sending profile names match your local GoPhish setup. Use only an isolated, explicitly authorized test environment.

Start the scheduled sender and results poller:

```bash
npm start
```

Run one simulation cycle immediately:

```bash
npm run run-now
```

Poll results immediately:

```bash
npm run poll-now
```

Start the administration UI separately:

```bash
npm run server
```

Open the UI at `http://127.0.0.1:3000`.

Run tests:

```bash
npm test
```

## Testing

The project uses the Node.js native test runner. Current tests cover successful Gemini decisions, retries for transient Gemini failures, Ollama fallback, permanent Gemini failures, and combined provider failures. Dedicated unit tests for decision parsing and validation are not yet included.

## Current Limitations

- No authentication or role-based access control for the admin UI.
- SQLite is intended for local or small-scale usage.
- No formal migration framework.
- No distributed locking for multiple scheduler instances.
- Campaign and database operations are not one distributed transaction.
- GoPhish templates, landing pages, and sending profiles must be configured separately.
- The standalone service and admin UI run as separate Node.js processes.
- The current automated test suite is focused mainly on the AI decision provider layer; database queries, Express routes, GoPhish integration, scheduler behavior, and end-to-end campaign/result flows do not yet have comprehensive automated coverage.
- n8n is not part of the current runtime; historical workflow exports are intentionally excluded from this repository.

## License

No license file is currently included in this repository. Until the project owner adds a `LICENSE` file, treat the source as proprietary and obtain permission before redistributing or using it outside the authorized project context.
