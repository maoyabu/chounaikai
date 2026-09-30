import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { Notification } from '../models/notification.js';
import { PushSubscription } from '../models/pushSubscription.js';
import { NotificationSettings, notificationCategory } from '../models/notificationSettings.js';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

const mailConfig = () => {
  const value = (name) => String(process.env[name] || '').trim();
  const host = value('SMTP_HOST');
  if (!host || !value('SMTP_USER') || !value('SMTP_PASS') || !value('MAIL_FROM') || !value('PUBLIC_BASE_URL')) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  return { from: value('MAIL_FROM'), baseUrl: value('PUBLIC_BASE_URL').replace(/\/$/, ''), transport: { host, port, secure: port === 465, auth: { user: value('SMTP_USER'), pass: value('SMTP_PASS') } } };
};

const wantsEmail = ({ email, emailRequired }) => Boolean(email && (emailRequired || process.env.NOTIFICATION_EMAIL_DEFAULT === 'true'));

const sendEmail = async ({ notification, recipient, required }) => {
  const config = mailConfig();
  if (!wantsEmail({ email: recipient?.email, emailRequired: required }) || !config) return { status: 'skipped' };
  const transporter = nodemailer.createTransport({ ...config.transport, disableFileAccess: true, disableUrlAccess: true });
  const url = `${config.baseUrl}/dashboard?notifications=open`;
  await transporter.sendMail({
    from: config.from,
    to: recipient.email,
    subject: `【まちの伝言板】${notification.title}`,
    text: `${recipient.displayname || recipient.username || ''}さん\n\n${notification.body}\n\n詳細：${url}`,
    html: `<p>${escapeHtml(recipient.displayname || recipient.username || '')}さん</p><p>${escapeHtml(notification.body)}</p><p><a href="${escapeHtml(url)}">詳細を確認する</a></p>`
  });
  return { status: 'sent', sentAt: new Date() };
};

// One unavailable endpoint must not prevent delivery to the user's other devices.
const sendPush = async ({ notification, recipient }) => {
  const publicKey = String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim();
  const privateKey = String(process.env.WEB_PUSH_PRIVATE_KEY || '').trim();
  const subject = String(process.env.WEB_PUSH_SUBJECT || '').trim();
  if (!publicKey || !privateKey || !subject) return { status: 'skipped' };
  webpush.setVapidDetails(subject, publicKey, privateKey);
  const subscriptions = await PushSubscription.find({ user: recipient._id, disabledAt: null });
  if (!subscriptions.length) return { status: 'skipped' };
  // A count lookup must not prevent the actual notification from being sent.
  const unreadCount = await Notification.countDocuments({ recipient: recipient._id, readAt: null }).catch(() => undefined);
  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: '/dashboard?notifications=open',
    tag: String(notification._id),
    unreadCount
  });
  let sent = 0;
  let failed = 0;
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, { timeout: 10000 });
      subscription.lastUsedAt = new Date();
      await subscription.save();
      sent += 1;
    } catch (error) {
      if ([404, 410].includes(Number(error.statusCode))) {
        subscription.disabledAt = new Date();
        await subscription.save();
      } else {
        failed += 1;
      }
    }
  }
  return { status: sent ? 'sent' : failed ? 'failed' : 'skipped', sentAt: sent ? new Date() : undefined, ...(failed ? { error: `${failed} endpoint(s) failed` } : {}) };
};

export const createNotification = async ({ association, recipient, type, title, body, relatedType, relatedId, emailRequired = false, deliveryKey }) => {
  const notification = await Notification.create({ association, recipient, type, title, body, relatedType, relatedId, deliveryKey });
  await deliverNotification(notification, { emailRequired });
  return notification;
};

export const createNotifications = async (records) => {
  const notifications = await Notification.insertMany(records);
  for (const notification of notifications) await deliverNotification(notification);
  return notifications;
};

export const deliverNotification = async (notification, { emailRequired = false } = {}) => {
  const recipient = notification.recipient;
  // Delivery is opt-in until SMTP/VAPID are configured. Notification creation
  // must remain fast and reliable in local development and during outages.
  if (!mailConfig() && (!process.env.WEB_PUSH_PUBLIC_KEY || !process.env.WEB_PUSH_PRIVATE_KEY)) return notification;
  try {
    const claimed = await Notification.findOneAndUpdate({ _id: notification._id, deliveryClaimedAt: null }, { $set: { deliveryClaimedAt: new Date() } });
    if (!claimed) return notification;
    const settings = await NotificationSettings.findOne({ association: notification.association }).lean();
    const category = notificationCategory(notification.type);
    const channel = settings?.channels?.[category] || { push: true, email: false };
    const user = await import('../models/user.js').then(({ User }) => User.findById(recipient).select('displayname username email').lean());
    if (!user) {
      await Notification.updateOne({ _id: notification._id }, { $set: { 'delivery.email.status': 'skipped', 'delivery.push.status': 'skipped' } });
      return notification;
    }
    const [email, push] = await Promise.allSettled([
      channel.email === false ? Promise.resolve({ status: 'skipped' }) : sendEmail({ notification, recipient: user, required: true }),
      channel.push === false ? Promise.resolve({ status: 'skipped' }) : sendPush({ notification, recipient: user })
    ]);
    await Notification.updateOne({ _id: notification._id }, { $set: {
      'delivery.email': email.status === 'fulfilled' ? email.value : { status: 'failed', error: String(email.reason?.message || email.reason) },
      'delivery.push': push.status === 'fulfilled' ? push.value : { status: 'failed', error: String(push.reason?.message || push.reason) }
    } });
  } catch (error) {
    console.error('Notification delivery setup failed:', error.name);
    // Leave a visible result instead of a notification stuck at "pending".
    await Notification.updateOne({ _id: notification._id }, { $set: { 'delivery.email': { status: 'failed', error: 'delivery_setup_failed' }, 'delivery.push': { status: 'failed', error: 'delivery_setup_failed' } } }).catch(() => {});
  }
  return notification;
};

// Reads only notifications created with the new queue field, so deployment
// does not resend historical messages. Transactional inserts become visible
// here only after commit.
export const dispatchPendingNotifications = async () => {
  const pending = await Notification.find({ queuedAt: { $exists: true }, deliveryClaimedAt: null }).sort({ queuedAt: 1 }).limit(50);
  for (const notification of pending) await deliverNotification(notification);
};

export const savePushSubscription = async ({ user, subscription, userAgent }) => {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) throw Object.assign(new Error('invalid_push_subscription'), { status: 400 });
  return PushSubscription.findOneAndUpdate(
    { user, endpoint: subscription.endpoint },
    { $set: { keys: subscription.keys, userAgent, lastUsedAt: new Date(), disabledAt: null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

export const disablePushSubscription = async ({ user, endpoint }) => PushSubscription.updateOne({ user, endpoint }, { $set: { disabledAt: new Date() } });
