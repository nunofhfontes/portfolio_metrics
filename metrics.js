// metrics.js — Alpha Vantage only
import dayjs from 'dayjs';
import { fetch } from 'undici';

const START_DATE = dayjs(process.env.START_DATE || '2023-01-01');

/* ----------------------------- logging utils ----------------------------- */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const CUR_LEVEL = LEVELS[LOG_LEVEL] ?? LEVELS.info;
const log = (lvl, msg, meta) => {
  const L = LEVELS[lvl] ?? LEVELS.info;
  if (L < CUR_LEVEL) return;
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [${lvl.toUpperCase()}] ${msg}`, meta ? safeMeta(meta) : '');
};
const safeMeta = (m) => {
  try { return JSON.parse(JSON.stringify(m, (_, v) => (typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v))); }
  catch { return m; }
};
const since = (t0) => {
  const ms = Date.now() - t0;
  return ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(2)}s`;
};

/* -------------------------------- helpers -------------------------------- */
const toNum = (x) => (x == null || Number.isNaN(Number(x)) ? null : Number(x));
const safeDiv = (a, b) => (b === 0 ? null : a / b);
const lastFullCalendarYear = () => dayjs().year() - 1;

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
  log('info', 'Loaded portfolio', { count: entries.length, tickers: entries.map(e => e.ticker) });
  return entries;
}

/* -------------------------------- AlphaVantage IO ------------------------------- */
// Build and call AV query; log masked URL; surface error bodies/rate limits
async function av(params) {
  const key = process.env.ALPHA_VANTAGE_KEY;
  if (!key) throw new Error('ALPHA_VANTAGE_KEY missing');
  const url = `https://www.alphavantage.co/query?${new URLSearchParams({ ...params, apikey: key })}`;
  const masked = url.replace(/(apikey=)[^&]+/i, '$1***');
  const t0 = Date.now();
  log('debug', 'HTTP → AV', { url: masked });

  const resp = await fetch(url, { headers: { 'user-agent': 'portfolio-metrics/av-1.0' } });
  const body = await resp.text();
  const dur = since(t0);

  if (!resp.ok) {
    log('error', 'HTTP error from AV', { status: resp.status, dur, url: masked, body: body.slice(0, 300) });
    throw new Error(`AV ${params.function} ${resp.status}`);
  }
  let json; try { json = JSON.parse(body); } catch {
    log('error', 'AV response not JSON', { url: masked, dur, body: body.slice(0, 300) });
    throw new Error('AV response not JSON');
  }
  if (json.Note || json.Information || json['Error Message']) {
    log('error', 'AV API message', { url: masked, dur, note: json.Note, info: json.Information, err: json['Error Message'] });
    throw new Error(json.Note || json.Information || json['Error Message'] || 'AV error');
  }
  log('debug', 'HTTP ← AV ok', { url: masked, dur });
  return json;
}

