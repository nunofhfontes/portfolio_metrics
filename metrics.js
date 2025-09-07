import dayjs from 'dayjs';
import { fetch } from 'undici';

const API = 'https://financialmodelingprep.com/api/v3';
const START_DATE = dayjs(process.env.START_DATE || '2023-01-01');

const toNum = (x) => (x == null || Number.isNaN(Number(x)) ? null : Number(x));
const safeDiv = (a, b) => (b === 0 ? null : a / b);
const lastFullCalendarYear = () => dayjs().year() - 1;

function qs(params) {
  const u = new URLSearchParams(params);
  return u.toString();
}

async function fmp(path, params = {}) {
  const apikey = process.env.FMP_API_KEY;
  if (!apikey) throw new Error('FMP_API_KEY missing');
  const url = `${API}${path}?${qs({ ...params, apikey })}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`FMP ${path} ${r.status}`);
  return r.json();
}

// tiny TTL memoizer to reduce calls
function memoizeTTL(fn, ttlMs) {
  const cache = new Map();
  return async (key) => {
    const c = cache.get(key);
    const now = Date.now();
    if (c && (now - c.t) < ttlMs) return c.v;
    const v = await fn(key);
    cache.set(key, { v, t: now });
    return v;
  };
}

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
  return entries;
}

/** ---------- FMP fetchers ---------- **/

// Quote (current price + name). Endpoint returns an array.
async function _fetchQuote(ticker) {
  const arr = await fmp(`/quote/${encodeURIComponent(ticker)}`);
  const q = Array.isArray(arr) ? arr[0] : null;
  return {
    price: toNum(q?.price),
    name: q?.name || ticker,
    currency: q?.currency || '' // FMP may omit; leave blank
  };
}
const fetchQuote = memoizeTTL(_fetchQuote, 60_000); // 1 min

// Dividends history (for TTM + annual sums). Use adjDividend when available.
async function _fetchDividends(ticker) {
  const from = dayjs().subtract(12, 'year').format('YYYY-MM-DD');
  const res = await fmp(`/historical-price-full/stock_dividend/${encodeURIComponent(ticker)}`, { from });
  const hist = res?.historical || [];
  return hist.map(d => ({
    date: d.date,
    dividend: toNum(d.adjDividend ?? d.dividend) // use adjusted
  })).filter(x => x.dividend && x.dividend > 0);
}
const fetchDividends = memoizeTTL(_fetchDividends, 12 * 60 * 60_000); // 12h

// Start price: first adjClose on/after START_DATE
async function _fetchStartPrice(ticker) {
  const from = START_DATE.subtract(10, 'day').format('YYYY-MM-DD');
  const to = START_DATE.add(20, 'day').format('YYYY-MM-DD');
  const res = await fmp(`/historical-price-full/${encodeURIComponent(ticker)}`, { from, to, serietype: 'line' });
  const hist = res?.historical || [];
  // FMP historical objects typically: { date, close, adjClose }
  hist.sort((a, b) => new Date(a.date) - new Date(b.date));
  const bar = hist.find(b => dayjs(b.date).isSame(START_DATE, 'day') || dayjs(b.date).isAfter(START_DATE));
  return toNum(bar?.adjClose ?? bar?.close ?? null);
}
const fetchStartPrice = memoizeTTL(_fetchStartPrice, 30 * 24 * 60 * 60_000); // 30d

/** ---------- Calculations ---------- **/

function analyzeDividends(divEvents) {
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
  return { byYear, ttmDivPS };
}

function dgr(byYear, n) {
  const ly = lastFullCalendarYear();
  const end = byYear[ly];
  const start = byYear[ly - n];
  if (!end || !start || start <= 0) return null;
  return Math.pow(end / start, 1 / n) - 1;
}

export async function analyzeTicker(t) {
  const [quote, dividends, startPx] = await Promise.all([
    fetchQuote(t.ticker),
    fetchDividends(t.ticker),
    fetchStartPrice(t.ticker)
  ]);

  const { byYear, ttmDivPS } = analyzeDividends(dividends);
  const currPx = quote.price;
  const mv = currPx != null ? currPx * t.shares : null;

  const currentYield = currPx != null ? safeDiv(ttmDivPS, currPx) : null;
  const yieldOnCost = safeDiv(ttmDivPS, t.avgPrice);

  const dgr3 = dgr(byYear, 3);
  const dgr5 = dgr(byYear, 5);
  const dgr10 = dgr(byYear, 10);

  let priceReturnAbs = null, priceReturnPct = null;
  if (currPx != null && startPx != null && startPx > 0) {
    priceReturnAbs = (currPx - startPx) * t.shares;
    priceReturnPct = (currPx - startPx) / startPx;
  }

  const annualDivIncome = (ttmDivPS ?? 0) * t.shares;
  const monthlyDivIncome = annualDivIncome / 12;

  return {
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
}

export function aggregate(rows) {
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
  return totals;
}

export function loadAll() {
  return loadPortfolio();
}
