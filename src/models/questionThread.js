import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['resident', 'officer'], required: true },
  body: { type: String, required: true, maxlength: 3000 },
  createdAt: { type: Date, required: true, default: Date.now }
}, { _id: true });

const schema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  districtGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'DistrictGroup' },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  messages: { type: [messageSchema], default: [] },
  status: { type: String, enum: ['unanswered', 'answered', 'no_reply', 'completed'], required: true, default: 'unanswered' },
  residentMessageCount: { type: Number, default: 1 },
  lastResidentAt: { type: Date, required: true },
  lastOfficerAt: Date,
  lastOfficer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  residentReadAt: Date,
  closedAt: Date
}, { timestamps: true, collection: 'association_question_threads' });

schema.index({ association: 1, status: 1, updatedAt: -1 });
schema.index({ author: 1, updatedAt: -1 });

export const QuestionThread = mongoose.model('QuestionThread', schema);
