import { User } from '../models/user.js';
import { PasswordReset } from '../models/passwordReset.js';

const invalid = message => Object.assign(new Error(message), { status: 400 });

export const changePassword = async ({ userId, currentPassword, password, confirmation }) => {
  if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 1024) throw invalid('現在のパスワードを入力してください。');
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw invalid('新しいパスワードは8〜128文字で入力してください。');
  if (password !== confirmation) throw invalid('確認用パスワードが一致しません。');
  if (password === currentPassword) throw invalid('現在とは異なるパスワードを設定してください。');
  const user = await User.findById(userId).select('+salt +hash');
  if (!user || !(await user.authenticate(currentPassword)).user) throw invalid('現在のパスワードが正しくありません。');
  const previousHash = user.hash;
  await new Promise((resolve, reject) => user.setPassword(password, error => error ? reject(error) : resolve()));
  const result = await User.updateOne({ _id: userId, hash: previousHash }, {
    $set: { salt: user.salt, hash: user.hash, update_date: new Date() },
    $unset: { resetPasswordToken: '', resetPasswordExpires: '' }
  });
  if (result.matchedCount !== 1) throw invalid('パスワードの状態が変わりました。再度ログインしてお試しください。');
  await PasswordReset.deleteOne({ user: userId });
};
