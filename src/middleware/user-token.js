// Binds the user id a route trusts to the session that sent it.
//
// Price alerts, notification settings, Troy's conversations, transcribe and
// portfolio snapshots take a user id from the body, the query or the path and
// act for it with no sign-in, so anyone holding an account's id could reach
// that account's data there. Closing that takes three steps.
//
// Step one. A call that carries a valid Supabase session token must name that
// session's own user, or it's refused with 403.
// Step two. The iPhone app and troystack.ai send their session token on
// these calls.
// Step three, with enforce on. Monday 10/19 had traffic on /v1/push,
// /v1/troy/conversations and /v1/snapshots from about two accounts and not
// one [UserToken] line all day, neither no session nor session not verified.
// That's too few phones to prove the token reaches every one, so this ships
// only after a longer window with many accounts and no line. So on those a user id
// with no token, or with one Supabase refuses, gets a 401. A check that fails
// on Supabase's side is a 503, since the caller did nothing wrong. Each
// refusal is still one log line. Alerts a signed-out phone keeps by device_id
// name no user, so they stay as they are.
// Some routes saw no such proof that day, so they keep counting and letting
// calls through until a day with traffic shows no line there. They're the
// /articles routes, /v1/troy/speak, which troystack.ai's Listen button and
// the iPhone's audio player call, and /v1/troy/transcribe, whose user id
// sits in a multipart body the app-level check can't read. enforce takes a
// function of the request for a mount that mixes the two.

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

// Supabase answers a bad or expired token with a 403 bad_jwt, a 400 for a
// session that's gone or a 404 for a deleted user. A network failure, a 5xx,
// a rate limit or a 401 with no code, which is the gateway refusing our own
// key, isn't the caller's fault, so it's a 503 and the app tries again
// rather than signing out.
function tokenRefused(error) {
  const status = Number(error?.status);
  if (status === 401) return Boolean(error?.code);
  return status >= 400 && status < 500 && status !== 429;
}

function failureText(error) {
  const parts = [error?.name, Number.isFinite(Number(error?.status)) ? String(error.status) : '', error?.message]
    .filter((part) => part && part !== '{}');
  return parts.join(' ') || 'unknown error';
}

function enforcing(enforce, req) {
  return typeof enforce === 'function' ? Boolean(enforce(req)) : Boolean(enforce);
}

function createUserTokenCheck({ supabase, pathUserId = false, enforce = false, log = console.log } = {}) {
  return async function userTokenCheck(req, res, next) {
    const claimed = claimedUserIds(req, { pathUserId });
    if (claimed.length === 0) return next();

    const label = routeLabel(req, { pathUserId });
    const token = sessionToken(req);
    if (!token) {
      log(`[UserToken] no session ${label}`);
      if (!enforcing(enforce, req)) return next();
      return res.status(401).json({ error: 'Sign in to reach this account.' });
    }

    // One line per call, whether the token was refused or the check failed.
    let user = null;
    let failure = '';
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (error) {
        if (!tokenRefused(error)) failure = `, check failed: ${failureText(error)}`;
      } else if (data?.user?.id) {
        user = data.user;
      }
    } catch (err) {
      failure = `, check failed: ${err.message}`;
    }
    if (!user) {
      log(`[UserToken] session not verified ${label}${failure}`);
      if (!enforcing(enforce, req)) return next();
      if (failure) return res.status(503).json({ error: "Couldn't check your sign-in. Try again in a moment." });
      return res.status(401).json({ error: 'Your sign-in has expired. Sign in again.' });
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
