import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { AnnualLeaderAssignment } from '../src/models/annualLeaderAssignment.js';
import { AssociationGroupMembership } from '../src/models/associationGroup.js';
import { RoleAssignment } from '../src/models/role.js';

// Isolate navigation reads while exercising real Express middleware and views.
export const stubNavigation = t => {
  const query = value => ({ populate() { return this; }, select() { return this; }, sort() { return this; }, lean: async () => value });
  for (const model of [AssociationMembership, AnnualOfficer, AnnualLeaderAssignment, AssociationGroupMembership, RoleAssignment]) {
    t.mock.method(model, 'find', () => query([]));
  }
  t.mock.method(AssociationMembership, 'findOne', () => query(null));
};
