import mongoose from 'mongoose';
const identity = {
  association: { type: mongoose.Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true },
  report: { type: mongoose.Schema.Types.ObjectId, ref: 'GoodPlace', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
};
const likeSchema = new mongoose.Schema(identity, { timestamps: true, collection: 'good_place_likes' });
likeSchema.index({ association: 1, report: 1, user: 1 }, { unique: true });
const commentSchema = new mongoose.Schema({
  ...identity,
  body: { type: String, required: true, trim: true, maxlength: 1000 },
  hiddenAt: { type: Date, default: null },
  hiddenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, collection: 'good_place_comments' });
commentSchema.index({ association: 1, report: 1, hiddenAt: 1, createdAt: -1, _id: -1 });
export const GoodPlaceLike = mongoose.model('GoodPlaceLike', likeSchema);
export const GoodPlaceComment = mongoose.model('GoodPlaceComment', commentSchema);
