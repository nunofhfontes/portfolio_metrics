# portfolio_metrics
Analyses my portfolio and calculates some metrics

What it calculates (per ticker + portfolio)

Price return since 2023-01-01 (uses the first trading day on/after that date)
- Current yield = TTM dividends ÷ current price
- Yield on cost = TTM dividends ÷ your avg price
- Dividend growth (3y / 5y / 10y), using last full calendar year vs N years earlier
- Current annual dividend income (TTM per share × shares)
- Average monthly dividend income (annual ÷ 12)

Needs a .env file with two things, here's an example

# START_DATE is the portfolio baseline for price returns
START_DATE=2023-01-01

# Map of TICKER -> { shares, avgPrice }
PORTFOLIO_JSON='{
  "AAPL": { "shares": 50, "avgPrice": 120.50 },
  "MSFT": { "shares": 20, "avgPrice": 200.00 }
}'
