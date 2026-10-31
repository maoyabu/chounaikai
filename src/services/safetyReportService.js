import { randomUUID } from 'node:crypto';
import { loadOfficerSafety } from './safetyService.js';
import { loadQuestionBoxAccess } from './questionBoxService.js';

const lifetime = 60 * 60 * 1000;
const fail = (message, status) => Object.assign(new Error(message), { status });

export function makeSafetyReport(association, summary, now = new Date()) {
  return {
    token: randomUUID(), associationId: String(association._id), associationName: association.name,
    createdAt: now.toISOString(),
    totalHouseholds: summary.totalHouseholds, totalPeople: summary.totalPeople,
    confirmedHouseholds: summary.confirmedHouseholds, confirmedPeople: summary.confirmedPeople,
    unconfirmedHouseholds: summary.unconfirmedHouseholds, unconfirmedPeople: summary.unconfirmedPeople,
    people: { ...summary.people }, buildings: { ...summary.buildings },
    supportHouseholds: summary.supportHouseholds, supportPeople: summary.supportPeople
  };
}

export async function createSafetyReport(associationId, userId, session) {
  const { association, summary } = await loadOfficerSafety(associationId, userId);
  const report = makeSafetyReport(association, summary);
  const recent = (session.safetyReports || []).filter(item => Date.now() - new Date(item.createdAt).getTime() < lifetime);
  // Keep only aggregate totals, bounded in size and owned by the creating session.
  session.safetyReports = [...recent.slice(-4), report];
  return report;
}

export async function loadSafetyReport(associationId, userId, token, session) {
  const { association, canAnswer } = await loadQuestionBoxAccess({ associationId, userId });
  if (!canAnswer) throw fail('役員・町内会管理者のみレポートを確認できます。', 403);
  const report = (session.safetyReports || []).find(item => item.token === token && item.associationId === String(association._id));
  if (!report) throw fail('レポートを確認できません。安否確認ページから作成してください。', 404);
  if (Date.now() - new Date(report.createdAt).getTime() >= lifetime) throw fail('レポートの表示期限が切れました。安否確認ページから作成し直してください。', 410);
  return report;
}
