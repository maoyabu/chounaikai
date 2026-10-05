import mongoose from 'mongoose';
import { personalDataPlugin } from '../security/personalDataPlugin.js';

const annualOfficerSchema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  fiscalYear: { type: Number, required: true, min: 2000, max: 2200, index: true },
  // 未紐付けの役員を先に登録できるよう、会員紐付け前は任意。
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: { type: String, trim: true },
  nameKana: { type: String, trim: true },
  districtGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'DistrictGroup' },
  district: { type: mongoose.Schema.Types.ObjectId, ref: 'DistrictGroup' },
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'DistrictGroup' },
  address: { type: String, trim: true },
  phone: { type: String, trim: true },
  mobilePhone: { type: String, trim: true },
  role: { type: mongoose.Schema.Types.ObjectId, ref: 'RoleDefinition' },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  selectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  cancelledAt: Date
}, { timestamps: true, collection: 'annual_officers' });

annualOfficerSchema.index({ association: 1, fiscalYear: 1, user: 1 }, { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } });
annualOfficerSchema.plugin(personalDataPlugin, { collection: 'annual_officers' });

export const AnnualOfficer = mongoose.model('AnnualOfficer', annualOfficerSchema);
