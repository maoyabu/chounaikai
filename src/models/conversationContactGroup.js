import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  channel: { type: String, enum: ['district', 'association_group'], required: true },
  context: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true, collection: 'conversation_contact_groups' });

schema.index({ association: 1, channel: 1, context: 1, name: 1 }, { unique: true });

export const ConversationContactGroup = mongoose.model('ConversationContactGroup', schema);
