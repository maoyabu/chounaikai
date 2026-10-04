import ejs from 'ejs';
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { systemContactsRouter, contactText, contactUrgency } from '../src/routes/systemContacts.js';
import { SystemContact } from '../src/models/systemContact.js';
import { RoleAssignment } from '../src/models/role.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';

const associationId = new mongoose.Types.ObjectId().toString();
const contactId = new mongoose.Types.ObjectId().toString();
const query = value => ({ populate() { return this; }, lean: async () => value });

test('contact inputs reject blank, oversized, structured text and invalid urgency', () => {
  for (const value of ['', '  ', ['body'], 'x'.repeat(5001)]) assert.throws(() => contactText(value, 5000), { status: 400 });
  assert.equal(contactText('  相談  ', 120), '相談');
  for (const value of ['bad', 0, 6, 1.5]) assert.throws(() => contactUrgency(value), { status: 400 });
  assert.equal(contactUrgency('5'), 5);
});

test('contact schema validates urgency and message size', () => {
  const contact = new SystemContact({ association: associationId, title: '改善要望', urgency: 6, messages: [{ sender: associationId, kind: 'association', body: 'x'.repeat(5001) }] });
  const error = contact.validateSync();
  assert.ok(error.errors.urgency);
  assert.ok(error.errors['messages.0.body']);
});

const serve = async (t, isAdmin, callback) => {
  const request = async path => {
    const layer = systemContactsRouter.stack.find(layer => layer.route?.methods.get && layer.match(path));
    const req = { params: layer.params, originalUrl: path, user: { _id: associationId, isAdmin }, isAuthenticated: () => true };
    return new Promise(resolve => {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, render() { resolve({ status: this.statusCode }); }, json() { resolve({ status: this.statusCode }); } };
      let index = 0;
      const next = error => {
        if (error) return resolve({ status: error.status || 500 });
        const handler = layer.route.stack[index++];
        Promise.resolve(handler.handle(req, res, next)).catch(next);
      };
      next();
    });
  };
  await callback(request);
};

test('general residents cannot read association or system contacts', async t => {
  t.mock.method(RoleAssignment, 'findOne', () => query(null));
  await serve(t, false, async request => {
    assert.equal((await request(`/associations/${associationId}/manage/system-contacts/${contactId}`)).status, 403);
    assert.equal((await request(`/admin/system-contacts/${contactId}`)).status, 403);
  });
});

test('manager reads are scoped to their association and missing contacts return 404', async t => {
  t.mock.method(RoleAssignment, 'findOne', () => ({ populate: async () => ({ role: { permissions: ['association.manage'] } }) }));
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: associationId }));
  let filter;
  t.mock.method(SystemContact, 'findOne', criteria => { filter = criteria; return query(null); });
  await serve(t, false, async request => {
    assert.equal((await request(`/associations/${associationId}/manage/system-contacts/${contactId}`)).status, 404);
    assert.equal(filter.association, associationId);
    assert.equal(filter._id, contactId);
  });
});

test('both contact screens render and escape message content', async () => {
  const common = { title: '連絡', currentUser: null, notice: null, csrfToken: 'token', assetVersion: 'test', baseUrl: '/admin/system-contacts' };
  const thread = { _id: contactId, title: '<script>test</script>', urgency: 3, association: { _id: associationId, name: '中央町内会' }, updatedAt: new Date(), messages: [{ kind: 'association', body: '<script>alert(1)</script>', createdAt: new Date() }] };
  for (const system of [true, false]) {
    const list = await ejs.renderFile('src/views/system-contacts.ejs', { ...common, system, association: thread.association, threads: [thread] });
    assert.ok(list.includes('&lt;script&gt;test&lt;/script&gt;'));
    assert.equal(list.includes('新しい連絡を送る'), !system);
    const detail = await ejs.renderFile('src/views/system-contact.ejs', { ...common, system, thread });
    assert.ok(detail.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  }
});
