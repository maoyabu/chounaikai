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
