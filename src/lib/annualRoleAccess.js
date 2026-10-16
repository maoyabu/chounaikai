// Annual roles follow the April fiscal year in Japan, regardless of server timezone.
export const annualRoleYear = (now = new Date()) => {
  const japan = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return japan.getUTCFullYear() - (japan.getUTCMonth() < 3 ? 1 : 0);
};

export const annualRoleYears = (now = new Date()) => {
  const year = annualRoleYear(now);
  const month = new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCMonth();
  return month === 3 ? [year, year - 1] : [year];
};
export const annualRoleYearFilter = (now = new Date()) => ({ $in: annualRoleYears(now) });
// Keep current-year details when a person continues in the same menu role.
export const uniqueAnnualMenuRoles = (rows, key) => [...new Map(
  [...rows].sort((a, b) => a.fiscalYear - b.fiscalYear).map(row => [key(row), row])
).values()];
