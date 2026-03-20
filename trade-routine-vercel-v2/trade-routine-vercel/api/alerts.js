// api/alerts.js
// Checks a list of tickers for alert conditions:
//   - Down 5%+ today (SCANNER ALERT)
//   - Down 15%+ from 52-week high (WATCH)
//   - RSI < 35 oversold
//   - RSI > 70 overbought / extended

function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(payload));
}

function calculateRSI(closes, period = 14) {
  const values = closes.filter(v => typeof v === 'number' && !Number.isNaN(v));
  if (values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function validNumbers(arr) {
  return (arr || []).filter(v => typeof v === 'number' && !Number.isNaN(v));
}

function getCloses(result) {
  return validNumbers(result?.indicators?.quote?.[0]?.close);
}

async function fetchYahooChart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo failed for ${symbol}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${symbol}`);
  return result;
}

async function checkTicker(ticker) {
  const alerts = [];

  try {
    const [longResult, shortResult] = await Promise.all([
      fetchYahooChart(ticker, '1y', '1d'),
      fetchYahooChart(ticker, '5d', '1d'),
    ]);

    const longCloses  = getCloses(longResult);
    const shortCloses = getCloses(shortResult);

    if (longCloses.length < 14 || shortCloses.length < 2) return { ticker, alerts: [] };

    const last     = shortCloses[shortCloses.length - 1];
    const prev     = shortCloses[shortCloses.length - 2];
    const changePct = prev ? ((last - prev) / prev) * 100 : 0;

    const high52    = Math.max(...longCloses);
    const fromHigh  = high52 ? ((last - high52) / high52) * 100 : 0;
    const rsi       = calculateRSI(longCloses, 14) ?? 50;

    if (changePct <= -5)   alerts.push({ type: 'DROP',      label: `Down ${Math.abs(changePct).toFixed(1)}% today`,        severity: 'high' });
    if (changePct <= -2 && changePct > -5) alerts.push({ type: 'WEAK', label: `Down ${Math.abs(changePct).toFixed(1)}% today`, severity: 'medium' });
    if (fromHigh   <= -15) alerts.push({ type: 'FROM_HIGH', label: `${fromHigh.toFixed(1)}% off 52w high`,                severity: 'medium' });
    if (rsi        <= 35)  alerts.push({ type: 'OVERSOLD',  label: `RSI ${rsi.toFixed(0)} — oversold`,                    severity: 'medium' });
    if (rsi        >= 70)  alerts.push({ type: 'EXTENDED',  label: `RSI ${rsi.toFixed(0)} — extended`,                    severity: 'low' });

    return {
      ticker,
      price:     Number(last.toFixed(2)),
      changePct: Number(changePct.toFixed(2)),
      rsi:       Number(rsi.toFixed(1)),
      fromHigh:  Number(fromHigh.toFixed(1)),
      alerts,
    };
  } catch {
    return { ticker, alerts: [] };
  }
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  const raw = (req.query.tickers || '').toString();
  const tickers = raw.split(',').map(t => t.trim().toUpperCase()).filter(Boolean).slice(0, 30);

  if (!tickers.length) return json(res, 400, { error: 'No tickers provided' });

  const results = await Promise.all(tickers.map(checkTicker));

  // Only return tickers that have at least one alert
  const triggered = results.filter(r => r.alerts && r.alerts.length > 0);

  // Sort: high severity first
  triggered.sort((a, b) => {
    const sev = { high: 3, medium: 2, low: 1 };
    const aMax = Math.max(...a.alerts.map(x => sev[x.severity] || 0));
    const bMax = Math.max(...b.alerts.map(x => sev[x.severity] || 0));
    return bMax - aMax;
  });

  return json(res, 200, {
    alerts: triggered,
    checked: tickers.length,
    triggered: triggered.length,
    checkedAt: new Date().toISOString(),
  });
};
