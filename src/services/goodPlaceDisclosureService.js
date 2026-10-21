import { AssociationMembership } from '../models/associationMembership.js';

// Login alone does not grant access to another association's resident identities.
export async function canViewGoodPlaceAuthors(associationId, userId) {
  if (!userId) return false;
  return Boolean(await AssociationMembership.exists({ association: associationId, user: userId, status: 'active' }));
}
export function redactGoodPlaceAuthor(report, showAuthor) {
  if (showAuthor) return report;
  const { author, ...publicReport } = report;
  return publicReport;
}
export function goodPlaceAuthorQuery(query, showAuthor) {
  return showAuthor ? query.populate('author', 'displayname') : query.select('-author');
}
