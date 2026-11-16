import { MonthlyReport } from '../models/monthlyReport.js';
import { AssociationEvent } from '../models/associationEvent.js';
import { Department } from '../models/organization.js';
import { AnnualDepartmentPlan } from '../models/annualDepartmentPlan.js';
import { Finance } from '../models/finance.js';
import { expandRecurringEvents } from './associationEventService.js';

const badRequest = message => Object.assign(new Error(message), { status: 400 });
export const currentReportMonth = (now = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(now);
export const shiftReportMonth = (month, offset) => {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + offset, 1)).toISOString().slice(0, 7);
};
export const reportPeriod = value => {
  if (typeof value !== 'string' || !/^(20\d{2}|21\d{2}|2200)-(0[1-9]|1[0-2])$/.test(value)) throw badRequest('対象月を2000年1月から2200年12月の範囲で選択してください。');
  return { month: value, previousMonth: shiftReportMonth(value, -1), nextMonth: shiftReportMonth(value, 1), futureEndMonth: shiftReportMonth(value, 13) };
};
export const reportMonthLabel = month => `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`;
export const eventSchedule = event => `${event.startDate}${event.allDay ? '（終日）' : ` ${event.startTime || ''}`}${event.endDate && event.endDate !== event.startDate ? ` ～ ${event.endDate}` : ''}${!event.allDay && event.endTime ? ` ～ ${event.endTime}` : ''}`;
const monthStart = month => new Date(`${month}-01T00:00:00+09:00`);
const inMonth = (event, month) => event.startDate < `${shiftReportMonth(month, 1)}-01` && (event.endDate || event.startDate) >= `${month}-01`;

export function buildMonthlyReport({ association, month, information = '', entries = [], events = [], departments = [], plans = [] }) {
  const period = reportPeriod(month);
  const year = Number(month.slice(0, 4)), number = Number(month.slice(5));
  const startMonth = Number(association.financeFiscalStartMonth || 4);
  const fiscalYear = year - (number < startMonth ? 1 : 0);
  const fiscalStartMonth = `${fiscalYear}-${String(startMonth).padStart(2, '0')}`;
  const financeEnabled = association.optionalFeatures?.finance === true && Boolean(association.group);
  let income = 0, expense = 0;
  for (const entry of entries) {
    const date = new Date(entry.date);
    if (date < monthStart(fiscalStartMonth) || date >= monthStart(period.nextMonth) || Number.isNaN(date.getTime())) continue;
    const amount = Number(entry.amount);
    if (!Number.isFinite(amount)) throw new Error('会計データの金額を確認してください。');
    if (entry.cf === '収入') income += amount;
    else if (entry.cf === '支出') expense += amount;
  }
  const eligible = events.filter(event => !event.group && event.visible !== false && (!event.association || String(event.association) === String(association._id)));
  const expanded = expandRecurringEvents(eligible, `${period.previousMonth}-01`, `${period.futureEndMonth}-01`)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || String(a.startTime || '').localeCompare(String(b.startTime || '')) || String(a.title).localeCompare(String(b.title), 'ja'));
  const previousEvents = expanded.filter(event => inMonth(event, period.previousMonth));
  const currentEvents = expanded.filter(event => inMonth(event, month));
  // Single events are listed without a future cutoff. Recurring series need a finite window.
  const futureEvents = expanded.filter(event => event.startDate >= `${period.nextMonth}-01` && (!event.recurrence?.frequency || event.recurrence.frequency === 'none' || event.startDate < `${period.futureEndMonth}-01`));
  const departmentMap = new Map(departments.map(department => [String(department._id), { ...department, currentEvents: [], futureEvents: [], annualReport: '' }]));
  const byName = new Map(departments.map(department => [department.name, String(department._id)]));
  const unassigned = { _id: '', name: '担当部未設定', currentEvents: [], futureEvents: [], annualReport: '' };
  for (const plan of plans) {
    const department = departmentMap.get(String(plan.department?._id || plan.department));
    if (department) department.annualReport = plan.report || '';
  }
  for (const [key, items] of [['currentEvents', currentEvents], ['futureEvents', futureEvents]]) {
    for (const event of items) {
      const id = event.department ? String(event.department?._id || event.department) : byName.get(event.category);
      (departmentMap.get(id) || unassigned)[key].push(event);
    }
  }
  const departmentReports = [...departmentMap.values()];
  if (unassigned.currentEvents.length || unassigned.futureEvents.length) departmentReports.push(unassigned);
  return { ...period, information, previousEvents, departmentReports,
    finance: { enabled: financeEnabled, fiscalYear, fiscalStartMonth, income, expense, carryover: income - expense },
    futureNote: `次月以降の単発行事は登録済みの全件、繰り返し行事は${reportMonthLabel(period.nextMonth)}から12か月分を表示します。`,
    eventNote: '町内会行事の公開済みデータを使用します。担当部未登録の既存行事は、分類名と部名が一致する場合に部へ振り分けます。繰り返し行事の完了・実施報告は元の行事に登録された共通内容です。'
  };
}

export async function loadMonthlyReport({ association, month }) {
  const period = reportPeriod(month);
  const [year, number] = month.split('-').map(Number);
  const startMonth = Number(association.financeFiscalStartMonth || 4);
  const fiscalYear = year - (number < startMonth ? 1 : 0);
  const [saved, departments, events, plans, entries] = await Promise.all([
    MonthlyReport.findOne({ association: association._id, month }).lean(),
    Department.find({ association: association._id }).sort({ sortOrder: 1, name: 1 }).lean(),
    AssociationEvent.find({ association: association._id, group: null, visible: true }).select('association group department title category startDate endDate startTime endTime allDay recurrence completed implementationReport visible').sort({ startDate: 1, startTime: 1 }).lean(),
    AnnualDepartmentPlan.find({ association: association._id, fiscalYear: year - (number < 4 ? 1 : 0) }).lean(),
    association.optionalFeatures?.finance === true && association.group
      ? Finance.find({ group: association.group, date: { $gte: monthStart(`${fiscalYear}-${String(startMonth).padStart(2, '0')}`), $lt: monthStart(period.nextMonth) } }).select('date cf amount').lean()
      : []
  ]);
  return buildMonthlyReport({ association, month, information: saved?.information || '', departments, events, plans, entries });
}

export async function saveMonthlyInformation({ association, month, information, user }) {
  reportPeriod(month);
  if (typeof information !== 'string' || information.length > 20000) throw badRequest('情報共有事項は20,000文字以内で入力してください。');
  return MonthlyReport.findOneAndUpdate({ association, month }, { $set: { information: information.trim(), updatedBy: user } }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true });
}
