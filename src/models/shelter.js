import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 150 },
  address: { type: String, required: true, trim: true, maxlength: 500 },
  phone: { type: String, trim: true, maxlength: 50, default: '' },
  capacity: { type: Number, min: 0, max: 1000000, validate: { validator: value => value == null || Number.isInteger(value), message: '収容人数は整数で入力してください。' } },
  kind: { type: String, trim: true, maxlength: 100, default: '' },
  dangerPoints: { type: String, maxlength: 2000, default: '' },
  photos: { type: [{ url: String, publicId: String }], default: [], validate: { validator: photos => photos.length <= 3, message: '写真は3枚まで登録できます。' } },
  active: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true, optimisticConcurrency: true, collection: 'shelters' });
schema.index({ association: 1, active: 1, name: 1 });
export const Shelter = mongoose.model('Shelter', schema);
