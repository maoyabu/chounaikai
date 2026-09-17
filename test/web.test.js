import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { provideCsrfToken, verifyCsrfToken } from '../src/middleware/csrf.js';
import { createEmailVerification } from '../src/services/emailVerificationService.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

test('login view renders the existing-account form', async () => {
  const html = await ejs.renderFile(path.join(dirname, '../src/views/login.ejs'), {
    title: 'ログイン',
    csrfToken: 'test-token',
    errorMessage: null,
    currentUser: null
  });
  assert.match(html, /name="identifier"/);
  assert.match(html, /name="password"/);
  assert.match(html, /value="test-token"/);
});

test('error view renders when session loading fails before user locals exist', async () => {
  const html = await ejs.renderFile(path.join(dirname, '../src/views/error.ejs'), {
    title: 'エラー', message: 'データベースに接続できません。'
  });
  assert.match(html, /データベースに接続できません/);
  assert.match(html, /href="\/login"/);
});

test('registration view renders shared-account fields', async () => {
  const html = await ejs.renderFile(path.join(dirname, '../src/views/register.ejs'), {
    title: '新規会員登録',
    csrfToken: 'test-token',
    values: {},
    currentUser: null
  });
  assert.match(html, /name="username"/);
  assert.match(html, /name="email"/);
  assert.match(html, /name="passwordConfirmation"/);
  assert.match(html, /新規会員登録/);
});

test('public association list offers both creation application paths', async () => {
  const html = await ejs.renderFile(path.join(dirname, '../src/views/association-list.ejs'), {
    title: '町内会一覧', currentUser: null, associations: [], currentPath: '/associations'
  });
  assert.match(html, /href="\/associations\/create\/start"/);
  assert.match(html, /href="\/associations\/create\/register"/);
  assert.match(html, /href="\/login"/);
  assert.match(html, /ログインして申請/);
  assert.match(html, /新規会員登録して申請/);
});

test('admin view provides association management', async () => {
  const html = await ejs.renderFile(path.join(dirname, '../src/views/admin-dashboard.ejs'), {
    title: '管理者メニュー',
    csrfToken: 'test-token',
    notice: null,
    currentPath: '/admin',
    currentUser: { username: 'admin', email: 'admin@example.test', isAdmin: true },
    associations: [],
    stats: { total: 0, active: 0, pending: 0, users: 1 }
  });
  assert.match(html, /管理者メニュー/);
  assert.match(html, /申請・登録済み町内会/);
  assert.match(html, /class="hamburger-menu"/);
});

test('admin view exposes cleanup for pending registration and pending association', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/admin-dashboard.ejs'), {
    title: '管理者メニュー', csrfToken: 'test-token', notice: null, currentPath: '/admin',
    currentUser: { username: 'admin', email: 'admin@example.test', isAdmin: true },
    associations: [{ _id: id, name: '試験町内会', status: 'pending', requestedBy: null }],
    pendingRegistrations: [{ _id: id, username: 'unfinished', email: 'unfinished@example.test', registrationPurpose: 'create', expiresAt: new Date() }],
    inactiveRegistrants: [], stats: { total: 1, active: 0, pending: 1, users: 1 }
  });
  assert.match(html, new RegExp(`/admin/pending-registrations/${id}/delete`));
  assert.match(html, new RegExp(`/admin/associations/${id}/delete`));
  assert.doesNotMatch(html, new RegExp(`/admin/associations/${id}/approve`));
});

test('hamburger hides admin links from regular users', async () => {
  const html = await ejs.renderFile(path.join(dirname, '../src/views/partials/header.ejs'), {
    csrfToken: 'test-token',
    currentPath: '/dashboard',
    currentUser: { username: 'member', email: 'member@example.test', isAdmin: false }
  });
  assert.match(html, /メインメニュー/);
  assert.doesNotMatch(html, /管理者メニュー/);
  assert.doesNotMatch(html, /町内会を登録/);
});

test('header renders role tags beside the account name', async () => {
  const html = await ejs.renderFile(path.join(dirname, '../src/views/partials/header.ejs'), {
    csrfToken: 'test-token', currentPath: '/dashboard',
    currentUser: { username: 'owner', email: 'owner@example.test', isAdmin: false },
    currentRoleTags: ['町内会管理者', '会長']
  });
  assert.match(html, /class="role-tag">町内会管理者/);
  assert.match(html, /class="role-tag">会長/);
  assert.match(html, /ownerさん/);
});

