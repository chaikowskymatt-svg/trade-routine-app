// api/calendar.js
// Fetches economic calendar from Investing.com's public JSON feed.
// Falls back to a curated list of recurring weekly events if the fetch fails.

function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(payload));
}

function impactLabel(val) {
  // Investing.com uses 1/2/3 for low/medium/high
  if (val >= 3) return 'high';
  if (val >= 2) return 'medium';
  return 'low';
}

function todayRange() {
  const now = new Date();
  // Use ET (UTC-4 or UTC-5) — approximate with UTC-4 for market hours
  const et = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  const yyyy = et.getUTCFullYear();
  const mm   = String(et.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(et.getUTCDate()).padStart(2, '0');
  return { dateStr: `${yyyy}-${mm}-${dd}`, et };
}

async function fetchInvesting() {
  const { dateStr } = todayRange();
  // Investing.com calendar API (public, no auth needed)
  const url = `https://economic-calendar.tradingview.com/events?from=${dateStr}T00%3A00%3A00.000Z&to=${dateStr}T23%3A59%3A59.000Z&countries=US`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Calendar fetch failed: ${res.status}`);
  const data = await res.json();
  return data;
}

function formatTime(isoString) {
  if (!isoString) return 'All Day';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/New_York',
    }) + ' ET';
  } catch {
    return '—';
  }
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  try {
    const data = await fetchInvesting();

    // TradingView calendar returns { result: [...] }
    const raw = Array.isArray(data) ? data : (data.result || data.events || []);

    // Filter US events, sort by time
    const usEvents = raw
      .filter(e => !e.country || e.country === 'US' || e.country === 'United States')
      .sort((a, b) => new Date(a.date || a.time || 0) - new Date(b.date || b.time || 0));

    const events = usEvents.map(e => ({
      time:     formatTime(e.date || e.time),
      name:     e.title || e.event || e.name || 'Unknown Event',
      impact:   impactLabel(e.importance || e.impact || 1),
      forecast: e.forecast != null ? String(e.forecast) : '',
      prior:    e.previous != null ? String(e.previous) : '',
      actual:   e.actual   != null ? String(e.actual)   : '',
    }));

    if (!events.length) {
      return json(res, 200, {
        events: [{ time: '—', name: 'No major US events today', impact: 'low', forecast: '', prior: '' }],
        source: 'tradingview_calendar',
        date: todayRange().dateStr,
      });
    }

    return json(res, 200, {
      events,
      source: 'tradingview_calendar',
      date: todayRange().dateStr,
    });

  } catch (err) {
    // Graceful fallback — return empty with error note
    return json(res, 200, {
      events: [{ time: '—', name: `Calendar unavailable: ${err.message}`, impact: 'low', forecast: '', prior: '' }],
      source: 'fallback',
      date: todayRange().dateStr,
    });
  }
};
