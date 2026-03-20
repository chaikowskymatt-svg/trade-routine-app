function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(payload));
}

function calculateRSI(closes, period = 14) {
  const values = closes.filter(v => typeof v === 'number' && !Number.isNaN(v));
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function toWeeklyCloses(closes) {
  const out = [];
  for (let i = 4; i < closes.length; i += 5) out.push(closes[i]);
  if (closes.length && out[out.length - 1] !== closes[closes.length - 1]) {
    out.push(closes[closes.length - 1]);
  }
  return out;
}

function noteFor(symbol, changePct, avgRSI) {
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

async function fetchYahooChart(symbol, range = '1y', interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });

  if (!response.ok) {
    throw new Error(`Yahoo chart request failed for ${symbol}`);
  }

  const data = await response.json();
  const result = data?.chart?.result?.[0];

  if (!result) {
    throw new Error(`No chart data for ${symbol}`);
  }

  return result;
}

function validNumbers(arr) {
  return (arr || []).filter(v => typeof v === 'number' && !Number.isNaN(v));
}

function getCloses(result) {
  return validNumbers(result?.indicators?.quote?.[0]?.close);
}

function getDailyChangeFromShortResult(result, label) {
  const closes = getCloses(result);

  if (closes.length < 2) {
    throw new Error(`Not enough short-term data for ${label}`);
  }

  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];

  if (typeof last !== 'number' || typeof prev !== 'number' || prev === 0) {
    throw new Error(`Invalid short-term pricing for ${label}`);
  }

  return ((last - prev) / prev) * 100;
}

async function getSymbolData(label, yahooSymbol) {
  // Long-term: RSI + price level
  const longResult = await fetchYahooChart(yahooSymbol, '1y', '1d');
  const longCloses = getCloses(longResult);
  const last = longCloses[longCloses.length - 1];

  if (longCloses.length < 20 || typeof last !== 'number') {
    throw new Error(`Not enough price history for ${label}`);
  }

  // Short-term: true day-over-day CHG%
  const shortResult = await fetchYahooChart(yahooSymbol, '5d', '1d');
  const rawChangePct = getDailyChangeFromShortResult(shortResult, label);

  const dailyRSI = calculateRSI(longCloses, 14);
  const weeklyRSI = calculateRSI(toWeeklyCloses(longCloses), 14);
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

function buildStrategy(market) {
  const spy = market.SPY;
  const qqq = market.QQQ;
  const vix = market.VIX;
  const avgIndexRSI = ((spy?.avgRSI || 50) + (qqq?.avgRSI || 50)) / 2;
  const redDay = (spy?.changePct || 0) < 0 || (qqq?.changePct || 0) < 0;
  const greenDay = (spy?.changePct || 0) > 0 || (qqq?.changePct || 0) > 0;

  let mood = 'NEUTRAL';
  if ((spy?.changePct || 0) > 0.5 && (qqq?.changePct || 0) > 0.5 && (vix?.changePct || 0) < 0) {
    mood = 'BULLISH';
  } else if ((spy?.changePct || 0) < -0.5 && (qqq?.changePct || 0) < -0.5 && (vix?.changePct || 0) > 0) {
    mood = 'BEARISH';
  } else if (Math.abs(spy?.changePct || 0) < 0.4 && Math.abs(qqq?.changePct || 0) < 0.4) {
    mood = 'CHOPPY';
  }

  let text = '';
  const tags = [];

  if (avgIndexRSI < 35) {
    text = 'Indexes are oversold. Focus on quality names for CSP entries, especially on weakness.';
    tags.push('LOOK FOR CSP', 'OVERSOLD');
  } else if (avgIndexRSI > 65) {
    text = 'Indexes are extended. Favor covered calls into strength and avoid forcing new CSP risk.';
    tags.push('LOOK FOR CC', 'EXTENDED');
  } else if (redDay) {
    text = 'Moderate weakness today. Favor OTM CSP setups in names you want to own.';
    tags.push('RED DAY', 'OTM CSP');
  } else if (greenDay) {
    text = 'Green tape today. Favor OTM covered calls on positions that are already working.';
    tags.push('GREEN DAY', 'OTM CC');
  } else {
    text = 'Mixed session. Stay selective and let setup quality drive entries.';
    tags.push('SELECTIVE');
  }

  if ((vix?.changePct || 0) > 5) tags.push('HIGHER VOL');
  if ((vix?.changePct || 0) < -5) tags.push('LOWER VOL');

  return { mood, text, tags };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  try {
    const symbols = {
      SPY: 'SPY',
      QQQ: 'QQQ',
      VIX: '^VIX',
      BTC: 'BTC-USD',
    };

    const entries = await Promise.all(
      Object.entries(symbols).map(async ([label, symbol]) => {
        const data = await getSymbolData(label, symbol);
        return [label, data];
      })
    );

    const market = Object.fromEntries(entries);
    const strategy = buildStrategy(market);

    return json(res, 200, {
      market,
      strategy,
      source: 'yahoo_chart_short_and_long',
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return json(res, 500, { error: error.message || 'Dashboard failed' });
  }
};
