export const disclosureFields = [['photo', '顔写真'], ['name', '氏名'], ['address', '住所'], ['phone', '電話番号'], ['email', 'メールアドレス']];
export const disclosureLevels = [['private', '本人・町内会管理者のみ'], ['officers', '同じ町内会の役員'], ['residents', '同じ町内会の住人・役員'], ['open', '一般公開（誰でも閲覧可能）']];
export const rank = value => disclosureLevels.findIndex(([key]) => key === value);
export const defaultPolicy = { photo: 'officers', name: 'officers', address: 'private', phone: 'private', email: 'private' };
export const policyValues = policy => Object.fromEntries(disclosureFields.map(([field]) => [field, rank(policy?.[field]) >= 0 && (field === 'photo' || policy[field] !== 'open') ? policy[field] : defaultPolicy[field]]));
export const parseDisclosure = (body, policy) => Object.fromEntries(disclosureFields.map(([field, label]) => {
  const value = body[field];
  if (typeof value !== 'string' || rank(value) < 0 || (field !== 'photo' && value === 'open') || (policy && rank(value) > rank(policyValues(policy)[field]))) throw Object.assign(new Error(`${label}の公開範囲を確認してください。`), { status: 400 });
  return [field, value];
}));
export const effectiveDisclosure = (policy, consent, history = []) => Object.fromEntries(disclosureFields.map(([field]) => {
  const requested = consent?.confirmedAt && rank(consent.scopes?.[field]) >= 0 ? consent.scopes[field] : 'private';
  const historicalCaps = history.filter((change, index) => consent?.confirmedAt && (Number.isInteger(consent.policyRevision) ? index >= consent.policyRevision : new Date(change.at) >= new Date(consent.confirmedAt))).map(change => rank(policyValues(change.after)[field]));
  const maximum = disclosureLevels[Math.min(rank(policyValues(policy)[field]), ...historicalCaps)][0];
  return [field, disclosureLevels[Math.min(rank(requested), rank(maximum), field === 'photo' ? 3 : 2)][0]];
}));
export const visibleField = (level, audience) => audience !== 'open' && audience !== 'residents' && audience !== 'officers' ? false : rank(level) >= rank(audience);
export const redactOfficer = (officer, policy, consent, { audience = 'open', viewerId, manager = false, currentYear, policyHistory = [] } = {}) => {
  const owner = viewerId && String(officer.user?._id || officer.user) === String(viewerId);
  const scopes = effectiveDisclosure(policy, consent?.fiscalYear === currentYear ? consent : null, policyHistory);
  const active = officer.fiscalYear === currentYear && !officer.cancelledAt && officer.user;
  const allows = field => Boolean(manager || owner || (active && visibleField(scopes[field], audience)));
  // Construct a display record rather than returning a populated account object.
  return {
    _id: officer._id, fiscalYear: officer.fiscalYear, role: officer.role, department: officer.department,
    districtGroup: allows('name') ? officer.districtGroup : null,
    name: allows('name') ? officer.name || officer.user?.displayname || '' : '',
    address: allows('address') ? officer.address || '' : '',
    phone: allows('phone') ? officer.phone || '' : '',
    mobilePhone: allows('phone') ? officer.mobilePhone || '' : '',
    email: allows('email') ? officer.user?.email || '' : '',
    user: { avatar: allows('photo') ? officer.user?.avatar || '' : '' },
    displayLabel: allows('name') ? officer.name || officer.user?.displayname || '担当者' : `${officer.role?.name || officer.department?.name || '役員'}担当`
  };
};
