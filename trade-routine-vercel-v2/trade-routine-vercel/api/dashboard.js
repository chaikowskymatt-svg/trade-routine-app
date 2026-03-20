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

function noteFor(symbol, changePct, avgRSI){
  if (symbol === 'VIX') {
    if (changePct > 3) return 'Volatility rising; fear is picking up.';
    if (changePct < -3) return 'Volatility easing; market stress is fading.';
    return 'Volatility is relatively stable.';
  }
  if (avgRSI < 35) return 'Momentum is washed out and near oversold.';
  if (avgRSI > 65) return 'Momentum is hot and close to overbought.';
  if (changePct > 1) return 'Price action is firm today.';
  if (changePct < -1) return 'Price action is weak today.';
  return 'Momentum is in a neutral range.';
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

async function fetchQuotes(symbols){
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(',')}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('Yahoo quote request failed');
  const data = await res.json();
  const rows = data?.quoteResponse?.result || [];
  const map = {};
  rows.forEach(row => {
    map[row.symbol] = row;
  });
  return map;
}

async function getSymbolData(label, yahooSymbol, quote){
  const result = await fetchYahooChart(yahooSymbol, '1y', '1d');
  const closes = (result.indicators?.quote?.[0]?.close || []).filter(v => typeof v === 'number');
  if (closes.length < 20) throw new Error(`Not enough price history for ${label}`);

  const last = typeof quote?.regularMarketPrice === 'number'
    ? quote.regularMarketPrice
    : closes[closes.length - 1];
  const prev = typeof quote?.regularMarketPreviousClose === 'number'
    ? quote.regularMarketPreviousClose
    : closes[closes.length - 2];
  const rawChangePct = typeof quote?.regularMarketChangePercent === 'number'
    ? quote.regularMarketChangePercent
    : (prev ? ((last - prev) / prev) * 100 : 0);

  const dailyRSI = calculateRSI(closes, 14);
  const weeklyRSI = calculateRSI(toWeeklyCloses(closes), 14);
  const avgRSI = ((dailyRSI ?? 50) + (weeklyRSI ?? 50)) / 2;

  return {
    price: Number(last.toFixed(label === 'BTC' ? 0 : 2)),
    changePct: Number(rawChangePct.toFixed(2)),
    dailyRSI: Number((dailyRSI ?? 50).toFixed(1)),
    weeklyRSI: Number((weeklyRSI ?? 50).toFixed(1)),
    avgRSI: Number(avgRSI.toFixed(1)),
    note: noteFor(label, rawChangePct, avgRSI),
  };
}

function buildStrategy(market){
  const spy = market.SPY;
  const qqq = market.QQQ;
  const vix = market.VIX;
  const avgIndexRSI = ((spy?.avgRSI || 50) + (qqq?.avgRSI || 50)) / 2;
  const redDay = (spy?.changePct || 0) < 0 || (qqq?.changePct || 0) < 0;
  const greenDay = (spy?.changePct || 0) > 0 || (qqq?.changePct || 0) > 0;

  let mood = 'NEUTRAL';
  if ((spy?.changePct || 0) > 0.5 && (qqq?.changePct || 0) > 0.5 && (vix?.changePct || 0) < 0) mood = 'BULLISH';
  else if ((spy?.changePct || 0) < -0.5 && (qqq?.changePct || 0) < -0.5 && (vix?.changePct || 0) > 0) mood = 'BEARISH';
  else if (Math.abs((spy?.changePct || 0)) < 0.4 && Math.abs((qqq?.changePct || 0)) < 0.4) mood = 'CHOPPY';

  let text = '';
  const tags = [];
  if (avgIndexRSI < 35) {
    text = 'Indexes are in an oversold zone. Focus on ATM cash-secured puts with 30-100 DTE and avoid adding fresh covered calls unless you need to reduce basis. Stay selective and prioritize names you want to own.';
    tags.push('ATM CSPS 30-100 DTE', 'AVOID NEW CCS', 'OVERSOLD SETUP');
  } else if (avgIndexRSI > 65) {
    text = 'Momentum is extended. Avoid opening new CSPs into strength and lean toward ATM covered calls with 7-30 DTE on green names. Be patient for better put-selling entries.';
    tags.push('NO CSPS', 'ATM CCS 7-30 DTE', 'OVERBOUGHT');
  } else {
    text = 'Momentum is in the middle zone. Use OTM CSPs on red days and OTM covered calls on green days, generally in the 7-30 DTE range. Stay flexible and let price direction guide which side gets priority.';
    tags.push('OTM CSPS 7-30 DTE', 'OTM CCS 7-30 DTE', 'NEUTRAL RSI');
  }

  if (redDay) tags.push('LOOK FOR RED-DAY CSPS');
  if (greenDay) tags.push('LOOK FOR GREEN-DAY CCS');
  if ((vix?.changePct || 0) > 5) tags.push('VOLATILITY UP');

  return { mood, text, tags: [...new Set(tags)].slice(0, 5) };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  try {
    const quoteMap = await fetchQuotes(['SPY', 'QQQ', '^VIX', 'BTC-USD']);
    const [SPY, QQQ, VIX, BTC] = await Promise.all([
      getSymbolData('SPY', 'SPY', quoteMap['SPY']),
      getSymbolData('QQQ', 'QQQ', quoteMap['QQQ']),
      getSymbolData('VIX', '^VIX', quoteMap['^VIX']),
      getSymbolData('BTC', 'BTC-USD', quoteMap['BTC-USD']),
    ]);
    const market = { SPY, QQQ, VIX, BTC };
    const strategy = buildStrategy(market);
    const events = [
      { time: '—', name: 'Economic calendar API not wired yet in this fast version', impact: 'low', forecast: '', prior: '' }
    ];
    return json(res, 200, { market, strategy, events });
  } catch (error) {
    return json(res, 500, { error: error.message || 'Dashboard failed' });
  }
};
