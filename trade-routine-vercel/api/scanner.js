
function json(res, code, payload){
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(payload));
}

function calculateRSI(closes, period = 14){
  const values = closes.filter(v => typeof v === 'number' && !Number.isNaN(v));
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function toWeeklyCloses(closes){
  const out = [];
  for (let i = 4; i < closes.length; i += 5) out.push(closes[i]);
  if (closes.length && out[out.length - 1] !== closes[closes.length - 1]) out.push(closes[closes.length - 1]);
  return out;
}

async function fetchYahooChart(symbol, range = '1y', interval = '1d'){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo chart request failed for ${symbol}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${symbol}`);
  return result;
}

function buildSignal(avgRSI, changePct){
  const flags = [];
  let signal = 'NO SETUP';
  if (avgRSI < 35 && changePct < 0) signal = 'ATM CSP 30-100 DTE';
  else if (avgRSI >= 35 && avgRSI <= 65 && changePct < 0) signal = 'OTM CSP 7-30 DTE';
  else if (avgRSI >= 35 && avgRSI <= 65 && changePct > 0) signal = 'OTM CC 7-30 DTE';
  else if (avgRSI > 65 && changePct > 0) signal = 'ATM CC 7-30 DTE';
  if (avgRSI > 65) flags.push('NO CSP');
  return { signal, flags };
}

function noteFor(changePct, avgRSI, fromHighPct){
  const bits = [];
  if (changePct <= -5) bits.push('Big down day.');
  else if (changePct >= 2) bits.push('Strong green day.');
  if (avgRSI < 35) bits.push('Very oversold.');
  else if (avgRSI > 65) bits.push('Momentum extended.');
  if (fromHighPct <= -15) bits.push('Well off recent highs.');
  return bits.join(' ') || 'No major signal.';
}

function validNumbers(arr){
  return (arr || []).filter(v => typeof v === 'number' && !Number.isNaN(v));
}

function latestAndPrev(result){
  const closes = validNumbers(result?.indicators?.quote?.[0]?.close);
  const meta = result?.meta || {};
  const last = typeof meta.regularMarketPrice === 'number'
    ? meta.regularMarketPrice
    : closes[closes.length - 1];
  const prev = typeof meta.chartPreviousClose === 'number'
    ? meta.chartPreviousClose
    : closes[closes.length - 2];
  return { closes, last, prev };
}

async function getScanRow(ticker){
  const result = await fetchYahooChart(ticker, '1y', '1d');
  const { closes, last, prev } = latestAndPrev(result);
  if (closes.length < 20 || typeof last !== 'number') throw new Error(`Not enough data for ${ticker}`);

  const changePct = prev ? ((last - prev) / prev) * 100 : 0;
  const dailyRSI = calculateRSI(closes, 14);
  const weeklyRSI = calculateRSI(toWeeklyCloses(closes), 14);
  const avgRSI = ((dailyRSI ?? 50) + (weeklyRSI ?? 50)) / 2;
  const high52 = Math.max(...closes);
  const fromHighPct = high52 ? ((last - high52) / high52) * 100 : null;
  const { signal, flags } = buildSignal(avgRSI, changePct);

  if (changePct <= -5 && avgRSI < 50) flags.push('SCANNER ALERT');
  if (fromHighPct !== null && fromHighPct <= -15) flags.push('WATCH');

  return {
    symbol: ticker,
    price: Number(last.toFixed(2)),
    changePct: Number(changePct.toFixed(2)),
    dailyRSI: Number((dailyRSI ?? 50).toFixed(1)),
    weeklyRSI: Number((weeklyRSI ?? 50).toFixed(1)),
    avgRSI: Number(avgRSI.toFixed(1)),
    fromHighPct: fromHighPct === null ? null : Number(fromHighPct.toFixed(1)),
    signal,
    flags: [...new Set(flags)],
    note: noteFor(changePct, avgRSI, fromHighPct),
  };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  try {
    const raw = (req.query.tickers || '').toString();
    const tickers = raw.split(',').map(t => t.trim().toUpperCase()).filter(Boolean).slice(0, 25);
    if (!tickers.length) return json(res, 400, { error: 'No tickers provided' });

    const rows = await Promise.all(tickers.map(async (ticker) => {
      try {
        return await getScanRow(ticker);
      } catch (error) {
        return { symbol: ticker, price: null, changePct: 0, avgRSI: 0, fromHighPct: null, signal: 'ERROR', flags: [], note: error.message };
      }
    }));
    return json(res, 200, { tickers: rows, source: 'yahoo_chart_only' });
  } catch (error) {
    return json(res, 500, { error: error.message || 'Scanner failed' });
  }
};
