import { NeighborhoodAssociation } from '../models/neighborhoodAssociation.js';
import mongoose from 'mongoose';
import { Shelter } from '../models/shelter.js';
import { loadQuestionBoxAccess } from './questionBoxService.js';
import { uploadPublicPhoto, deletePublicPhoto } from './publicPageImageService.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (value, max, label, required = false) => {
  if (value != null && typeof value !== 'string') throw fail(`${label}を正しく入力してください。`);
  const result = (value || '').trim();
  if ((required && !result) || result.length > max) throw fail(`${label}は${required ? '1〜' : ''}${max}文字以内で入力してください。`);
  return result;
};
export function shelterValues(body) {
  const name = text(body.name, 150, '設備名', true), address = text(body.address, 500, '住所', true);
  const phone = text(body.phone, 50, '電話番号'), kind = text(body.kind, 100, '種別');
  const dangerPoints = text(body.dangerPoints, 2000, '注意すべき危険箇所');
  const capacityText = text(body.capacity, 7, '収容人数');
  const capacity = capacityText ? Number(capacityText) : null;
  if (capacityText && (!/^\d+$/.test(capacityText) || !Number.isInteger(capacity) || capacity > 1000000)) throw fail('収容人数は0〜1000000の整数で入力してください。');
  return { name, address, phone, capacity, kind, dangerPoints };
}

export function shelterInformationValues(body) {
  let informationUrl = text(body.informationUrl, 2048, '情報ページURL');
  const informationName = text(body.informationName, 200, '情報ページの名称');
  if (Boolean(informationUrl) !== Boolean(informationName)) throw fail('情報ページはURLと名称を両方入力してください。');
  if (informationUrl) {
    try {
      const url = new URL(informationUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
      informationUrl = url.href;
      if (informationUrl.length > 2048) throw new Error();
    } catch { throw fail('情報ページURLは http:// または https:// で始まる有効なURLを入力してください。'); }
  }
  return { url: informationUrl, name: informationName };
}

export async function requireShelterOfficer(associationId, userId) {
  const access = await loadQuestionBoxAccess({ associationId, userId });
  if (!access.canAnswer) throw fail('役員・町内会管理者のみ避難所を登録できます。', 403);
  return access.association;
}

export async function loadShelters(associationId, userId, selectedId) {
  const { association, canAnswer } = await loadQuestionBoxAccess({ associationId, userId });
  const shelters = await Shelter.find({ association: associationId, active: true }).sort({ name: 1, _id: 1 }).lean();
  const selected = selectedId ? shelters.find(shelter => String(shelter._id) === selectedId) : shelters[0];
  if (selectedId && !selected) throw fail('避難所を確認できません。', 404);
  // Preserve the first old per-shelter link until a shared setting is saved.
  // An explicitly saved empty setting clears it without falling back again.
  const legacy = shelters.find(shelter => shelter.informationUrl && shelter.informationName);
  const informationPage = association.shelterInformation ?? (legacy ? { url: legacy.informationUrl, name: legacy.informationName } : { url: '', name: '' });
  const informationLinks = informationPage.url && informationPage.name ? [{ ...informationPage }] : [];
  return { association, canManage: canAnswer, shelters, selected: selected || null, informationLinks, informationPage };
}

export async function saveShelter({ associationId, userId, shelterId, body, files = {} }, dependencies = { uploadPublicPhoto, deletePublicPhoto }) {
  await requireShelterOfficer(associationId, userId);
  const values = shelterValues(body);
  if (shelterId && !mongoose.isValidObjectId(shelterId)) throw fail('避難所を確認できません。', 404);
  const shelter = shelterId ? await Shelter.findOne({ _id: shelterId, association: associationId, active: true }) : new Shelter({ association: associationId, createdBy: userId });
  if (!shelter) throw fail('避難所を確認できません。', 404);
  if (shelterId && String(body.version) !== String(shelter.__v || 0)) throw fail('避難所が更新されています。画面を開き直してください。', 409);
  const oldPhotos = [...(shelter.photos || [])], photos = [...oldPhotos], uploaded = [];
  const fileEntries = Object.entries(files);
  if (fileEntries.some(([key, list]) => !['photo0', 'photo1', 'photo2'].includes(key) || !Array.isArray(list) || list.length > 1) || fileEntries.reduce((total, [, list]) => total + list.length, 0) > 3) throw fail('写真は3枚まで登録できます。');
  try {
    for (let slot = 0; slot < 3; slot++) {
      if (body[`removePhoto${slot}`] === 'on') photos[slot] = undefined;
      const file = files[`photo${slot}`]?.[0];
      if (file) {
        const photo = await dependencies.uploadPublicPhoto(file, associationId, `shelter-${shelter._id}-${slot}`);
        uploaded.push(photo); photos[slot] = photo;
      }
    }
    Object.assign(shelter, values, { updatedBy: userId, photos: photos.filter(Boolean) });
    await shelter.save();
  } catch (error) {
    await Promise.allSettled(uploaded.map(photo => dependencies.deletePublicPhoto(photo.publicId)));
    if (error.name === 'VersionError') throw fail('避難所が更新されています。画面を開き直してください。', 409);
    throw error;
  }
  const kept = new Set(shelter.photos.map(photo => photo.publicId));
  await Promise.allSettled(oldPhotos.filter(photo => !kept.has(photo.publicId)).map(photo => dependencies.deletePublicPhoto(photo.publicId)));
  return shelter;
}

export async function removeShelter(associationId, shelterId, userId) {
  await requireShelterOfficer(associationId, userId);
  if (!mongoose.isValidObjectId(shelterId)) throw fail('避難所を確認できません。', 404);
  const result = await Shelter.updateOne({ _id: shelterId, association: associationId, active: true }, { $set: { active: false, updatedBy: userId }, $inc: { __v: 1 } });
  if (!result.matchedCount) throw fail('避難所を確認できません。', 404);
}

export async function saveShelterInformation(associationId, userId, body) {
  await requireShelterOfficer(associationId, userId);
  const page = shelterInformationValues(body);
  const result = await NeighborhoodAssociation.updateOne({ _id: associationId, status: 'active', deletedAt: { $exists: false } }, { $set: { shelterInformation: page } }, { runValidators: true });
  if (!result.matchedCount) throw fail('町内会を確認できません。', 404);
  return page;
}
