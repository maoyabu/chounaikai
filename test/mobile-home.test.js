import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileAssociationProfile } from '../src/services/mobileHomeService.js';

test('mobile home returns district, group and every communication role', () => {
  const profile = mobileAssociationProfile({
    membership: {
      association: { _id: 'association-1', name: '吉田元町町内会' },
      districtGroup: {
        _id: 'group-1',
        name: '8班',
        parentDistrict: { _id: 'district-1', name: '第8A地区' }
      }
    },
    assignments: [{ role: { name: '町内会管理者' } }],
    officers: [{ department: { name: '青年部' }, role: { name: '部長' } }],
    leaders: [{ districtGroup: 'group-1' }],
    groupManagers: [{ group: { _id: 'association-group-1', name: '防災係' } }]
  });

  assert.deepEqual(profile.association, { id: 'association-1', name: '吉田元町町内会' });
  assert.deepEqual(profile.district, { id: 'district-1', name: '第8A地区' });
  assert.deepEqual(profile.group, { id: 'group-1', name: '8班' });
  assert.deepEqual(profile.roles, [
    { kind: 'management', name: '町内会管理者' },
    { kind: 'officer', name: '青年部 部長' },
    { kind: 'district_leader', name: '班長' },
    { kind: 'group_manager', name: '防災係 管理者', groupId: 'association-group-1' }
  ]);
});

test('mobile home supports district-only membership and removes duplicate roles', () => {
  const profile = mobileAssociationProfile({
    membership: {
      association: { _id: 'association-1', name: '町内会' },
      districtGroup: { _id: 'district-1', name: '中央地区' }
    },
    assignments: [],
    officers: [{ role: { name: '役員' } }, { role: { name: '役員' } }],
    leaders: [],
    groupManagers: []
  });

  assert.deepEqual(profile.district, { id: 'district-1', name: '中央地区' });
  assert.equal(profile.group, null);
  assert.deepEqual(profile.roles, [{ kind: 'officer', name: '役員' }]);
});
