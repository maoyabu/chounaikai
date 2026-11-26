import mongoose from 'mongoose';
const oid = mongoose.Schema.Types.ObjectId;
const pollSchema = new mongoose.Schema({
  association: { type: oid, ref: 'NeighborhoodAssociation', required: true, index: true },
  creator: { type: oid, ref: 'User', required: true },
  scope: { type: String, enum: ['officer', 'group', 'district'], required: true },
  group: { type: oid, ref: 'AssociationGroup' },
  districtGroup: { type: oid, ref: 'DistrictGroup' },
  title: { type: String, required: true, maxlength: 150 },
  memo: { type: String, maxlength: 3000 },
  deadline: { type: Date, required: true },
  candidates: [{ date: { type: String, required: true }, time: { type: String, required: true } }],
  recipients: [{ type: oid, ref: 'User' }]
}, { timestamps: true, collection: 'attendance_polls' });
pollSchema.index({ association: 1, creator: 1, createdAt: -1 });
const responseSchema = new mongoose.Schema({
  association: { type: oid, required: true },
  poll: { type: oid, ref: 'AttendancePoll', required: true },
  user: { type: oid, ref: 'User', required: true },
  answers: [{ type: String, enum: ['○', '△', '×'] }],
  comment: { type: String, maxlength: 1000 }
}, { timestamps: true, collection: 'attendance_responses' });
responseSchema.index({ poll: 1, user: 1 }, { unique: true });
export const AttendancePoll = mongoose.model('AttendancePoll', pollSchema);
export const AttendanceResponse = mongoose.model('AttendanceResponse', responseSchema);
