const cron = require('node-cron');
const config = require('./config');
const { runSimulationCycle } = require('./run');
const { pollResults } = require('./results-poller');

const runRequestedActions = async () => {
  if (process.argv.includes('--now')) await runSimulationCycle();
  if (process.argv.includes('--poll-now')) await pollResults();
};

if (process.argv.includes('--now') || process.argv.includes('--poll-now')) {
  runRequestedActions().then(() => process.exit(0)).catch(error => { console.error(new Date().toISOString(), error); process.exit(1); });
} else {
  if (!cron.validate(config.cronSchedule)) throw new Error(`Invalid CRON_SCHEDULE: ${config.cronSchedule}`);
  if (!cron.validate(config.pollCronSchedule)) throw new Error(`Invalid POLL_CRON_SCHEDULE: ${config.pollCronSchedule}`);
  console.log(new Date().toISOString(), `Scheduled send service: ${config.cronSchedule}`);
  console.log(new Date().toISOString(), `Scheduled results poller: ${config.pollCronSchedule}`);
  cron.schedule(config.cronSchedule, () => runSimulationCycle().catch(error => console.error(new Date().toISOString(), error)));
  cron.schedule(config.pollCronSchedule, () => pollResults().catch(error => console.error(new Date().toISOString(), error)));
}
