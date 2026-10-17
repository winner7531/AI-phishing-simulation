function isTransient(error) {
  const status = error?.status;
  const code = error?.code || error?.cause?.code;
  return error?.transient === true || code === 'ECONNRESET' || code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' || code === 'ENOTFOUND' ||
    [429, 500, 502, 503, 504].includes(status);
}

async function withRetries(operation, { attempts = 3, baseDelayMs = 500, onRetry = () => {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransient(error)) throw error;
      const delay = baseDelayMs * (2 ** (attempt - 1));
      onRetry(error, attempt, delay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

module.exports = { withRetries, isTransient };
