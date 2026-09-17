import mongoose from 'mongoose';

const roleDefinitionSchema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  name: { type: String, required: true, trim: true },
  sortOrder: { type: Number, default: 0, index: true },
  permissions: [{ type: String, required: true }],
  active: { type: Boolean, default: true }
}, { timestamps: true, collection: 'role_definitions' });
roleDefinitionSchema.index({ association: 1, name: 1 }, { unique: true });

const roleAssignmentSchema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: mongoose.Schema.Types.ObjectId, ref: 'RoleDefinition', required: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  districtGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'DistrictGroup' },
  startsAt: { type: Date, required: true },
  endsAt: Date
}, { timestamps: true, collection: 'role_assignments' });
roleAssignmentSchema.index({ association: 1, user: 1, role: 1, startsAt: 1 });

export const RoleDefinition = mongoose.model('RoleDefinition', roleDefinitionSchema);
export const RoleAssignment = mongoose.model('RoleAssignment', roleAssignmentSchema);
