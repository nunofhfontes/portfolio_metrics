import dayjs from 'dayjs';
import { fetch } from 'undici';

const API = 'https://financialmodelingprep.com/api/v3';
const START_DATE = dayjs(process.env.START_DATE || '2023-01-01');

/* ----------------------------- logging utils ----------------------------- */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const CUR_LEVEL = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function log(level, msg, meta) {
  const lvl = LEVELS[level] ?? LEVELS.info;
  if (lvl < CUR_LEVEL) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  if (meta === undefined) {
    // eslint-disable-next-line no-console
    console.log(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line, safeMeta(meta));
  }
}

function safeMeta(m) {
  try {
    // keep logs compact; avoid huge payloads
    return JSON.parse(JSON.stringify(m, (_, v) =>
      typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v
    ));
  } catch {
    return m;
  }
}

function since(startMs) {
  const ms = Date.now() - startMs;
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(2);
  return `${s}s`;
}

/* --------------------------------- helpers -------------------------------- */
const toNum = (x) => (x == null || Number.isNaN(Number(x)) ? null : Number(x));
const safeDiv = (a, b) => (b === 0 ? null : a / b);
const lastFullCalendarYear = () => dayjs().year() - 1;

function qs(params) {
  const u = new URLSearchParams(params);
  return u.toString();
}

/* ----------------------------- portfolio load ----------------------------- */
function loadPortfolio() {
  const raw = process.env.PORTFOLIO_JSON;
  if (!raw) throw new Error('PORTFOLIO_JSON missing');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('PORTFOLIO_JSON invalid JSON'); }
  const entries = Object.entries(parsed).map(([ticker, v]) => {
    const shares = toNum(v.shares);
    const avgPrice = toNum(v.avgPrice);
    if (!shares || !avgPrice) throw new Error(`Invalid shares/avgPrice for ${ticker}`);
    return { ticker, shares, avgPrice };
  });
  if (!entries.length) throw new Error('Empty portfolio');
  log('info', 'Loaded portfolio', { tickers: entries.map(e => e.ticker), count: entries.length });
  return entries;
}

/* --------------------------------- FMP IO --------------------------------- */
async function fmp(path, params = {}) {
  const apikey = process.env.FMP_API_KEY;
  if (!apikey) throw new Error('FMP_API_KEY missing');
  const url = `${API}${path}?${qs({ ...params, apikey })}`;
  const t0 = Date.now();
  try {
    log('debug', 'HTTP → FMP', { path, params: params || {} });
    const r = await fetch(url);
    const dur = since(t0);
    if (!r.ok) {
      log('error', 'HTTP error from FMP', { path, status: r.status, dur });
      throw new Error(`FMP ${path} ${r.status}`);
    }
    const json = await r.json();

    // cheap size heuristic
    let count = 0;
    if (Array.isArray(json)) count = json.length;
    else if (json?.historical) count = json.historical.length;
    else if (json && typeof json === 'object') count = Object.keys(json).length;

    log('debug', 'HTTP ← FMP ok', { path, dur, items: count });
    return json;
  } catch (e) {
    log('error', 'FMP request failed', { path, err: e.message });
    throw e;
  }
}

// TTL memoizer with logs
function memoizeTTL(fn, ttlMs, name) {
  const cache = new Map();
  return async (key) => {
    const now = Date.now();
    const c = cache.get(key);
    if (c && (now - c.t) < ttlMs) {
      log('debug', `${name} cache HIT`, { key, ageMs: now - c.t });
      return c.v;
    }
    log('debug', `${name} cache MISS`, { key });
    const t0 = Date.now();
    const v = await fn(key);
    log('debug', `${name} fetch done`, { key, dur: since(t0) });
    cache.set(key, { v, t: now });
    return v;
  };
}

/* ------------------------------- data fetchers ---------------------------- */
// Quote (current price + name). Endpoint returns an array.
async function _fetchQuote(ticker) {
  const arr = await fmp(`/quote/${encodeURIComponent(ticker)}`);
  const q = Array.isArray(arr) ? arr[0] : null;
  const out = {
    price: toNum(q?.price),
    name: q?.name || ticker,
    currency: q?.currency || '' // FMP may omit; leave blank
  };
  if (out.price == null) log('warn', 'Missing current price', { ticker });
  return out;
}
const fetchQuote = memoizeTTL(_fetchQuote, 60_000, 'quote'); // 1 min

// Dividends (for TTM + annual sums)
async function _fetchDividends(ticker) {
  const from = dayjs().subtract(12, 'year').format('YYYY-MM-DD');
  const res = await fmp(`/historical-price-full/stock_dividend/${encodeURIComponent(ticker)}`, { from });
  const hist = res?.historical || [];
  const list = hist.map(d => ({
    date: d.date,
    dividend: toNum(d.adjDividend ?? d.dividend)
  })).filter(x => x.dividend && x.dividend > 0);

  if (list.length === 0) l