test('header renders an association manager menu for each managed association', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/partials/header.ejs'), {
    csrfToken: 'test-token', currentPath: '/dashboard',
    currentUser: { username: 'owner', email: 'owner@example.test', isAdmin: false }, currentRoleTags: ['町内会管理者'],
    currentManagerAssociations: [{ _id: id, name: 'テスト町内会' }], currentLeaderAssociations: [], currentHasAssociationMembership: true,
    currentMenuAssociationName: 'テスト町内会'
  });
  assert.match(html, new RegExp(`href="/associations/${id}/manage"`));
  assert.match(html, /class="menu-association-name">テスト町内会/);
  assert.match(html, /<span>町内会管理者メニュー<\/span>/);
  assert.doesNotMatch(html, /テスト町内会　町内会管理者メニュー/);
});

test('header renders fiscal year and district in a leader role tag', async () => {
  const html = await ejs.renderFile(path.join(dirname, '../src/views/partials/header.ejs'), {
    csrfToken: 'test-token', currentPath: '/dashboard',
    currentUser: { username: 'leader', email: 'leader@example.test', isAdmin: false },
    currentRoleTags: ['2026年度 1班 班長']
  });
  assert.match(html, /class="role-tag">2026年度 1班 班長/);
});

test('header links to profile and renders an existing avatar', async () => {
  const html = await ejs.renderFile(path.join(dirname, '../src/views/partials/header.ejs'), {
    csrfToken: 'test-token', currentPath: '/profile',
    currentUser: { username: 'member', displayname: '山田 太郎', email: 'member@example.test', avatar: 'https://res.cloudinary.com/example/image/upload/avatar.jpg', isAdmin: false },
    currentRoleTags: []
  });
  assert.match(html, /href="\/profile"/);
  assert.match(html, /プロフィールを編集/);
  assert.match(html, /profile-avatar/);
  assert.match(html, /res\.cloudinary\.com/);
});

test('header hides household and association application links for an existing member', async () => {
  const html = await ejs.renderFile(path.join(dirname, '../src/views/partials/header.ejs'), {
    csrfToken: 'test-token', currentPath: '/dashboard',
    currentUser: { username: 'member', email: 'member@example.test', isAdmin: false },
    currentRoleTags: [], currentLeaderAssociations: [], currentHasAssociationMembership: true
  });
  assert.doesNotMatch(html, /町内会を申請/);
  assert.doesNotMatch(html, /世帯情報<\/span><\/a>/);
  assert.match(html, /プロフィールを編集/);
  assert.match(html, /まちの伝言板/);
  assert.match(html, /!menu\.contains\(event\.target\)/);
});

test('dashboard heading links the association with district and member attribute tags', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/dashboard.ejs'), {
    title: '町内会ホーム', csrfToken: 'x', notice: null, currentPath: '/dashboard',
    currentUser: { username: 'member', email: 'member@example.test', isAdmin: false }, currentRoleTags: [],
    memberships: [{ association: { _id: id, name: '戸塚区吉田町町内会' }, districtGroup: { name: '1109班' }, memberTags: ['役員', '班長'] }],
    applications: [], pendingJoins: [], availableAssociations: [], notifications: []
  });
  assert.match(html, new RegExp(`href="/associations/${id}"`));
  assert.match(html, /戸塚区吉田町町内会/);
  assert.match(html, /1109班/);
  assert.match(html, />役員</);
  assert.match(html, />班長</);
  assert.doesNotMatch(html, /class="association-grid"/);
});

test('dashboard notifications start collapsed with unread count and disabled confirmed action', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/dashboard.ejs'), {
    title: '町内会ホーム', csrfToken: 'token', notice: null, currentPath: '/dashboard', currentUser: { username: 'member', email: 'member@example.test' }, currentRoleTags: [],
    memberships: [], applications: [], pendingJoins: [], availableAssociations: [], residentRegistration: null,
    notifications: [
      { _id: id, title: '新着', body: '確認してください', readAt: null },
      { _id: '507f1f77bcf86cd799439012', title: '過去のお知らせ', body: '確認済み', readAt: new Date() }
    ], unreadNotificationCount: 1, notificationInboxOpen: false
  });
  assert.match(html, /<details class="admin-section application-section notification-inbox" >/);
  assert.match(html, /未読 1件/);
  assert.match(html, new RegExp(`/notifications/${id}/read`));
  assert.match(html, new RegExp(`/notifications/${id}/delete`));
  assert.match(html, /disabled>確認済み<\/button>/);
});

