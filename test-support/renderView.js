import ejs from 'ejs';

// Defaults normally supplied by createApp, shared by standalone template tests.
export const renderView = (filename, locals = {}, options) => ejs.renderFile(filename, {
  assetVersion: 'test',
  currentUser: null,
  notice: null,
  showNotificationPrompt: false,
  ...locals
}, options);
