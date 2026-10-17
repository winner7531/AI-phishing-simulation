require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] || fallback, 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

module.exports = {
  gophishBaseUrl: (process.env.GOPHISH_BASE_URL || 'https://127.0.0.1:3333/api').replace(/\/$/, ''),
  gophishApiKey: required('GOPHISH_API_KEY'),
  gophishRejectUnauthorized: process.env.GOPHISH_REJECT_UNAUTHORIZED !== 'false',
  geminiApiKey: required('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, ''),
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen3:8b',
  cronSchedule: process.env.CRON_SCHEDULE || '0 * * * *',
  pollCronSchedule: process.env.POLL_CRON_SCHEDULE || '*/15 * * * *',
  port: integer('PORT', 3000),
  databasePath: process.env.DATABASE_PATH || './phishing-simulation.sqlite3',
  dueAfterDays: integer('SIMULATION_INTERVAL_DAYS', 30),
  launchDelayMinutes: integer('LAUNCH_DELAY_MINUTES', 1),
  defaultLandingPageName: process.env.DEFAULT_LANDING_PAGE_NAME || 'phishing simulation landing page',
  sendingProfileName: process.env.SENDING_PROFILE_NAME || 'phishing simulation sending profile',
  retryAttempts: integer('RETRY_ATTEMPTS', 3),
  retryBaseDelayMs: integer('RETRY_BASE_DELAY_MS', 500),
};
