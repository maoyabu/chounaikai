import express from 'express';

export const appPagesRouter = express.Router();

const sharedLocals = {
  hideDangerCompose: true,
  appLoginUrl: '/login',
  supportEmail: 'machino.dengonban@gmail.com'
};

appPagesRouter.get('/app/ios', (_req, res) => {
  res.render('ios-app-promotion', {
    ...sharedLocals,
    title: 'まちの伝言板',
    metaDescription: '町内会のお知らせ、行事、会話、地域情報をWeb・iOS・Androidで確認・共有できる「まちの伝言板」の公式紹介ページです。'
  });
});

appPagesRouter.get('/app/ios/support', (_req, res) => {
  res.render('ios-app-support', {
    ...sharedLocals,
    title: 'まちの伝言板 サポート',
    metaDescription: 'iOSアプリ「まちの伝言板」の利用方法、よくある問題、お問い合わせ先をご案内します。'
  });
});

// Google Play の「子どもの安全基準」に登録する公開ページ(Web版・iOS・Android共通)。
appPagesRouter.get('/app/child-safety', (_req, res) => {
  res.render('child-safety', {
    ...sharedLocals,
    title: '子どもの安全基準 | まちの伝言板',
    metaDescription: 'まちの伝言板・まちの伝言板 Liteにおける、児童の性的虐待と搾取(CSAE)を防ぐための基準と報告窓口です。'
  });
});
