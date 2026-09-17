import mongoose from 'mongoose';

const tenantField = { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true };

const departmentSchema = new mongoose.Schema({
  association: tenantField,
  name: { type: String, required: true, trim: true },
  sortOrder: { type: Number, default: 0, index: true },
  active: { type: Boolean, default: true }
}, { timestamps: true, collection: 'departments' });
departmentSchema.index({ association: 1, name: 1 }, { unique: true });

const districtGroupSchema = new mongoose.Schema({
  association: tenantField,
  name: { type: String, required: true, trim: true },
  sortOrder: { type: Number, default: 0, index: true },
  active: { type: Boolean, default: true }
}, { timestamps: true, collection: 'district_groups' });
districtGroupSchema.index({ association: 1, name: 1 }, { unique: true });

const householdSchema = new mongoose.Schema({
  association: tenantField,
  displayName: { type: String, required: true, trim: true },
  districtGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'DistrictGroup', required: true, index: true },
  representative: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  address: {
    postalCode: { type: String, required: true },
    street: { type: String, required: true },
    building: String
  },
  phone: String,
  active: { type: Boolean, default: true },
  deletedAt: Date,
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, collection: 'households' });
householdSchema.index({ association: 1, representative: 1 }, { unique: true });

const householdMemberSchema = new mongoose.Schema({
  association: tenantField,
  household: { type: mongoose.Schema.Types.ObjectId, ref: 'Household', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: { type: String, required: true, trim: true },
  nameKana: { type: String, required: true, trim: true },
  birthDate: { type: Date, required: true },
  gender: { type: String, enum: ['male', 'female', 'other', 'unspecified'], required: true },
  email: { type: String, trim: true, lowercase: true },
  lineAccount: { type: String, trim: true },
  isRepresentative: { type: Boolean, default: false },
  relationship: String,
  startsAt: Date,
  endsAt: Date
}, { timestamps: true, collection: 'household_members' });
householdMemberSchema.index({ household: 1, user: 1 }, { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } });
export const Department = mongoose.model('Department', departmentSchema);
export const DistrictGroup = mongoose.model('DistrictGroup', districtGroupSchema);
export const Household = mongoose.model('Household', householdSchema);
export const HouseholdMember = mongoose.model('HouseholdMember', householdMemberSchema);
