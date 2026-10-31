export const safetyStatuses = [
  [1, '無事（軽傷含む）'], [2, '負傷者（要搬送）'], [3, '行方不明者・生き埋め'], [4, '死亡者']
];
export const buildingStatuses = [
  [1, '無事'], [2, '建物倒壊・損壊'], [3, '火災の発生'], [4, '断水・停電等']
];
export const safetyEventKey = association => association.safetyEventKey || 'initial';
export const memberSafetyStatus = (report, memberId) => {
  const value = report?.memberStatuses instanceof Map ? report.memberStatuses.get(String(memberId)) : report?.memberStatuses?.[String(memberId)];
  return [1, 2, 3, 4].includes(value) ? value : null;
};
export const householdSafetyState = (members, report) => {
  const confirmed = members.filter(member => memberSafetyStatus(report, member._id) !== null).length;
  return { total: members.length, confirmed, complete: members.length > 0 && confirmed === members.length };
};

export function summarizeSafety(households, members, reports) {
  const householdIds = new Set(households.map(h => String(h._id)));
  const currentMembers = members.filter(m => householdIds.has(String(m.household)) && !m.endsAt);
  const reportsByHousehold = new Map(reports.map(r => [String(r.household), r]));
  const grouped = new Map();
  currentMembers.forEach(member => {
    const id = String(member.household);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(member);
  });
  const people = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const buildings = { 2: 0, 3: 0, 4: 0 };
  const supportMembers = [], damagedHouseholds = [];
  let confirmedHouseholds = 0, confirmedPeople = 0;
  for (const household of households) {
    const family = grouped.get(String(household._id)) || [];
    const report = reportsByHousehold.get(String(household._id));
    const state = householdSafetyState(family, report);
    if (state.complete) confirmedHouseholds++;
    confirmedPeople += state.confirmed;
    for (const member of family) {
      const status = memberSafetyStatus(report, member._id);
      if (status) people[status]++;
      if (member.supportRequired === true) supportMembers.push({ member, household, status });
    }
    if ([2, 3, 4].includes(report?.buildingStatus)) {
      buildings[report.buildingStatus]++;
      damagedHouseholds.push({ household, report });
    }
  }
  supportMembers.sort((a, b) => (a.member.supportPriority || 4) - (b.member.supportPriority || 4));
  return {
    totalHouseholds: households.length, totalPeople: currentMembers.length,
    confirmedHouseholds, confirmedPeople,
    unconfirmedHouseholds: households.length - confirmedHouseholds,
    unconfirmedPeople: currentMembers.length - confirmedPeople,
    people, buildings, supportMembers, damagedHouseholds,
    supportHouseholds: new Set(supportMembers.map(item => String(item.household._id))).size,
    supportPeople: supportMembers.length
  };
}
