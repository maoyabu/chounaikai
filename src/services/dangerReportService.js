import mongoose from 'mongoose';
import { AssociationMembership } from '../models/associationMembership.js';
import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export async function dangerAccess(associationId, userId) {
  if (!mongoose.isValidObjectId(associationId)) throw fail('町内会が見つかりません。', 404);
  const [association, membership] = await Promise.all([
    NeighborhoodAssociation.findOne({ _id: associationId, status: 'active', deletedAt: { $exists: false } }).lean(),
    AssociationMembership.exists({ association: associationId, user: userId, status: 'active' })
  ]);
  if (!association || !membership) throw fail('参加中の町内会の緊急・危険情報だけ利用できます。', 403);
  return association;
}
export function validateDangerReport(body, file, now = new Date()) {
  const title = String(body.title || '').trim(), content = String(body.body || '').trim();
  if (!title || title.length > 120 || !content || content.length > 3000) throw fail('タイトルは120文字以内、内容は3000文字以内で入力してください。');
  const b = file?.buffer;
  const jpeg = b?.length > 3 && b[0] === 255 && b[1] === 216 && b[2] === 255;
  const png = b?.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const webp = b?.toString('ascii',0,4) === 'RIFF' && b?.toString('ascii',8,12) === 'WEBP';
  if (!jpeg && !png && !webp) throw fail('写真はJPEG、PNG、WebP形式で選択してください。');
  const address = String(body.address || '').trim();
  if (address.length > 300) throw fail('住所・場所は300文字以内で入力してください。');
  const photoFields = { photo: b, photoType: jpeg ? 'image/jpeg' : png ? 'image/png' : 'image/webp' };
  if (body.locationSource === 'address') {
    if (!address) throw fail('住所・場所を入力してください（大まかでも構いません）。');
    return { title, body: content, address, locationSource: 'address', ...photoFields };
  }
  const latitude = Number(body.latitude), longitude = Number(body.longitude);
  const locationSource = body.locationSource === 'photo' ? 'photo' : 'device';
  const accuracy = locationSource === 'photo' ? undefined : Number(body.accuracy);
  const locatedAt = new Date(body.locatedAt);
  if (body.latitude === undefined || String(body.latitude).trim() === '' || body.longitude === undefined || String(body.longitude).trim() === '' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180 || (locationSource === 'device' && (!Number.isFinite(accuracy) || accuracy < 0)) || !Number.isFinite(locatedAt.getTime()) || locatedAt > new Date(now.getTime() + 60000)) throw fail('撮影時の位置情報を再取得してください。');
  return { title, body: content, address: address || undefined, latitude, longitude, accuracy, locationSource, locatedAt, ...photoFields };
}