test('profile view supports shared profile fields and an image upload', async () => {
  const html = await ejs.renderFile(path.join(dirname, '../src/views/profile.ejs'), {
    title: 'プロフィール変更', csrfToken: 'test-token', notice: null, formError: null, currentPath: '/profile',
    currentUser: { username: 'member', email: 'member@example.test', isAdmin: false },
    currentRoleTags: [], values: { username: 'member', displayname: '山田 太郎', email: 'member@example.test', avatar: '' }
  });
  assert.match(html, /enctype="multipart\/form-data"/);
  assert.match(html, /name="avatar"/);
  assert.match(html, /name="displayname"/);
  assert.match(html, /name="birth_date"/);
  assert.match(html, /HEIC、15MB以下/);
});

test('profile view provides tabbed household and member management', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/profile.ejs'), {
    title: 'プロフィール管理', csrfToken: 'test-token', notice: null, formError: null, currentPath: '/profile',
    currentUser: { username: 'member', email: 'member@example.test', isAdmin: false }, currentRoleTags: [],
    values: { username: 'member', displayname: '山田 太郎', email: 'member@example.test', avatar: '' },
    households: [{ _id: id, association: { _id: id, name: 'テスト町内会' }, districtGroup: { name: '1班' }, address: { postalCode: '100-0001', street: '東京都' }, phone: '' }],
    membersByHousehold: { [id]: [{ _id: id, household: id, name: '山田 太郎', nameKana: 'やまだ たろう', birthDate: new Date('1990-01-01'), gender: 'male', isRepresentative: true }] }
  });
  assert.match(html, /data-profile-tab="account"/);
  assert.match(html, /data-profile-tab="household"/);
  assert.match(html, /同一世帯のメンバー/);
  assert.match(html, /data-open-member-dialog/);
  assert.match(html, /class="household-member-dialog"/);
  assert.match(html, /name="postalCode"/);
  assert.match(html, /name="lineAccount"/);
  assert.match(html, /世帯メンバーを追加/);
});

test('profile view allows household registration after joining an association', async () => {
  const id = '507f1f77bcf86cd799439011';
  const districtId = '507f191e810c19729de860ea';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/profile.ejs'), {
    title: 'プロフィール管理', csrfToken: 'test-token', notice: null, formError: null, currentPath: '/profile',
    currentUser: { username: 'member', email: 'member@example.test', isAdmin: false }, currentRoleTags: [],
    values: { username: 'member', displayname: '山田 太郎', email: 'member@example.test', avatar: '' },
    households: [], membersByHousehold: {},
    availableHouseholdRegistrations: [{ membership: { association: { _id: id, name: 'テスト町内会' } }, districtGroups: [{ _id: districtId, name: '1班' }] }]
  });
  assert.match(html, new RegExp(`action="/associations/${id}/household"`));
  assert.match(html, /参加後でも、世帯と世帯代表者の情報を登録できます。/);
  assert.match(html, /name="districtGroupId"/);
  assert.match(html, /世帯情報を登録/);
});

test('CSRF middleware creates and accepts a session token', () => {
  const req = { session: {}, body: {}, get: () => undefined };
  const res = { locals: {} };
  let provided = false;
  provideCsrfToken(req, res, () => { provided = true; });
  assert.equal(provided, true);
  assert.equal(res.locals.csrfToken, req.session.csrfToken);

  req.body._csrf = req.session.csrfToken;
  let verified = false;
  verifyCsrfToken(req, res, () => { verified = true; });
  assert.equal(verified, true);
});

test('email verification creates an expiring token and stores only its digest', () => {
  const verification = createEmailVerification();
  assert.match(verification.token, /^[a-f0-9]{64}$/);
  assert.match(verification.digest, /^[a-f0-9]{64}$/);
  assert.notEqual(verification.token, verification.digest);
  assert.ok(verification.expiresAt.getTime() > Date.now());
});

