import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appPagesRouter } from '../src/routes/appPages.js';
import { renderView } from '../test-support/renderView.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const views = path.join(dirname, '../src/views');

const routeFor = pathValue => appPagesRouter.stack.find(layer => layer.route?.path === pathValue)?.route.stack[0].handle;

test('iOS app promotion and support routes are public render routes', () => {
  const rendered = [];
  for (const routePath of ['/app/ios', '/app/ios/support']) {
    const handler = routeFor(routePath);
    assert.equal(typeof handler, 'function');
    handler({}, { render: (view, locals) => rendered.push({ view, locals }) });
  }
  assert.deepEqual(rendered.map(item => item.view), ['ios-app-promotion', 'ios-app-support']);
  assert.ok(rendered.every(item => item.locals.hideDangerCompose));
});

test('iOS app promotion page describes features and links to support', async () => {
  const html = await renderView(path.join(views, 'ios-app-promotion.ejs'), {
    title: 'まちの伝言板',
    metaDescription: 'アプリ紹介',
    appLoginUrl: '/login',
    supportEmail: 'machino.dengonban@gmail.com',
    hideDangerCompose: true
  });
  assert.match(html, /まちの伝言板でできること/);
  assert.match(html, /Face IDまたはTouch ID/);
  assert.match(html, /href="\/app\/ios\/support"/);
});

test('iOS app support page includes App Store support essentials', async () => {
  const html = await renderView(path.join(views, 'ios-app-support.ejs'), {
    title: 'まちの伝言板 サポート',
    metaDescription: 'アプリサポート',
    appLoginUrl: '/login',
    supportEmail: 'machino.dengonban@gmail.com',
    hideDangerCompose: true
  });
  assert.match(html, /利用に必要なもの/);
  assert.match(html, /よくある問題/);
  assert.match(html, /mailto:machino\.dengonban@gmail\.com/);
  assert.match(html, /href="\/privacy-policy"/);
  assert.match(html, /href="\/terms"/);
});

test('child safety standards page is public and lists reporting and contact', async () => {
  const rendered = [];
  routeFor('/app/child-safety')({}, { render: (view, locals) => rendered.push({ view, locals }) });
  assert.equal(rendered[0].view, 'child-safety');
  const html = await renderView(path.join(views, 'child-safety.ejs'), { ...rendered[0].locals });
  assert.match(html, /子どもの安全基準/);
  assert.match(html, /まちの伝言板 Lite/);
  assert.match(html, /CSAM/);
  assert.match(html, /質問・ご意見箱/);
  assert.match(html, /mailto:machino\.dengonban@gmail\.com/);
});
