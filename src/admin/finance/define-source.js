const SOURCE_TIMEOUT_MS = 15000;

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

// Canonical source contract:
// fetch() must resolve with { amount_cents: integer, units?, unit_type?, details?, raw_data? }.
// Wrapper converts amount_cents → amount_usd (decimal 4dp string) for DB storage.
// Any throw or timeout becomes a 0-value row with details prefixed "ERROR:".
function defineCostSource(config) {
  const { id, category, label, source_type = 'api', fetch: fetchFn } = config || {};
  if (!id || !category || !label || typeof fetchFn !== 'function') {
    throw new Error(`defineCostSource: invalid config for "${id || 'unknown'}"`);
  }

  async function execute() {
    const startedAt = Date.now();
    try {
      const raw = await withTimeout(fetchFn(), SOURCE_TIMEOUT_MS);
      const cents = Math.round(Number((raw && raw.amount_cents) || 0));
      return {
        id, source: id, category, label, source_type,
        amount_usd: (cents / 100).toFixed(4),
        units: raw && raw.units != null ? Math.round(Number(raw.units)) : null,
        unit_type: (raw && raw.unit_type) || null,
        details: (raw && raw.details) || '',
        raw_data: (raw && raw.raw_data) != null ? raw.raw_data : null,
        error: null,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const isTimeout = !!(err && err.__timeout);
      console.error(`[Finance] ${id} ${isTimeout ? 'timed out' : 'failed'}: ${msg}`);
      return {
        id, source: id, category, label, source_type,
        amount_usd: '0.0000',
        units: null,
        unit_type: null,
        details: `ERROR: ${isTimeout ? 'timed out after 15s' : msg.slice(0, 400)}`,
        raw_data: null,
        error: msg,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  return { id, category, label, source_type, execute };
}

module.exports = { defineCostSource, SOURCE_TIMEOUT_MS };