test('association management view exposes required management areas', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/association-manage.ejs'), {
    title: '管理', csrfToken: 'test-token', notice: null, currentPath: `/associations/${id}/manage`,
    currentUser: { username: 'owner', email: 'owner@example.test' }, association: { _id: id, name: 'テスト町内会' }, fiscalYear: 2027,
    departments: [], districtGroups: [], roles: [], officers: [], memberships: [], leaderAssignments: [], households: []
  });
  assert.match(html, /部/);
  assert.match(html, /班/);
  assert.match(html, /役員/);
  assert.match(html, /基本設定を開く/);
  assert.match(html, /年度設定を開く/);
  assert.match(html, /2027年度の役員一覧/);
  assert.match(html, /2027年度の班長一覧/);
  assert.match(html, /テスト町内会住人一覧/);
});

test('basic settings are ordered as roles, departments, districts and name', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/association-basic-settings.ejs'), { title: '基本設定', csrfToken: 'x', notice: null, currentPath: '/basic', currentUser: { username: 'owner', email: 'o@x' }, association: { _id: id, name: 'テスト町内会' }, roles: [], departments: [], districtGroups: [] });
  const positions = ['id="roles"', 'id="departments"', 'id="district-groups"', 'id="association-name"'].map((text) => html.indexOf(text));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(html, /className = 'drag-handle'/);
  assert.match(html, /list\.addEventListener\('drop'/);
  assert.doesNotMatch(html, /row\.addEventListener\('drop'/);
  assert.match(html, /manage\/order\/\$\{type\}/);
});

test('annual settings support officer assignments and district leaders', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/association-annual-settings.ejs'), { title: '年度設定', csrfToken: 'x', notice: null, currentPath: '/annual', currentUser: { username: 'owner', email: 'o@x' }, association: { _id: id, name: 'テスト町内会' }, fiscalYear: 2027, memberships: [], householdRepresentatives: [{ user: { _id: id, displayname: '山田 太郎', email: 'taro@example.test' }, household: { displayName: '山田世帯', address: {} }, districtGroup: { _id: id, name: '1班' }, residentProfile: { name: '山田 太郎' }, attributeTags: ['役員'] }], officers: [], roles: [], departments: [], districtGroups: [{ _id: id, name: '1班' }], leaderAssignments: [] });
  assert.match(html, /2027年度の運営体制/);
  assert.match(html, /世帯主から役員を選定・設定/);
  assert.match(html, /officer-resident-search/);
  assert.match(html, />所属班<select name="membershipDistrictGroupId"/);
  assert.match(html, /normalize\('NFKC'\)/);
  assert.match(html, /世帯主から班長を選定・設定/);
  assert.match(html, /leader-resident-search/);
  assert.match(html, /班長の担当班/);
  assert.match(html, /data-open-leader-dialog/);
});

test('annual selections move assigned officers and leaders into lower groups', async () => {
  const associationId = '507f1f77bcf86cd799439011';
  const representatives = [
    { user: { _id: '507f1f77bcf86cd799439012', displayname: '候補者A', email: 'a@example.test' } },
    { user: { _id: '507f1f77bcf86cd799439013', displayname: '役員B', email: 'b@example.test' }, officer: { _id: '507f1f77bcf86cd799439014' } },
    { user: { _id: '507f1f77bcf86cd799439015', displayname: '班長C', email: 'c@example.test' }, leaderAssignment: { _id: '507f1f77bcf86cd799439016' } }
  ].map(item => ({ ...item, household: { address: {} }, districtGroup: { _id: associationId, name: '1班' }, attributeTags: [] }));
  const html = await ejs.renderFile(path.join(dirname, '../src/views/association-annual-settings.ejs'), {
    title: '年度設定', csrfToken: 'x', notice: null, currentPath: '/annual', currentUser: { username: 'owner', email: 'o@x' },
    association: { _id: associationId, name: 'テスト町内会' }, fiscalYear: 2027, memberships: [], householdRepresentatives: representatives,
    officers: [], roles: [], departments: [], districtGroups: [{ _id: associationId, name: '1班' }], leaderAssignments: []
  });
  const officerPanel = html.split('data-annual-panel="officers"')[1].split('data-annual-panel="leaders"')[0];
  const leaderPanel = html.split('data-annual-panel="leaders"')[1].split('<script>')[0];
  assert.ok(officerPanel.indexOf('候補者Aさん') < officerPanel.indexOf('選定済みの役員'));
  assert.ok(officerPanel.indexOf('役員Bさん') > officerPanel.indexOf('選定済みの役員'));
  assert.ok(leaderPanel.indexOf('候補者Aさん') < leaderPanel.indexOf('選定済みの班長'));
  assert.ok(leaderPanel.indexOf('班長Cさん') > leaderPanel.indexOf('選定済みの班長'));
});

