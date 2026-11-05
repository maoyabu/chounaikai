import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import officeCrypto from 'officecrypto-tool';
import fs from 'node:fs';
import ejs from 'ejs';
import { surveyExportView, createSurveyWorkbook } from '../src/services/surveyExportService.js';
import { officerAnnouncementsRouter } from '../src/routes/officerAnnouncements.js';
import { OfficerAnnouncement, OfficerAnnouncementReceipt } from '../src/models/officerAnnouncement.js';
import { NeighborhoodAssociation } from '../src/models/neighborhoodAssociation.js';
import { AssociationMembership } from '../src/models/associationMembership.js';
import { AnnualOfficer } from '../src/models/annualOfficer.js';
import { RoleDefinition } from '../src/models/role.js';
const id = () => new mongoose.Types.ObjectId();
const query = value => ({ lean: async () => value, select() { return this; }, populate() { return this; }, sort() { return this; } });
const fixture = () => {
  const announcement = { _id: id(), association: id(), sender: id(), channel: 'resident', responseMode: 'multiple', options: ['賛成', '=1+1'], title: '町内アンケート' };
  const req = { user: { _id: announcement.sender }, session: {}, params: { associationId: String(announcement.association), announcementId: String(announcement._id) } };
  return { announcement, req };
};

test('作成者だけにパスワードを表示し、セッションとアンケートごとに分ける', () => {
  const { req, announcement } = fixture();
  const first = surveyExportView(req, announcement);
  assert.equal(first.surveyExportPassword.length, 20);
  assert.equal(surveyExportView(req, announcement).surveyExportPassword, first.surveyExportPassword);
  assert.notEqual(surveyExportView({ ...req, session: {} }, announcement).surveyExportPassword, first.surveyExportPassword);
  assert.notEqual(surveyExportView(req, { ...announcement, _id: id() }).surveyExportPassword, first.surveyExportPassword);
  assert.deepEqual(surveyExportView({ ...req, user: { _id: id() } }, announcement), {});
  assert.deepEqual(surveyExportView(req, { ...announcement, responseMode: 'none' }), {});
  assert.ok(!first.surveyExportUrl.includes(first.surveyExportPassword));
});

test('Excelは開封パスワードで暗号化し、集計・複数回答・未回答・文字列を保持する', async () => {
  const { announcement } = fixture();
  const password = 'Export-Test-Password';
  const receipts = [
    { recipient: { _id: id(), displayname: '=HYPERLINK("example")' }, respondedAt: new Date('2026-11-05T01:00:00Z'), selectedOptions: [0, 1] },
    { recipient: { _id: id(), displayname: '未回答の人' }, selectedOptions: [0] }
  ];
  const buffer = await createSurveyWorkbook({ announcement, receipts, password });
  assert.equal(officeCrypto.isEncrypted(buffer), true);
  assert.ok(!buffer.includes(Buffer.from('町内アンケート')));
  await assert.rejects(async () => { await officeCrypto.decrypt(buffer, { password: 'wrong' }); });
  const plain = await officeCrypto.decrypt(buffer, { password });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(plain);
  const tally = workbook.getWorksheet('回答集計'), details = workbook.getWorksheet('回答一覧');
  assert.equal(tally.getCell('B3').value, 2);
  assert.equal(tally.getCell('B4').value, 1);
  assert.equal(tally.getCell('B8').value, 1);
  assert.equal(tally.getCell('C8').value, .5);
  assert.equal(tally.getCell('B10').value, 1);
  assert.equal(details.getCell('A2').value, receipts[0].recipient.displayname);
  assert.equal(details.getCell('E1').value, '=1+1');
  assert.equal(details.getCell('D2').value, '○');
  assert.equal(details.getCell('E2').value, '○');
  assert.equal(details.getCell('D3').value, '');
  assert.equal(details.getCell('C3').value, '未回答');
  assert.match(details.getCell('F2').value, /10:00:00/);
});

for (const scenario of ['other-author', 'no-question', 'expired-role', 'no-password', 'success']) test(`出力経路の認可と応答: ${scenario}`, async t => {
  const { req, announcement } = fixture();
  if (scenario !== 'no-password') surveyExportView(req, announcement);
  t.mock.method(NeighborhoodAssociation, 'findOne', () => query({ _id: announcement.association }));
  t.mock.method(AssociationMembership, 'findOne', () => query({ districtGroup: id() }));
  t.mock.method(RoleDefinition, 'find', () => query([]));
  t.mock.method(AnnualOfficer, 'exists', async () => scenario !== 'expired-role');
  t.mock.method(OfficerAnnouncement, 'findOne', filter => {
    assert.equal(filter.sender, req.user._id);
    assert.equal(String(filter.association), String(announcement.association));
    return query(scenario === 'other-author' ? null : { ...announcement, responseMode: scenario === 'no-question' ? 'none' : 'multiple' });
  });
  const receiptQuery = t.mock.method(OfficerAnnouncementReceipt, 'find', () => query([]));
  t.mock.method(AssociationMembership, 'find', () => query([]));
  const route = officerAnnouncementsRouter.stack.find(layer => layer.route?.path.endsWith('/responses.xlsx')).route;
  const headers = {};
  let error, body;
  await route.stack.at(-1).handle(req, { set(k, v) { headers[k] = v; }, attachment(v) { headers.attachment = v; }, type(v) { headers.type = v; }, send(v) { body = v; } }, value => { error = value; });
  assert.match(headers['Cache-Control'], /no-store/);
  if (scenario === 'success') {
    assert.equal(error, undefined);
    assert.equal(officeCrypto.isEncrypted(body), true);
    assert.match(headers.attachment, /\.xlsx$/);
  } else {
    assert.equal(error.status, { 'other-author': 403, 'no-question': 400, 'expired-role': 403, 'no-password': 409 }[scenario]);
    assert.equal(receiptQuery.mock.callCount(), 0);
  }
});

test('集計画面は出力ボタンの隣にパスワードを表示する', () => {
  const { announcement, req } = fixture();
  const template = fs.readFileSync('src/views/officer-announcement-detail.ejs', 'utf8').replace(/<%- include\([\s\S]*?%>/g, '');
  const data = { announcement: { ...announcement, urgency: 1, audience: 'all' }, association: { _id: announcement.association }, notice: null, receipts: [], responseSummary: { choices: [], unanswered: [], unansweredPercentage: 0 }, ...surveyExportView(req, announcement) };
  const html = ejs.render(template, data);
  assert.match(html, /Excel出力（パスワード付き）/);
  assert.ok(html.includes(data.surveyExportPassword));
  const other = ejs.render(template, { ...data, surveyExportPassword: undefined });
  assert.ok(!other.includes('Excel出力（パスワード付き）'));
});
