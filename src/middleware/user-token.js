// Binds the user id a route trusts to the session that sent it.
//
// Price alerts, notification settings, Troy's conversations, transcribe and
// portfolio snapshots take a user id from the body, the query or the path and
// act for it with no sign-in, so anyone holding an account's id could reach
// that account's data there. Closing that takes three steps.
//
// Step one, this file. A call that carries a valid Supabase session token
// must name that session's own user, or it's refused with 403. A call with no
// token, or with a token that doesn't check out, goes through as before, and
// one log line counts it, so the logs show when the apps have caught up.
// Step two. The iPhone app and troystack.ai send their session token on
// these calls.
// Step three. Once the count says they do, a user id with no valid token is
// refused. Alerts a signed-out phone keeps by device_id stay as they are.

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// Every user id the call names, as the routes will read it. Any value counts,
// not only a well-formed one: a route coerces a one-element array to its
// string, and Express decodes a percent-escaped path segment before the
// router sees it, so the check flattens arrays and decodes the path the same
// way. pathUserId reads the first path segment, for GET /v1/snapshots/:userId,
// since app-level middleware runs before the router has parsed its params.
function claimedUserIds(req, { pathUserId = false } = {}) {
  const ids = [];
  const add = (value) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) return value.forEach(add);
    ids.push(String(value).toLowerCase());
  };
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const query = req.query || {};
  add(body.userId);
  add(body.user_id);
  add(query.userId);
  add(query.user_id);
  if (pathUserId) {
    const segment = String(req.path || '').split('/')[1] || '';
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Express answers a malformed escape with 400, so the raw text stands.
    }
    add(decoded);
  }
  return [...new Set(ids)];
}

// The bearer token when it looks like a Supabase session, not an API key.
function sessionToken(req) {
  const header = req.headers?.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return JWT_RE.test(token) ? token : '';
}

// The route the call hit with ids taken out, so the count never logs whose
// account a call named. Each segment is decoded first, so an escaped id is
// caught too, and on a pathUserId route the first segment is always the id.
function routeLabel(req, { pathUserId = false } = {}) {
  const segments = String(req.path || '').split('/').map((segment, i) => {
    if (pathUserId && i === 1 && segment) return ':id';
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // A malformed escape is logged as sent, after the id check below.
    }
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded) ? ':id' : segment;
  });
  return `${req.method} ${req.baseUrl || ''}${segments.join('/')}`;
}

function createUserTokenCheck({ supabase, pathUserId = false, log = console.log } = {}) {
  return async function userTokenCheck(req, res, next) {
    const claimed = claimedUserIds(req, { pathUserId });
    if (claimed.length === 0) return next();

    const label = routeLabel(req, { pathUserId });
    const token = sessionToken(req);
    if (!token) {
      log(`[UserToken] no session ${label}`);
      return next();
    }

    // One line per call, whether the token was refused or the check threw.
    let user = null;
    let failure = '';
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user?.id) user = data.user;
    } catch (err) {
      failure = `, check failed: ${err.message}`;
    }
    if (!user) {
      log(`[UserToken] session not verified ${label}${failure}`);
      return next();
    }

    const own = String(user.id).toLowerCase();
    if (claimed.some((id) => id !== own)) {
      log(`[UserToken] refused another account ${label}`);
      return res.status(403).json({ error: "That user id isn't the signed-in account." });
    }
    req.sessionUserId = user.id;
    return next();
  };
}

module.exports = { createUserTokenCheck, claimedUserIds, sessionToken, routeLabel };