test('officer directory renders the selected fiscal year and officer details', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/association-officers.ejs'), {
    title: '2027年度の役員一覧', csrfToken: 'x', notice: null, currentPath: '/officers', currentUser: { username: 'owner', email: 'o@x' },
    association: { _id: id, name: 'テスト町内会' }, fiscalYear: 2027, roles: [{ _id: id, name: '会長' }], departments: [{ _id: id, name: '総務部' }], districtGroups: [{ _id: id, name: '1班' }],
    officers: [{ user: { displayname: '山田 太郎', email: 'taro@example.test' }, role: { name: '会長' }, department: { name: '総務部' }, membership: { districtGroup: { name: '1班' }, household: { displayName: '山田世帯', address: { postalCode: '100-0001', street: '東京都' } } } }]
  });
  assert.match(html, /2027年度の役員一覧/);
  assert.match(html, /山田 太郎/);
  assert.match(html, /会長/);
  assert.match(html, /総務部/);
  assert.match(html, /officer-directory-search/);
  assert.match(html, /class="officer-dialog"/);
});

test('leader directory supports fiscal year selection and searchable rows', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/association-leaders.ejs'), {
    title: '2027年度の班長一覧', csrfToken: 'x', notice: null, currentPath: '/leaders', currentUser: { username: 'owner', email: 'o@x' },
    association: { _id: id, name: 'テスト町内会' }, fiscalYear: 2027, districtGroups: [{ _id: id, name: '1班' }],
    leaders: [{ representative: { _id: id, displayname: '山田 太郎', email: 'taro@example.test', avatar: '' }, districtGroup: { _id: id, name: '1班' }, membership: { districtGroup: { _id: id, name: '1班' } }, household: { address: { postalCode: '100-0001', street: '東京都' } } }]
  });
  assert.match(html, /2027年度の班長一覧/);
  assert.match(html, /name="year"/);
  assert.match(html, /山田 太郎/);
  assert.match(html, /leader-directory-search/);
  assert.match(html, /name="membershipDistrictGroupId"/);
  assert.match(html, /data-open-leader-dialog/);
});

test('resident association detail shares the public page layout and shows resident actions', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/association-detail.ejs'), {
    title: '町内会', csrfToken: 'x', notice: null, currentPath: `/associations/${id}`, currentUser: { username: 'member', isAdmin: false },
    association: { _id: id, name: 'テスト町内会', status: 'active', contact: { email: 'contact@example.test' }, introduction: 'ご案内' },
    associationManager: { displayname: '山田 管理者' }, membership: {}, canManage: false,
    pageData: { events: [], months: [{ label: '2026年9月', cells: ['2026-09-01'] }], calendarWindow: { currentMonth: '2026-09', previousMonth: '2026-08', nextMonth: '2026-10' }, fiscalYear: 2026,
      officers: [{ user: { displayname: '山田 太郎' }, role: { name: '会長' } }], householdCount: 2, residentCount: 5,
      districtStats: [{ name: '１班', householdCount: 2, residentCount: 5 }] }
  });
  assert.match(html, /町内会の基本情報/);
  assert.match(html, /町内会行事カレンダー/);
  assert.match(html, /山田 太郎/);
  assert.match(html, /１班/);
  assert.match(html, new RegExp(`/associations/${id}/officers`));
  assert.match(html, /役員の一覧を見る/);
  assert.doesNotMatch(html, /この町内会で会員登録/);
});

test('public officer page shows role name officer name and department', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/association-public-officers.ejs'), {
    title: '役員', csrfToken: 'x', currentPath: '/officers', currentUser: { username: 'member' }, association: { _id: id, name: 'テスト町内会' }, fiscalYear: 2027,
    officers: [{ user: { displayname: '山田 太郎', avatar: '' }, role: { name: '会長' }, department: { name: '総務部' } }]
  });
  assert.match(html, /2027年度の役員/);
  assert.match(html, /会長/);
  assert.match(html, /山田 太郎/);
  assert.match(html, /総務部/);
});

