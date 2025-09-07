import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import dayjs from 'dayjs';
import { fetch } from 'undici';
import { analyzeTicker, aggregate, loadAll } from './metrics.js';

const app = express();
app.use(morgan('tiny'));

const requireKey = (req, res, next) => {
  const expected = process.env.METRICS_KEY;
  if (!expected) return res.status(500).send('METRICS_KEY not set');
  const header = req.get('authorization');
  const token = (header && header.startsWith('Bearer ')) ? header.slice(7) : (req.query.key || '');
  if (token !== expected) return res.status(401).send('Unauthorized');
  next();
};

app.get('/', (_req, res) => res.type('text').send('ok'));

app.get('/metrics', requireKey, async (_req, res) => {
  try {
    const portfolio = loadAll();
    const rows = [];
    for (const t of portfolio) {
      try {
        rows.push(await analyzeTicker(t));
      } catch (e) {
        rows.push({ ticker: t.ticker, error: e.message });
      }
    }
    const totals = aggregate(rows.filter(r => !r.error));
    res.json({
      generatedAt: dayjs().toISOString(),
      startDate: process.env.START_DATE || '2023-01-01',
      perTicker: rows,
      totals
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/metrics.html', requireKey, async (_req, res) => {
  try {
    const base = `http://localhost:${process.env.PORT || 3000}`;
    const r = await fetch(`${base}/metrics?key=${encodeURIComponent(process.env.METRICS_KEY)}`).then(x => x.json());
    const fmtPct = (x) => (x == null ? '-' : (x * 100).toFixed(2) + '%');
    const fmt = (x, d=2) => (x == null ? '-' : x.toFixed(d));
    const rows = r.perTicker.filter(x => !x.error);

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Portfolio Metrics</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ddd;padding:8px;font-size:14px}
th{background:#f6f6f6;text-align:left;position:sticky;top:0}
tfoot td{font-weight:700;background:#fafafa}
small{color:#666}
.code{font-family:ui-monospace,Menlo,Consolas,monospace}
</style>
</head>
<body>
  <h2>Portfolio Metrics <small class="code">${r.startDate} baseline</small></h2>
  <table>
    <thead>
      <tr>
        <th>Ticker</th><th>Name</th><th>Curr</th>
        <th>Shares</th><th>Avg Px</th><th>Start Px</th><th>Curr Px</th>
        <th>Price Return %</th>
        <th>TTM Div/Share</th><th>Current Yield</th><th>Yield on Cost</th>
        <th>DGR 3y</th><th>DGR 5y</th><th>DGR 10y</th>
        <th>Annual Div Income</th><th>Monthly Div Income</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(r => `
        <tr>
          <td>${r.ticker}</td>
          <td>${r.name || ''}</td>
          <td>${r.currency || ''}</td>
          <td>${r.shares}</td>
          <td>${fmt(r.avgPrice)}</td>
          <td>${fmt(r.startPrice)}</td>
          <td>${fmt(r.currentPrice)}</td>
          <td>${fmtPct(r.priceReturnPct)}</td>
          <td>${fmt(r.ttmDivPS)}</td>
          <td>${fmtPct(r.currentYield)}</td>
          <td>${fmtPct(r.yieldOnCost)}</td>
          <td>${fmtPct(r.dgr3)}</td>
          <td>${fmtPct(r.dgr5)}</td>
          <td>${fmtPct(r.dgr10)}</td>
          <td>${fmt(r.annualDivIncome)}</td>
          <td>${fmt(r.monthlyDivIncome)}</td>
        </tr>`).join('')}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="6">Totals</td>
        <td></td>
        <td>${fmtPct(r.totals.priceReturnPct)}</td>
        <td></td>
        <td></td>
        <td></td>
        <td colspan="3"></td>
        <td>${fmt(r.totals.annualDivIncome)}</td>
        <td>${fmt(r.totals.monthlyDivIncome)}</td>
      </tr>
    </tfoot>
  </table>
  <p><small>Generated ${new Date(r.generatedAt).toLocaleString()}</small></p>
</body>
</html>`;
    res.type('html').send(html);
  } catch (e) {
    res.status(500).type('text').send(e.message);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on :${port}`));
