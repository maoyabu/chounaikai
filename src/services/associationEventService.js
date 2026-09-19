import { AssociationEvent } from '../models/associationEvent.js';

const fail = message => Object.assign(new Error(message), { status: 400 });
const required = (value, max, label) => {
  const result = String(value || '').trim();
  if (!result || result.length > max) throw fail(`${label}は1〜${max}文字で入力してください。`);
  return result;
};
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export const eventValues = body => {
  const title = required(body.title, 120, '行事タイトル');
  const description = required(body.body, 5000, '行事内容');
  const startDate = String(body.startDate || '');
  const hasEndDate = body.hasEndDate === 'on';
  const endDate = hasEndDate ? String(body.endDate || '') : startDate;
  if (!validDate(startDate) || !validDate(endDate) || endDate < startDate || (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000 > 366) throw fail('行事の日付を確認してください（期間は366日以内）。');
  const startTime = body.allDay === 'on' ? '00:00' : String(body.startTime || ''), endTime = body.allDay === 'on' ? '23:59' : String(body.endTime || '');
  if (![startTime, endTime].every(value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value))) throw fail('開始時間と終了時間を確認してください。');
  if (hasEndDate && startDate === endDate && endTime <= startTime) throw fail('終了時間は開始時間より後にしてください。');
  const category = required(body.category, 40, '行事分類');
  const color = String(body.color || '');
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw fail('分類カラーを選択してください。');
  const frequency = ['none', 'daily', 'weekly', 'monthly', 'yearly'].includes(body.recurrenceFrequency) ? body.recurrenceFrequency : 'none';
  const weekdays = [...new Set([].concat(body.weekdays || []).map(Number).filter(day => day >= 0 && day <= 6))];
  const monthDays = [...new Set(String(body.monthDays || '').split(',').map(value => Number(value.trim())).filter(day => day >= 1 && day <= 31))];
  const yearMonth = Number(body.yearMonth), yearDay = Number(body.yearDay);
  const until = String(body.recurrenceUntil || '');
  if (frequency !== 'none' && until && !validDate(until)) throw fail('繰り返し終了日を確認してください。');
  return { title, body: description, startDate, endDate, startTime, endTime, hasEndDate, allDay: body.allDay === 'on', category, color,
    recurrence: { frequency, weekdays: frequency === 'weekly' ? weekdays : [], monthDays: frequency === 'monthly' ? monthDays : [], yearMonth: frequency === 'yearly' && yearMonth >= 1 && yearMonth <= 12 ? yearMonth : undefined, yearDay: frequency === 'yearly' && yearDay >= 1 && yearDay <= 31 ? yearDay : undefined, until: frequency === 'none' ? '' : until },
    visible: body.visible === 'on', open: body.open === 'on', imageCaption: String(body.imageCaption || '').trim().slice(0, 200), youtubeUrl: String(body.youtubeUrl || '').trim(), qrUrl: String(body.qrUrl || '').trim(), qrCaption: String(body.qrCaption || '').trim().slice(0, 200) };
};

export const calendarMonths = (now = new Date()) => {
  const months = [];
  for (let offset = 0; offset < 3; offset++) {
    const year = now.getFullYear(), month = now.getMonth() + offset;
    const first = new Date(year, month, 1), last = new Date(year, month + 1, 0);
    const cells = Array(first.getDay()).fill(null);
    for (let day = 1; day <= last.getDate(); day++) cells.push(`${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    months.push({ label: `${first.getFullYear()}年${first.getMonth() + 1}月`, cells });
  }
  return months;
};

export const calendarWindow = (monthValue, today = new Date()) => {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(monthValue || ''));
  const year = match ? Number(match[1]) : today.getFullYear();
  const month = match ? Number(match[2]) - 1 : today.getMonth();
  const first = new Date(year >= 1900 && year <= 2200 ? year : today.getFullYear(), year >= 1900 && year <= 2200 ? month : today.getMonth(), 1);
  const key = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  return { first, currentMonth: key(first), previousMonth: key(new Date(first.getFullYear(), first.getMonth() - 1, 1)), nextMonth: key(new Date(first.getFullYear(), first.getMonth() + 1, 1)), months: calendarMonths(first) };
};

export const expandRecurringEvents = (events, rangeStart, rangeEnd) => {
  const result = [];
  for (const event of events) {
    const recurrence = event.recurrence || { frequency: 'none' };
    if (!recurrence.frequency || recurrence.frequency === 'none') { result.push(event); continue; }
    const start = new Date(event.startDate + 'T00:00:00Z'), limit = new Date((recurrence.until || rangeEnd) + 'T00:00:00Z');
    for (let cursor = new Date(start); cursor <= limit && cursor <= new Date(rangeEnd + 'T00:00:00Z'); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const day = cursor.getUTCDay(), date = cursor.toISOString().slice(0, 10);
      const matches = recurrence.frequency === 'daily' || (recurrence.frequency === 'weekly' && (recurrence.weekdays || []).includes(day)) || (recurrence.frequency === 'monthly' && (recurrence.monthDays || []).includes(cursor.getUTCDate())) || (recurrence.frequency === 'yearly' && cursor.getUTCMonth() + 1 === recurrence.yearMonth && cursor.getUTCDate() === recurrence.yearDay);
      if (matches && date >= rangeStart) result.push({ ...event, startDate: date, endDate: date });
    }
  }
  return result;
};

export const visibleEvents = async (associationIds, { publicOnly = false, now = new Date() } = {}) => {
  if (!associationIds.length) return [];
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const after = new Date(now.getFullYear(), now.getMonth() + 3, 1);
  const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const start = localDate(first), end = localDate(after);
  const events = await AssociationEvent.find({ association: { $in: associationIds }, visible: true, ...(publicOnly ? { open: true } : {}) }).sort({ startDate: 1, startTime: 1 }).lean();
  return expandRecurringEvents(events, start, end).filter(event => event.startDate < end && event.endDate >= start);
};
