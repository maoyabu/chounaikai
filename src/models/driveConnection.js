import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, unique: true },
  clientId: String, clientSecret: { type: String, select: false },
  refreshToken: { type: String, select: false }, rootFolderId: String,
  connectedAt: Date, accountEmail: String
}, { timestamps: true });
export const DriveConnection = mongoose.model('DriveConnection', schema);
