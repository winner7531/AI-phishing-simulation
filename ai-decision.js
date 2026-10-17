const config = require('./config');
const { withRetries } = require('./retry');
const { isTransient } = require('./retry');

const TEMPLATE_LIBRARY = [
  ['FIN-AUTH-01', 'finance', 'authority'], ['FIN-FEAR-01', 'finance', 'fear'], ['FIN-SCAR-01', 'finance', 'scarcity'],
  ['FIN-CUR-01', 'finance', 'curiosity'], ['FIN-TRUST-01', 'finance', 'trust'], ['FIN-URG-01', 'finance', 'urgency'],
  ['ENG-AUTH-01', 'engineering', 'authority'], ['ENG-SCAR-01', 'engineering', 'scarcity'],
  ['ENG-URG-01', 'engineering', 'urgency'], ['ENG-CUR-01', 'engineering', 'curiosity'],
].map(([template_id, department, factor]) => ({ template_id, department, factor }));

const SYSTEM_PROMPT = `You are the decision engine for a phishing simulation platform.
Decide the next simulation parameters for the employee and history supplied by the caller.
Do not repeat the same factor two cycles in a row if untested factors remain (trust, fear, scarcity, curiosity, authority, urgency).
Escalate difficulty after an ignore/report outcome; hold or reduce difficulty after a click/submitted outcome.
Pick technique (email/sms/qr/phone_call/collab_channel) based on role plausibility. Base scenarios only on legitimate organizational context.
Pick template_id only from the supplied template library. Always include reasoning.
Return one JSON object with technique, factor, scenario, difficulty (integer 1-5), variant, target_employee_id, template_id, and reasoning. Return JSON only.`;

const DECISION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    technique: { type: 'STRING', enum: ['email', 'sms', 'qr', 'phone_call', 'collab_channel'] },
    factor: { type: 'STRING', enum: ['trust', 'fear', 'scarcity', 'curiosity', 'authority', 'urgency'] },
    scenario: { type: 'STRING' },
    difficulty: { type: 'INTEGER' },
    variant: { type: 'STRING' },
    target_employee_id: { type: 'STRING' },
    template_id: { type: 'STRING' },
    reasoning: { type: 'STRING' },
  },
  required: ['technique', 'factor', 'scenario', 'difficulty', 'variant', 'target_employee_id', 'template_id', 'reasoning'],
};

function validateDecision(value, employee) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI response is not a JSON object');
  const required = ['technique', 'factor', 'scenario', 'variant', 'target_employee_id', 'template_id', 'reasoning'];
  for (const key of required) if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`AI response field ${key} is missing or invalid`);
  if (!['email', 'sms', 'qr', 'phone_call', 'collab_channel'].includes(value.technique)) throw new Error('AI response technique is invalid');
  if (!['trust', 'fear', 'scarcity', 'curiosity', 'authority', 'urgency'].includes(value.factor)) throw new Error('AI response factor is invalid');
  if (!Number.isInteger(value.difficulty) || value.difficulty < 1 || value.difficulty > 5) throw new Error('AI response difficulty must be an integer from 1 to 5');
  if (value.target_employee_id !== employee.employee_id) throw new Error('AI response target_employee_id does not match employee');
  if (!TEMPLATE_LIBRARY.some(t => t.template_id === value.template_id)) throw new Error(`AI selected template_id not in fixed library: ${value.template_id}`);
  return value;
}

async function decideSimulationParams(employee, history) {
  const prompt = `Template library:\n${JSON.stringify(TEMPLATE_LIBRARY)}\n\nEmployee:\n${JSON.stringify(employee)}\n\nHistory:\n${JSON.stringify(history)}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

  try {
    const decision = await withRetries(() => requestGemini(url, prompt), {
      attempts: config.retryAttempts,
      baseDelayMs: config.retryBaseDelayMs,
      onRetry: (error, attempt, delay) => console.error(new Date().toISOString(), JSON.stringify({
        level: 'warn', employee_id: employee.employee_id, step: 'Gemini',
        message: `Gemini attempt failed: ${error.status || error.code || error.message}; Retrying Gemini...`,
        retry: attempt, delay_ms: delay,
      })),
    });
    return validateDecision(decision, employee);
  } catch (geminiError) {
    if (!isTransient(geminiError)) throw geminiError;
    console.error(new Date().toISOString(), JSON.stringify({ level: 'warn', employee_id: employee.employee_id, step: 'Gemini', message: 'Gemini retries exhausted; Falling back to local Ollama' }));
    try {
      const decision = await withRetries(() => requestOllama(prompt), {
        attempts: config.retryAttempts,
        baseDelayMs: config.retryBaseDelayMs,
        onRetry: (error, attempt, delay) => console.error(new Date().toISOString(), JSON.stringify({
          level: 'warn', employee_id: employee.employee_id, step: 'Ollama',
          message: `Ollama attempt failed: ${error.status || error.code || error.message}; Retrying Ollama...`,
          retry: attempt, delay_ms: delay,
        })),
      });
      const validated = validateDecision(decision, employee);
      console.log(new Date().toISOString(), JSON.stringify({ level: 'info', employee_id: employee.employee_id, step: 'Ollama', message: 'Ollama decision successful' }));
      return validated;
    } catch (ollamaError) {
      throw new Error(`Both Gemini and local Ollama failed. Gemini: ${summarizeError(geminiError)} Ollama: ${summarizeError(ollamaError)}`);
    }
  }
}

async function requestGemini(url, prompt) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\n${prompt}` }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: DECISION_SCHEMA },
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Gemini request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const envelope = JSON.parse(text);
  const innerText = envelope?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!innerText) throw new Error('Gemini response missing expected candidates/content/parts structure');
  return parseDecisionText(innerText, 'Gemini');
}

async function requestOllama(prompt) {
  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollamaModel,
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Ollama request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const envelope = JSON.parse(text);
  const innerText = envelope?.message?.content;
  if (!innerText) throw new Error('Ollama response missing message.content');
  return parseDecisionText(innerText, 'Ollama');
}

function parseDecisionText(text, provider) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${provider} returned invalid JSON: ${error.message}`);
  }
}

function summarizeError(error) {
  return error?.message || String(error);
}

module.exports = { decideSimulationParams, TEMPLATE_LIBRARY, validateDecision, SYSTEM_PROMPT, requestOllama };
