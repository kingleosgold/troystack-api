// Which Gemini models the API calls, in one place.
//
// Google retires gemini-2.5-flash and gemini-2.5-pro on 12/1/2026 and
// redirects them to newer models. Every Gemini call in the API reads its
// model from here, so the move is one change, and GEMINI_FLASH_MODEL or
// GEMINI_PRO_MODEL in Railway can pick a model without a code change.
//
// The defaults stay on 2.5 until the successor has passed a live test.

const DEFAULT_FLASH = 'gemini-2.5-flash';
const DEFAULT_PRO = 'gemini-2.5-pro';

// A model id is gemini-, a version number, then letters, digits, dots and
// dashes, like gemini-3.5-flash-lite. Anything else would end up inside the
// request URL or hide the version the thinking setting depends on, so it
// falls back to the default instead. That rules out aliases like
// gemini-flash-latest on purpose.
const MODEL_ID = /^gemini-\d+(?:\.\d+)?-[a-z0-9.-]{1,48}$/;

function pick(value, fallback) {
  const v = String(value || '').trim().toLowerCase();
  return MODEL_ID.test(v) ? v : fallback;
}

function flashModel(env = process.env) {
  return pick(env.GEMINI_FLASH_MODEL, DEFAULT_FLASH);
}

function proModel(env = process.env) {
  return pick(env.GEMINI_PRO_MODEL, DEFAULT_PRO);
}

// Gemini 2.x turns thinking off with thinkingBudget 0. Gemini 3 and later
// take a thinkingLevel instead, where minimal is the closest thing to off.
// Pro models don't accept minimal, so they get low, their lowest level.
// Returns null for a model the major version can't be read from, so the
// request goes without a thinking setting rather than with a wrong one.
function majorVersion(model) {
  const m = /^gemini-(\d+)(?:\.\d+)?-/.exec(String(model || ''));
  return m ? Number(m[1]) : null;
}

function thinkingOffConfig(model) {
  const major = majorVersion(model);
  if (major === null) return null;
  if (major < 3) return { thinkingBudget: 0 };
  return /-pro(?:-|$)/.test(String(model)) ? { thinkingLevel: 'low' } : { thinkingLevel: 'minimal' };
}

function geminiUrl(model, apiKey) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
}

// The answer's text, joined across parts. Newer models can split an answer
// over several parts, so reading only parts[0] could drop some of it.
function responseText(data) {
  return data?.candidates?.[0]?.content?.parts
    ?.filter(p => typeof p.text === 'string' && !p.thought)
    ?.map(p => p.text)
    ?.join('') || '';
}

module.exports = {
  DEFAULT_FLASH,
  DEFAULT_PRO,
  flashModel,
  proModel,
  majorVersion,
  thinkingOffConfig,
  geminiUrl,
  responseText,
};
