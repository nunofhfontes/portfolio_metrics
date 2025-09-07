import yf from 'yahoo-finance2';
import dayjs from 'dayjs';

const START_DATE = dayjs(process.env.START_DATE || '2023-01-01');

const toNum = (x) => (x == null || Number.isNaN(Number(x)) ? null : Number(x));
const safeDiv = (a, b) => (b === 0 ? null : a / b);
const lastFullCalendarYear = () => dayjs().year() - 1;

// tiny in-memory caches to avoid hammering Yahoo on every hit
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

async function _fetchQuote(ticker) {
  const q = await yf.quote(ticker);
  return {
    price: toNum(q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice ?? q.ask ?? q.bid),
    currency: q.currency || q.financialCurrency || null,
    name: q.shortName || q.longName || ticker
  };
}
const fetchQuote = memoizeTTL(_fetchQuote, 60_000);                     // 1 min

async function _fetchDividends(ticker) {
  const start = dayjs().subtract(12, 'year').toDate();
  const res = await yf.historical(ticker, { period1: start, events: 'dividends' });
  return res.filter(r => r.dividends != null);
}
const fetchDividends = memoizeTTL(_fetchDividends, 12 * 60 * 60_000);   // 12h

async function _fetchStartPrice(ticker) {
  const period1 = START_DATE.subtract(10, 'day').toDate();
  const period2 = START_DATE.add(20, 'day').toDate();
  const hist = await yf.historical(ticker, { period1, period2, interval: '1d' });
  const startBar = hist
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .find(b => dayjs(b.date).isSame(START_DATE, 'day') || dayjs(b.date).isAfter(START_DATE));
  return startBar?.adjClose ?? null;
}
const fetchStartPrice = memoizeTTL(_fetchStartPrice, 30 * 24 * 60 * 60_000); // 30d

function analyzeDividends(divEvents) {
  const byYear = {};
  const now = dayjs();
  const ttmStart = now.subtract(365, 'day');
  let ttmDivPS = 0;

  for (const ev of divEvents) {
    const d = dayjs(ev.date);
    const y = d.year();
    const amt = toNum(ev.dividends);
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
  const [quote, divs, startPx] = await Promise.all([
    fetchQuote(t.ticker),
    fetchDividends(t.ticker),
    fetchStartPrice(t.ticker)
  ]);

  const { byYear, ttmDivPS } = analyzeDividends(divs);
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

  const annualDivIncome = ttmDivPS * t.shares;
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
    startValue: 0 // sum(shares * startPrice) for portfolio-level % since START_DATE
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
  const portfolio = loadPortfolio();
  return portfolio;
}
