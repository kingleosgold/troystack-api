// A process-wide counter that resets at 00:00 UTC. In memory by design: a
// restart resets it, which errs toward serving users over blocking them.
function createDailyBudget(limit) {
  let usage = { day: '', count: 0 };
  return {
    limit,
    take(now = new Date()) {
      const day = now.toISOString().slice(0, 10);
      if (usage.day !== day) usage = { day, count: 0 };
      if (usage.count >= limit) return false;
      usage.count += 1;
      return true;
    },
  };
}

module.exports = { createDailyBudget };
