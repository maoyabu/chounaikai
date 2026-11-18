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
    title: 'まちの伝言板 Lite',
    metaDescription: '町内会のお知らせ、行事、会話、地域情報をiPhoneで確認できる「まちの伝言板 Lite」の公式紹介ページです。'
  });
});

appPagesRouter.get('/app/ios/support', (_req, res) => {
  res.render('ios-app-support', {
    ...sharedLocals,
    title: 'まちの伝言板 Lite サポート',
    metaDescription: 'iOSアプリ「まちの伝言板 Lite」の利用方法、よくある問題、お問い合わせ先をご案内します。'
  });
});
