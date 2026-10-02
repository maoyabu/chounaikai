const fail = message => Object.assign(new Error(message), { status: 400 });
const dayMs = 86400000;
export const nextEquipmentDate = date => new Date(Date.parse(`${date}T00:00:00Z`) + dayMs).toISOString().slice(0, 10);
const midnight = date => new Date(`${date}T00:00:00+09:00`).getTime();
export const equipmentTimeMinutes = (time, end = false) => {
  if (end && time === '24:00') return 1440;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time || ''))) throw fail('開始・終了時刻を正しく入力してください。');
  const [hour, minute] = time.split(':').map(Number); return hour * 60 + minute;
};
export const equipmentMinuteTime = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
export const equipmentLoanTimes = ({ startDate, endDate, allDay, startTime, endTime }) => {
  const fullDay = ['on', '1', true].includes(allDay) || (allDay === undefined && !startTime && !endTime);
  const first = fullDay ? 0 : equipmentTimeMinutes(startTime), last = fullDay ? 1440 : equipmentTimeMinutes(endTime, true);
  const startAt = new Date(midnight(startDate) + first * 60000), endAt = new Date(midnight(endDate) + last * 60000);
  if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) throw fail('終了日時は開始日時より後にしてください。');
  return { allDay: fullDay, startTime: fullDay ? '' : startTime, endTime: fullDay ? '' : endTime, startAt, endAt };
};
export const equipmentLoanWindow = loan => {
  if (loan.startAt && loan.endAt) return { start: new Date(loan.startAt).getTime(), end: new Date(loan.endAt).getTime() };
  const times = equipmentLoanTimes({ ...loan, endDate: loan.endDate || loan.startDate });
  return { start: times.startAt.getTime(), end: times.endAt.getTime() };
};
export const equipmentReservations = (item, loans) => {
  const result = new Map();
  const known = new Map(loans.map(loan => [String(loan._id), loan]));
  for (const slot of item.reservations || []) {
    const loan = known.get(String(slot.loanId));
    if (!loan || ['pending', 'approved'].includes(loan.status)) result.set(String(slot.loanId), { ...slot, _id: slot.loanId, status: loan?.status || 'pending' });
  }
  for (const loan of loans) if (['pending', 'approved'].includes(loan.status)) result.set(String(loan._id || `legacy-${result.size}`), loan);
  return [...result.values()];
};
export const equipmentWindowCapacity = (item, loans, start, end) => {
  for (const block of item.loanBlocks || []) { const window = equipmentLoanWindow(block); if (window.start < end && window.end > start) return 0; }
  const events = new Map([[start, 0]]);
  for (const loan of loans) {
    if (!['pending', 'approved'].includes(loan.status)) continue;
    const window = equipmentLoanWindow(loan);
    if (window.start >= end || window.end <= start) continue;
    const first = Math.max(start, window.start), last = Math.min(end, window.end);
    events.set(first, (events.get(first) || 0) + loan.quantity);
    if (last < end) events.set(last, (events.get(last) || 0) - loan.quantity);
  }
  let used = 0, peak = 0;
  for (const [, count] of [...events].sort(([a], [b]) => a - b)) { used += count; peak = Math.max(peak, used); }
  return Math.max(0, item.quantity - peak);
};
export const equipmentDaySchedule = (item, loans, date) => {
  const start = midnight(date), end = start + dayMs, boundaries = new Set([0, 1440]);
  const active = equipmentReservations(item, loans);
  for (const loan of active) { const window = equipmentLoanWindow(loan); if (window.start < end && window.end > start) { boundaries.add(Math.max(0, (window.start - start) / 60000)); boundaries.add(Math.min(1440, (window.end - start) / 60000)); } }
  const blocks = (item.loanBlocks || []).map(equipmentLoanWindow).filter(window => window.start < end && window.end > start);
  for (const window of blocks) { boundaries.add(Math.max(0, (window.start - start) / 60000)); boundaries.add(Math.min(1440, (window.end - start) / 60000)); }
  const allowed = item.lendable && !item.wishlist && (!item.availableFrom || date >= item.availableFrom) && (!item.availableUntil || date <= item.availableUntil);
  const times = [...boundaries].sort((a, b) => a - b);
  return times.slice(0, -1).map((first, index) => {
    const last = times[index + 1], blocked = blocks.some(window => window.start < start + last * 60000 && window.end > start + first * 60000), available = allowed && !blocked ? equipmentWindowCapacity(item, active, start + first * 60000, start + last * 60000) : 0;
    return { startTime: equipmentMinuteTime(first), endTime: equipmentMinuteTime(last), startMinute: first, endMinute: last, available, used: allowed && !blocked ? Math.max(0, item.quantity - available) : 0, blocked: blocked || !allowed };
  });
};