test('member directory provides district role department and free-word filters', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/association-members.ejs'), {
    title: '住人一覧', csrfToken: 'x', currentPath: '/members', currentUser: { username: 'owner' }, association: { _id: id, name: 'テスト町内会' }, fiscalYear: 2027,
    districtGroups: [{ _id: id, name: '1班' }], roles: [{ _id: id, name: '会長' }], departments: [{ _id: id, name: '総務部' }],
    members: [{ user: { displayname: '山田 太郎', email: 'taro@example.test', avatar: '' }, districtGroup: { _id: id, name: '1班' }, household: { address: { postalCode: '100-0001', street: '東京都' } }, officer: { role: { _id: id, name: '会長' }, department: { _id: id, name: '総務部' } }, isLeader: true, isAssociationManager: false }]
  });
  assert.match(html, /テスト町内会住人一覧/);
  assert.match(html, /member-filter-district/);
  assert.match(html, /member-filter-role/);
  assert.match(html, /member-filter-department/);
  assert.match(html, /member-filter-query/);
  assert.match(html, /山田 太郎/);
  assert.match(html, /option value="leader">班長/);
  assert.match(html, /member-attribute-tag">班長/);
});

test('order settings provide move controls for roles, departments and districts', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/association-order-settings.ejs'), { title: '並び順', csrfToken: 'x', notice: null, currentPath: '/order', currentUser: { username: 'owner', email: 'o@x' }, association: { _id: id, name: '町内会' }, roles: [{ _id: id, name: '会長' }], departments: [{ _id: id, name: '総務部' }], districtGroups: [{ _id: id, name: '1班' }] });
  assert.match(html, /並び順設定/);
  assert.match(html, /name="itemId"/);
  assert.match(html, /上へ移動/);
  assert.match(html, /下へ移動/);
});

test('leader view renders pending application count and district members', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/leader-dashboard.ejs'), {
    title: '班長', csrfToken: 'test-token', notice: null, currentPath: `/associations/${id}/leader`,
    currentUser: { username: 'owner', email: 'owner@example.test' }, association: { _id: id, name: 'テスト町内会' },
    districtGroups: [{ _id: id, name: '1班' }], fiscalYear: 2026,
    applications: [{ _id: id, applicant: { username: 'member' }, districtGroup: { name: '1班' }, household: { displayName: '山田世帯', address: {} } }],
    households: [], membersByHousehold: {}
  });
  assert.match(html, /class="tab-count">1</);
  assert.match(html, /班に所属する世帯/);
});

test('leader member list shows a household count and hides private contact details', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/leader-dashboard.ejs'), {
    title: '班長', csrfToken: 'test-token', notice: null, currentPath: `/associations/${id}/leader`,
    currentUser: { username: 'leader', email: 'leader@example.test' }, association: { _id: id, name: 'テスト町内会' },
    districtGroups: [{ _id: id, name: '1班' }], fiscalYear: 2026, applications: [],
    households: [{ _id: id, displayName: '山田世帯', districtGroup: { name: '1班' }, address: { postalCode: '100-0001', street: '東京都' } }],
    membersByHousehold: { [id]: [{ name: '山田 太郎', nameKana: 'やまだ たろう', gender: 'male', isRepresentative: true, email: 'private@example.test', lineAccount: 'private-line', birthDate: new Date('1990-01-01') }, { name: '山田 花子', nameKana: 'やまだ はなこ', gender: 'female' }] }
  });
  assert.match(html, /class="household-count-tag">2人世帯/);
  assert.match(html, /山田 太郎さん/);
  assert.doesNotMatch(html, /private@example\.test|private-line|1990/);
});

test('household application view requires association, district and representative details', async () => {
  const id = '507f1f77bcf86cd799439011';
  const html = await ejs.renderFile(path.join(dirname, '../src/views/household-application.ejs'), {
    title: '参加申請', csrfToken: 'test-token', currentPath: `/associations/${id}/join`,
    currentUser: { username: 'member', email: 'member@example.test' }, currentRoleTags: [],
    association: { _id: id, name: 'テスト町内会' }, districtGroups: [{ _id: id, name: '1班' }], values: {}
  });
  assert.match(html, /name="districtGroupId"/);
  assert.match(html, /name="postalCode"/);
  assert.match(html, /name="representativeKana"/);
  assert.doesNotMatch(html, /name="representativeName"/);
  assert.match(html, /代表者氏名（本人情報と共通）/);
  assert.match(html, /name="lineAccount"/);
});
