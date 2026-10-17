const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GOPHISH_API_KEY = 'test-gophish-key';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.RETRY_ATTEMPTS = '3';
process.env.RETRY_BASE_DELAY_MS = '0';
process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
process.env.OLLAMA_MODEL = 'qwen3:8b';

const { decideSimulationParams } = require('../ai-decision');

const employee = {
  employee_id: 'emp-test', email: 'employee@example.com', first_name: 'Test', last_name: 'Employee',
  position: 'Analyst', department: 'finance',
};
const history = [];
const decision = {
  technique: 'email', factor: 'authority', scenario: 'A routine finance approval request', difficulty: 2,
  variant: 'A', target_employee_id: 'emp-test', template_id: 'FIN-AUTH-01', reasoning: 'Authority is appropriate for this role',
};

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test('Gemini succeeds and Ollama is not called', async () => {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return response({ candidates: [{ content: { parts: [{ text: JSON.stringify(decision) }] } }] });
  };
  const result = await decideSimulationParams(employee, history);
  assert.deepEqual(result, decision);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes('generativelanguage.googleapis.com'), true);
});

test('repeated Gemini 503 responses fall back to Ollama', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('generativelanguage.googleapis.com')) return response({ error: 'unavailable' }, 503);
    return response({ message: { content: JSON.stringify(decision) } });
  };
  const result = await decideSimulationParams(employee, history);
  assert.deepEqual(result, decision);
  assert.equal(calls.filter(call => call.url.includes('generativelanguage.googleapis.com')).length, 3);
  const ollamaCall = calls.find(call => call.url.endsWith('/api/chat'));
  assert.ok(ollamaCall);
  assert.equal(JSON.parse(ollamaCall.options.body).model, 'qwen3:8b');
});

test('permanent Gemini errors are not retried or sent to Ollama', async () => {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return response({ error: 'invalid key' }, 400);
  };
  await assert.rejects(() => decideSimulationParams(employee, history), /Gemini request failed \(400\)/);
  assert.equal(calls.length, 1);
});

test('both providers failing returns a clear combined error', async () => {
  global.fetch = async (url) => {
    if (url.includes('generativelanguage.googleapis.com')) return response({ error: 'unavailable' }, 503);
    return response({ error: 'ollama unavailable' }, 503);
  };
  await assert.rejects(
    () => decideSimulationParams(employee, history),
    /Both Gemini and local Ollama failed.*Gemini:.*Ollama:/,
  );
});
