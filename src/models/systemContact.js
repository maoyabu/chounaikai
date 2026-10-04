import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['association', 'system'], required: true },
  body: { type: String, required: true, trim: true, maxlength: 5000 },
  attachments: [{
    fileId: { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    bytes: { type: Number, required: true }
  }],
  createdAt: { type: Date, default: Date.now }
});
const schema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  urgency: { type: Number, required: true, min: 1, max: 5 },
  status: { type: String, enum: ['open', 'resolved'], default: 'open' },
  systemReadAt: Date,
  associationReadAt: Date,
  messages: { type: [messageSchema], required: true }
}, { timestamps: true, collection: 'system_contacts' });
schema.index({ association: 1, updatedAt: -1 });
export const SystemContact = mongoose.model('SystemContact', schema);
