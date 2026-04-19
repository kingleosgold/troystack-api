const ALLOWED_STATUSES = ['green', 'yellow', 'red', 'unknown'];
const CHECK_TIMEOUT_MS = 5000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('timeout');
      err.__timeout = true;
      reject(err);
    }, ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function shape(id, category, label, raw, startedAt, timestamp) {
  const status = ALLOWED_STATUSES.includes(raw && raw.status) ? raw.status : 'unknown';
  const out = {
    id,
    category,
    label,
    status,
    details: typeof (raw && raw.details) === 'string' ? raw.details.slice(0, 500) : '',
    timestamp,
    durationMs: Date.now() - startedAt,
  };
  if (raw && raw.metric && typeof raw.metric === 'object') out.metric = raw.metric;
  return out;
}

function defineCheck(config) {
  const { id, category, label, run } = config || {};
  if (!id || !category || !label || typeof run !== 'function') {
    throw new Error(`defineCheck: invalid config for "${id || 'unknown'}"`);
  }

  async function execute() {
    const startedAt = Date.now();
    const timestamp = new Date().toISOString();
    try {
      const raw = await withTimeout(run(), CHECK_TIMEOUT_MS);
      return shape(id, category, label, raw, startedAt, timestamp);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const isTimeout = !!(err && err.__timeout);
      console.error(`[AdminHealth] ${id} ${isTimeout ? 'timed out' : 'threw'}: ${msg}`);
      return {
        id,
        category,
        label,
        status: 'unknown',
        details: isTimeout ? 'Check timed out after 5s' : msg.slice(0, 200),
        timestamp,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  return { id, category, label, execute };
}

module.exports = { defineCheck, CHECK_TIMEOUT_MS };
