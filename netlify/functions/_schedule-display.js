'use strict';
// Pure schedule display utilities.
// Used by tests directly; logic is also inlined in index.html for browser use.

/**
 * Returns { iso: 'YYYY-MM-DD', wd: 'mo'|'di'|... } for Europe/Berlin.
 * Accepts an optional Date override for testing.
 */
function berlDate(now) {
  const d = now || new Date();
  const iso = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(d);
  const [y, m, day] = iso.split('-').map(Number);
  const wd = ['so', 'mo', 'di', 'mi', 'do', 'fr', 'sa'][new Date(Date.UTC(y, m - 1, day, 12)).getUTCDay()];
  return { iso, wd };
}

/**
 * Returns today's hours for activity `a` as { open, close } | { closed: true } | null.
 * Uses schedule.exceptions to override schedule.regularHours.
 */
function todayHoursFor(a, today, todayWd) {
  const sch = a.schedule;
  if (!sch) return null;
  const exc = (sch.exceptions || []).find(e => e.date === today);
  if (exc) {
    if (exc.closed) return { closed: true };
    if (exc.open && exc.close) return { open: exc.open, close: exc.close };
    return null;
  }
  const reg = (sch.regularHours || []).find(h => Array.isArray(h.days) && h.days.includes(todayWd));
  if (reg && reg.open && reg.close) return { open: reg.open, close: reg.close };
  return null;
}

/**
 * Returns a plain-text schedule hint string for a discovery card.
 * today/todayWd are optional (for testing); if omitted, uses berlDate().
 */
function cardScheduleHint(a, today, todayWd) {
  const sch = a.schedule;
  const op = a.operatingPeriod;
  if (!sch && !op) return '';

  const parts = [];

  // Date range / operating period
  const period = (sch && sch.period) || op;
  if (period && period.from && period.to) {
    const fmtD = s => { const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`; };
    if (period.to >= today) {
      parts.push(period.from <= today
        ? `bis ${fmtD(period.to)}`
        : `${fmtD(period.from)}–${fmtD(period.to)}`);
    }
  }

  // Next specific date (soonest on or after today)
  if (sch && sch.dates && sch.dates.length) {
    const future = sch.dates.filter(d => d.date >= today).slice(0, 1);
    if (future.length) {
      const d = future[0];
      const [y, m, day] = d.date.split('-');
      let s = `${day}.${m}.`;
      if (d.date.slice(0, 4) !== today.slice(0, 4)) s += y;
      if (d.startTime) s += ` ${d.startTime}`;
      if (d.endTime) s += `–${d.endTime} Uhr`;
      parts.push(s);
    }
  }

  // Today's opening hours (exceptions override regular hours)
  const todayH = todayHoursFor(a, today, todayWd);
  if (todayH) {
    if (todayH.closed) parts.push('heute geschlossen');
    else parts.push(`Heute ${todayH.open}–${todayH.close} Uhr`);
  }

  return parts.join(' · ');
}

module.exports = { berlDate, todayHoursFor, cardScheduleHint };
