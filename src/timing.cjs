function timingConfig(value, heats) {
  if (!value || value.mode === 'off') return { mode: 'off' };
  if (!['records', 'simulation'].includes(value.mode) || !Number.isInteger(value.heat) || !heats.includes(value.heat) || value.heat !== Math.max(...heats)) throw Error('Timing heat must be the last selected standings heat.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !Number.isFinite(Date.parse(value.date + 'T00:00:00Z'))) throw Error('Timing needs a calendar date.');
  if (!Number.isInteger(value.utcOffsetMinutes) || Math.abs(value.utcOffsetMinutes) > 840) throw Error('Invalid timing UTC offset.');
  if (!Array.isArray(value.startStatuses) || !value.startStatuses.length || value.startStatuses.length > 32 || value.startStatuses.some(s => !Number.isInteger(s) || s < 0 || s > 2147483647)) throw Error('Explicit verified startStatuses are required.');
  return { ...value, startStatuses: [...new Set(value.startStatuses)] };
}
function addTiming(state, cache, config, now = Date.now()) {
  const timing = timingConfig(config.timing, config.heats);
  state.active = {}; state.timing = { lastStartAtMs: null };
  if (timing.mode === 'off') return state;
  state.competition.runningTimersSupported = true;
  state.competition.timingMode = timing.mode;
  if (timing.mode === 'records') state.competition.warnings.push('Experimental start-record mapping: validate status codes, event date and timing-device clock against live VOLA.');
  const midnight = Date.parse(timing.date + 'T00:00:00Z') - timing.utcOffsetMinutes * 60000;
  const readHeats = config.autoStandings ? config.readHeats : [timing.heat];
  const competitors = new Map(Object.values(state.competitors).map(p => [p.bib, p]));
  const starts = new Map();
  for (const heat of readHeats) for (const row of cache.get(`1:TTIMERECORDS_HEAT${heat}_START`) || []) {
    if (!timing.startStatuses.includes(row.C_STATUS) || !/^\d+$/.test(String(row.C_HOUR2))) continue;
    const micros = Number(row.C_HOUR2);
    if (!Number.isSafeInteger(micros) || micros < 0 || micros >= 86400000000) continue;
    const startedAtMs = midnight + micros / 1000;
    if (startedAtMs > now + 1000) continue;
    const bib = String(row.C_NUM), p = competitors.get(bib); if (!p) continue;
    if (!starts.has(bib) || heat > starts.get(bib).heat || (heat === starts.get(bib).heat && startedAtMs > starts.get(bib).startedAtMs)) starts.set(bib, { row, startedAtMs, p, heat });
  }
  for (const [bib, { row, startedAtMs, p, heat }] of starts) {
    state.timing.lastStartAtMs = Math.max(state.timing.lastStartAtMs ?? 0, startedAtMs);
    const result = cache.get(`1:TTIMEINFOS_HEAT${heat}`).find(r => String(r.C_NUM) === bib);
    if (result && ([1, 2, 3].includes(result.C_STATUS) || (result.C_STATUS === 0 && result.C_TIME > 0))) continue;
    let baseTimeMs = 0;
    for (const h of (config.readHeats || config.heats).filter(h => h < heat)) {
      const previous = cache.get(`1:TTIMEINFOS_HEAT${h}`).find(r => String(r.C_NUM) === bib);
      if (previous?.C_STATUS === 0 && previous.C_TIME > 0) baseTimeMs += previous.C_TIME;
    }
    state.active[p.id] = { id: p.id, competitorId: p.id, bib, runId: `${heat}:${row.C_LINE}:${startedAtMs}`, startedAtMs, baseTimeMs };
  }
  return state;
}
module.exports = { timingConfig, addTiming };
