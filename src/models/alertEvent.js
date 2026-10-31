import mongoose from 'mongoose';
import { personalDataPlugin } from '../security/personalDataPlugin.js';

const changeSchema = new mongoose.Schema({
  level: { type: Number, enum: [0, 1, 2, 3, 4, 5], required: true },
  at: { type: Date, required: true },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byName: String,
  noticePending: { type: Boolean, default: false },
  noticeKey: String,
  noticePreviousLevel: Number,
  noticeAssociationName: String,
  kind: { type: String, enum: ['registered', 'changed', 'confirmed', 'cleared', 'carried'], required: true }
}, { _id: false });
const schema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true },
  eventKey: { type: String, required: true },
  startedAt: { type: Date, required: true },
  endedAt: Date,
  peakLevel: { type: Number, min: 1, max: 5, required: true },
  historyIncomplete: { type: Boolean, default: false },
  changes: { type: [changeSchema], default: [] },
  // JSON snapshot is encrypted at the storage boundary, including names and addresses.
  safetySnapshot: String
}, { timestamps: true, collection: 'alert_events' });
schema.index({ association: 1, eventKey: 1 }, { unique: true });
schema.index({ association: 1, startedAt: -1 });
schema.index({ 'changes.noticePending': 1 });
schema.plugin(personalDataPlugin, { collection: 'alert_events' });
export const AlertEvent = mongoose.model('AlertEvent', schema);