// tiny TTL memo
function memoizeTTL(fn, ttlMs, name) {
  const cache = new Map();
  return async (key) => {
    const c = cache.get(key), now = Date.now();
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

/* --------------------------- Symbol normalization --------------------------- */
// Heuristics for TSX/TSXV & hyphen/dot quirks (e.g., "SRU-UN.TO")
function avSymbolVariants(ticker) {
  const variants = new Set([ticker]);

  // Yahoo TSX -> AV TSX sample in docs uses ".TRT" for TSX, ".TRV" for TSXV
  // https://www.alphavantage.co/documentation/ (e.g. SHOP.TRT) :contentReference[oaicite:1]{index=1}
  if (ticker.endsWith('.TO')) variants.add(ticker.replace(/\.TO$/, '.TRT'));
  if (ticker.endsWith('.V')) variants.add(ticker.replace(/\.V$/, '.TRV'));

  // Hyphen vs dot between root and "UN", "PR", etc.
  // Try replacing one hyphen with dot before the suffix, e.g., SRU-UN.TO -> SRU.UN.TRT
  variants.forEach(s => {
    const m = s.match(/^([A-Z0-9]+)-([A-Z0-9]+)\.(TRT|TRV)$/i);
    if (m) variants.add(`${m[1]}.${m[2]}.${m[3]}`.toUpperCase());
  });

  return [...variants];
}

/* ------------------------------ Core fetchers ------------------------------ */
// Try DAILY_ADJUSTED first (best: adjusted close + dividends). Fallback to DAILY + MONTHLY_ADJUSTED.
async function _fetchDailyBundle(originalTicker) {
  const tries = avSymbolVariants(originalTicker);
  let lastErr;

  for (const symbol of tries) {
    // 1) Try DAILY_ADJUSTED (full)
    try {
      const dj = await av({
        function: 'TIME_SERIES_DAILY_ADJUSTED',
        symbol,
        outputsize: 'full'
      }); // docs: fields incl. "5. adjusted close" and "7. dividend amount" :contentReference[oaicite:2]{index=2}

      const series = dj['Time Series (Daily)'];
      if (!series) throw new Error('No daily adjusted series');

      return { symbol, series, adjusted: true };
    } catch (e) {
      lastErr = e;
      log('warn', 'DAILY_ADJUSTED failed, will try DAILY', { ticker: originalTicker, symbol, err: e.message });
      // 2) Try DAILY (prices only)
      try {
        const d = await av({
          function: 'TIME_SERIES_DAILY',
          symbol,
          outputsize: 'full'
        }); // docs: daily (raw OHLCV) :contentReference[oaicite:3]{index=3}
        const series = d['Time Series (Daily)'];
        if (!series) throw new Error('No daily series');
        return { symbol, series, adjusted: false };
      } catch (e2) {
        lastErr = e2;
        log('warn', 'DAILY failed on this symbol variant', { ticker: originalTicker, symbol, err: e2.message });
      }
    }
  }
  throw lastErr || new Error('Unable to fetch daily series');
}
const fetchDailyBundle = memoizeTTL(_fetchDailyBundle, 6 * 60 * 60_000, 'daily'); // 6h

// If DAILY_ADJUSTED unavailable, fetch monthly-adjusted just for dividends
async function _fetchMonthlyAdjusted(originalTicker) {
  const tries = avSymbolVariants(originalTicker);
  let lastErr;
  for (const symbol of tries) {
    try {
      const mj = await av({
        function: 'TIME_SERIES_MONTHLY_ADJUSTED',
        symbol
      }); // docs: contains "7. dividend amount" per month :contentReference[oaicite:4]{index=4}
      const series = mj['Monthly Adjusted Time Series'];
      if (!series) throw new Error('No monthly adjusted series');
      return { symbol, series };
    } catch (e) {
      lastErr = e;
      log('warn', 'MONTHLY_ADJUSTED failed on this variant', { ticker: originalTicker, err: e.message });
    }
  }
  throw lastErr || new Error('Unable to fetch monthly adjusted series');
}
const fetchMonthlyAdjusted = memoizeTTL(_fetchMonthlyAdjusted, 24 * 60 * 60_000, 'monthly'); // 24h

/* ------------------------------ Calculations ------------------------------ */
function analyzeFromDaily(daily, adjusted) {
  // daily: object { 'YYYY-MM-DD': { '4. close': '...', '5. adjusted close': '...', '7. dividend amount': '...' } }
  const rows = Object.entries(daily)
    .map(([date, rec]) => ({
      date,
      close: toNum(rec['4. close']),
      adjClose: toNum(rec['5. adjusted close']),
      div: toNum(rec['7. dividend amount'])
    }))
    .filter(x => dayjs(x.date).isValid())
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // Current price = last adjClose if adjusted, else last close
  const last = rows[rows.length - 1];
  const currentPrice = adjusted ? last?.adjClose : last?.close;

  // Start price = first bar on/after START_DATE
  const startRow = rows.find(r => dayjs(r.date).isSame(START_DATE, 'day') || dayjs(r.date).isAfter(START_DATE));
  const startPrice = adjusted ? startRow?.adjClose : startRow?.close;

  // Dividends (daily events from DAILY_ADJUSTED only)
  let byYear = {}, ttm = 0;
  if (adjusted) {
    const ttmStart = dayjs().subtract(365, 'day');
    for (const r of rows) {
      if (r.div && r.div > 0) {
        const y = dayjs(r.date).year();
        byYear[y] = (byYear[y] || 0) + r.div;
        if (dayjs(r.date).isAfter(ttmStart)) ttm += r.div;
      }
    }
  }

  return { currentPrice, startPrice, byYear, ttmDivPS: adjusted ? ttm : null };
}

function analyzeFromMonthly(monthlySeries) {
  const rows = Object.entries(monthlySeries)
    .map(([date, rec]) => ({ date, div: toNum(rec['7. dividend amount']) }))
    .filter(x => dayjs(x.date).isValid() && x.div && x.div > 0);

  const ttmStart = dayjs().subtract(365, 'day');
  let byYear = {}, ttm = 0;
  for (const r of rows) {
    const y = dayjs(r.date).year();
    byYear[y] = (byYear[y] || 0) + r.div;
    if (dayjs(r.date).isAfter(ttmStart)) ttm += r.div;
  }
  return { byYear, ttmDivPS: ttm };
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

  // 1) Daily (adjusted preferred)
  const daily = await fetchDailyBundle(t.ticker);
  const { currentPrice, startPrice, byYear: byYearDaily, ttmDivPS: ttmDaily } =
    analyzeFromDaily(daily.series, daily.adjusted);

  // 2) Dividends: if daily.adjusted gave us dividends, use them. Otherwise monthly-adjusted.
  let byYear = byYearDaily, ttmDivPS = ttmDaily;
  if (!ttmDivPS) {
    log('warn', 'No dividends from daily; using monthly-adjusted', { ticker: t.ticker });
    const monthly = await fetchMonthlyAdjusted(t.ticker);
    const m = analyzeFromMonthly(monthly.series);
    byYear = m.byYear;
    ttmDivPS = m.ttmDivPS;
  }

  // 3) Compute metrics
  const currPx = currentPrice;
  const mv = currPx != null ? currPx * t.shares : null;
  const currentYield = currPx != null ? safeDiv(ttmDivPS, currPx) : null;
  const yieldOnCost = safeDiv(ttmDivPS, t.avgPrice);

  let priceReturnAbs = null, priceReturnPct = null;
  if (currPx != null && startPrice != null && startPrice > 0) {
    priceReturnAbs = (currPx - startPrice) * t.shares;
    priceReturnPct = (currPx - startPrice) / startPrice;
  } else if (!daily.adjusted) {
    log('warn', 'Price return based on RAW daily (split risk)', { ticker: t.ticker });
  }

  const annualDivIncome = (ttmDivPS ?? 0) * t.shares;
  const monthlyDivIncome = annualDivIncome / 12;

  // DGRs
  const dgr3 = dgr(byYear, 3, t.ticker);
  const dgr5 = dgr(byYear, 5, t.ticker);
  const dgr10 = dgr(byYear, 10, t.ticker);

  const row = {
    ticker: t.ticker,
    name: t.ticker,           // AV time series don’t carry names; leave ticker
    currency: '',             // AV doesn’t return currency here
    shares: t.shares,
    avgPrice: t.avgPrice,
    currentPrice: currPx,
    startPrice,
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
    adjustedDaily: daily.adjusted,
    snapshot: { currPx, startPrice, ttmDivPS, currentYield, priceReturnPct }
  });

  return row;
}

export function aggregate(rows) {
  const t0 = Date.now();
  const totals = {
    currency: '', // unknown from AV time series
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
