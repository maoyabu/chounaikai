export const optionalAssociationFeatures = [
  ['goodPlaces', 'わがまちのいいところ'],
  ['events', '町内会行事カレンダー'],
  ['groups', 'グループ機能（PRページ・行事管理・グループ間コミュニケーション）'],
  ['equipment', '設備・備品の貸出'],
  ['finance', '町内会会計管理']
];

export const associationFeatureEnabled = (association, feature) => association?.optionalFeatures?.[feature] === true;
export const parseAssociationFeatures = (input = {}) => Object.fromEntries(
  optionalAssociationFeatures.map(([key]) => [key, input[key] === 'on'])
);

export const featureForAssociationPath = path => {
  const match = path.match(/^\/associations\/([^/]+)\/(good-places|events|groups|equipment|finance|manage\/groups)(?:\/|$)/);
  if (!match) return null;
  return { associationId: match[1], feature: { 'good-places': 'goodPlaces', 'manage/groups': 'groups' }[match[2]] || match[2] };
};

// Display preferences are independent of optional feature availability.
export const residentDisplayFeatures = [
  ['departmentPlans', '各部会の目標'],
  ['officers', '今年度の町内会役員一覧'],
  ['districts', '町内会の班一覧'],
  ['leaders', '今年度の町内会班長']
];
export const residentDisplayEnabled = (association, key) => association?.residentDisplay?.[key] !== false && (key !== 'leaders' || association?.residentDisplay?.districts !== false);
export const residentDisplaySettings = association => Object.fromEntries(
  residentDisplayFeatures.map(([key]) => [key, residentDisplayEnabled(association, key)])
);
// Mobile apps hide menus with these values; the APIs still enforce each setting.
export const associationFeatureSettings = association => Object.fromEntries(
  optionalAssociationFeatures.map(([key]) => [key, associationFeatureEnabled(association, key)])
);
export const parseResidentDisplay = (input = {}) => Object.fromEntries(
  residentDisplayFeatures.map(([key]) => [key, input[`display_${key}`] === 'on' && (key !== 'leaders' || input.display_districts === 'on')])
);
