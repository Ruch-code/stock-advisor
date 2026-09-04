# Stock Advisor - Live Market Intelligence

A comprehensive stock and mutual fund advisor with live market data, candlestick pattern analysis, and trading recommendations.

## Features

- **Live Market Data** - US and Indian market indices
- **Candlestick Patterns** - Real-time pattern detection with tooltips
- **Stock Recommendations** - Oversold stocks, trending sectors, most bought
- **Mutual Fund Analysis** - Top performing funds with risk metrics
- **Broker Charges** - Comparison across US and Indian brokers
- **Trading Signals** - Entry, exit, stop loss, and quantity suggestions

## Tech Stack

- Pure HTML/CSS/JavaScript (no framework)
- Lightweight Charts (TradingView)
- TerminalFeed API (free, no auth) - indices, macro, sentiment, quotes
- Netlify Functions (server-side data proxy)

## Live Chart Data (API Keys)

Real candle data flows through `netlify/functions/proxy.js`, which reads two optional
env vars (set as Netlify secrets; never exposed to the browser):

| Env var                  | Market                 | Get a free key at              |
| ------------------------ | ---------------------- | ------------------------------ |
| `FINNHUB_API_KEY`        | US stocks / USD        | https://finnhub.io/register    |
| `TWELVEDATA_API_KEY`     | India / NSE / BSE (INR) | https://twelvedata.com/pricing |

Set them with:

```bash
netlify env:set FINNHUB_API_KEY <your-finnhub-token>
netlify env:set TWELVEDATA_API_KEY <your-twelvedata-token>
netlify deploy --prod --dir=.
```

Provider order: `.NS`/`.BO` symbols use Twelve Data (INR), everything else uses
Finnhub (USD). Without keys the chart falls back to simulated candles and the app
shows a clear "Live data unavailable" banner.

## Deployment

Deployed on Netlify with automatic GitHub sync.

## Disclaimer

This application is for educational purposes only. Not financial advice.
