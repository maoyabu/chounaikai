import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDangerReport } from '../src/services/dangerReportService.js';
const photo = { buffer: Buffer.from([255,216,255,224]) };
const body = { title: '倒木', body: '道路が塞がっています', latitude: '35.68', longitude: '139.76', accuracy: '12', locatedAt: '2026-10-21T00:00:00Z', author: 'forged' };
const now = new Date('2026-10-21T00:01:00Z');
test('valid report preserves coordinates and does not accept caller identity or posting time', () => {
  const data = validateDangerReport(body, photo, now);
  assert.equal(data.latitude, 35.68); assert.equal(data.photoType, 'image/jpeg'); assert.equal(data.author, undefined); assert.equal(data.createdAt, undefined);
});
test('rejects missing, invalid or out of range location and future capture time', () => {
  for (const change of [{ latitude: '' }, { longitude: 181 }, { latitude: 'NaN' }, { accuracy: -1 }, { locatedAt: 'bad' }, { locatedAt: '2027-01-01' }]) assert.throws(() => validateDangerReport({ ...body, ...change }, photo, now));
});
test('rejects empty content, oversized title and disguised image', () => {
  assert.throws(() => validateDangerReport({ ...body, body: '' }, photo, now));
  assert.throws(() => validateDangerReport({ ...body, title: 'a'.repeat(121) }, photo, now));
  assert.throws(() => validateDangerReport(body, { buffer: Buffer.from('<svg onload="bad()"/>'), mimetype: 'image/jpeg' }, now));
});

import { dangerAccess } from '../src/services/dangerReportService.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
test('access requires active membership in the requested active association', async () => {
  const originalFind = NeighborhoodAssociation.findOne, originalExists = AssociationMembership.exists;
  const associationId = '507f1f77bcf86cd799439011', userId = '507f1f77bcf86cd799439012';
  let member = true, active = true;
  NeighborhoodAssociation.findOne = filter => {
    assert.equal(filter._id, associationId); assert.equal(filter.status, 'active');
    return { lean: async () => active ? { _id: associationId } : null };
  };
  AssociationMembership.exists = async filter => {
    assert.deepEqual(filter, { association: associationId, user: userId, status: 'active' });
    return member;
  };
  try {
    assert.equal((await dangerAccess(associationId, userId))._id, associationId);
    member = false;
    await assert.rejects(dangerAccess(associationId, userId), { status: 403 });
    member = true; active = false;
    await assert.rejects(dangerAccess(associationId, userId), { status: 403 });
    await assert.rejects(dangerAccess('invalid', userId), { status: 404 });
  } finally { NeighborhoodAssociation.findOne = originalFind; AssociationMembership.exists = originalExists; }
});

test('photo coordinates preserve their source without inventing GPS accuracy', () => {
  const data = validateDangerReport({ ...body, locationSource: 'photo', accuracy: undefined }, photo, now);
  assert.equal(data.locationSource, 'photo'); assert.equal(data.accuracy, undefined);
});
