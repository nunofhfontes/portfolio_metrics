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

  if (list.length === 0) log('warn', 'No dividend history', { ticker });
  return list;
}
const fetchDividends = memoizeTTL(_fetchDividends, 12 * 60 * 60_000, 'dividends'); // 12h

// Start price: first adjClose on/after START_DATE
async function _fetchStartPrice(ticker) {
  const from = START_DATE.subtract(10, 'day').format('YYYY-MM-DD');
  const to = START_DATE.add(20, 'day').format('YYYY-MM-DD');
  const res = await fmp(`/historical-price-full/${encodeURIComponent(ticker)}`, { from, to, serietype: 'line' });
  const hist = res?.historical || [];
  hist.sort((a, b) => new Date(a.date) - new Date(b.date));
  const bar = hist.find(b => dayjs(b.date).isSame(START_DATE, 'day') || dayjs(b.date).isAfter(START_DATE));
  const px = toNum(bar?.adjClose ?? bar?.close ?? null);
  if (px == null) log('warn', 'Start price not found near START_DATE', { ticker, from, to });
  return px;
}
const fetchStartPrice = memoizeTTL(_fetchStartPrice, 30 * 24 * 60 * 60_000, 'startPrice'); // 30d

/* ------------------------------ calculations ------------------------------ */
function analyzeDividends(divEvents, ticker) {
  const byYear = {};
  const now = dayjs();
  const ttmStart = now.subtract(365, 'day');
  let ttmDivPS = 0;

  for (const ev of divEvents) {
    const d = dayjs(ev.date);
    const y = d.year();
    const amt = toNum(ev.dividend);
    if (!amt || amt <= 0) continue;
    byYear[y] = (byYear[y] || 0) + amt;
    if (d.isAfter(ttmStart)) ttmDivPS += amt;
  }

  log('debug', 'Div analysis', {
    ticker,
    years: Object.keys(byYear).length,
    ttmDivPS
  });

  return { byYear, ttmDivPS };
}

function dgr(byYear, n, ticker) {
  const ly = lastFullCalendarYear();
  const end = byYear[ly];
  const start = byYear[ly - n];
  if (!end || !start || start <= 0) {
    log('debug', 'DGR unavailable', { ticker, window: `${n}y`, end, start });
    return null;
  }
  return Math.pow(end / start, 1 / n) - 1;
}

/* --------------------------------- exports -------------------------------- */
export async function analyzeTicker(t) {
  const t0 = Date.now();
  log('info', 'Analyze ticker start', { ticker: t.ticker });

  const [quote, dividends, startPx] = await Promise.all([
    fetchQuote(t.ticker),
    fetchDividends(t.ticker),
    fetchStartPrice(t.ticker)
  ]);

  const { byYear, ttmDivPS } = analyzeDividends(dividends, t.ticker);
  const currPx = quote.price;
  const mv = currPx != null ? currPx * t.shares : null;

  const currentYield = currPx != null ? safeDiv(ttmDivPS, currPx) : null;
  const yieldOnCost = safeDiv(ttmDivPS, t.avgPrice);

  const dgr3 = dgr(byYear, 3, t.ticker);
  const dgr5 = dgr(byYear, 5, t.ticker);
  const dgr10 = dgr(byYear, 10, t.ticker);

  let priceReturnAbs = null, priceReturnPct = null;
  if (currPx != null && startPx != null && startPx > 0) {
    priceReturnAbs = (currPx - startPx) * t.shares;
    priceReturnPct = (currPx - startPx) / startPx;
  } else {
    if (currPx == null) log('warn', 'Skipping price return (no currPx)', { ticker: t.ticker });
    if (startPx == null) log('warn', 'Skipping price return (no startPx)', { ticker: t.ticker });
  }

  const annualDivIncome = (ttmDivPS ?? 0) * t.shares;
  const monthlyDivIncome = annualDivIncome / 12;

  const row = {
    ticker: t.ticker,
    name: quote.name,
    currency: quote.currency,
    shares: t.shares,
    avgPrice: t.avgPrice,
    currentPrice: currPx,
    startPrice: startPx,
    marketValue: mv,
    ttmDivPS,
    currentYield,
    yieldOnCost,
    dgr3, dgr5, dgr10,
    priceReturnAbs,
    priceReturnPct,
    annualDivIncome,
    monthlyDivIncome
  };

  log('info', 'Analyze ticker done', {
    ticker: t.ticker,
    dur: since(t0),
    snapshot: {
      currPx,
      startPx,
      ttmDivPS,
      currentYield,
      yieldOnCost,
      priceReturnPct,
      annualDivIncome
    }
  });

  return row;
}

export function aggregate(rows) {
  const t0 = Date.now();
  const totals = {
    currency: rows.find(r => r.currency)?.currency || '',
    tickers: rows.length,
    marketValue: 0,
    pricePnL: 0,
    annualDivIncome: 0,
    startValue: 0
  };
  for (const r of rows) {
    totals.marketValue += r.marketValue ?? 0;
    totals.pricePnL += r.priceReturnAbs ?? 0;
    totals.annualDivIncome += r.annualDivIncome ?? 0;
    totals.startValue += (r.startPrice ?? 0) * r.shares;
  }
  totals.priceReturnPct = totals.startValue > 0 ? totals.pricePnL / totals.startValue : null;
  totals.monthlyDivIncome = totals.annualDivIncome / 12;

  log('info', 'Aggregate done', {
    rows: rows.length,
    dur: since(t0),
    totals: {
      marketValue: totals.marketValue,
      pricePnL: totals.pricePnL,
      annualDivIncome: totals.annualDivIncome,
      priceReturnPct: totals.priceReturnPct
    }
  });

  return totals;
}

export function loadAll() {
  return loadPortfolio();
}
