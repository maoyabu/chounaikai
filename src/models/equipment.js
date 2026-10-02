import mongoose from 'mongoose';
const { Schema } = mongoose;
const association = { type: Schema.Types.ObjectId, ref: 'NeighborhoodAssociation', required: true, index: true };
const user = { type: Schema.Types.ObjectId, ref: 'User' };
const equipmentSchema = new Schema({
  association, createdBy: user, name: { type: String, required: true, maxlength: 120 }, note: { type: String, maxlength: 500 },
  place: { type: String, required: true, maxlength: 100 }, unit: { type: String, required: true, maxlength: 20 },
  quantity: { type: Number, min: 0, required: true }, minimumQuantity: { type: Number, min: 0, default: 0 },
  isConsumable: Boolean, stockCategory: { type: String, maxlength: 100 }, disasterCategory: { type: String, maxlength: 100 },
  wishlist: Boolean, maintenance: { type: String, maxlength: 1000 }, productUrl: String, productImageUrl: String,
  expiryDate: String, tracked: { type: Boolean, default: true }, lendable: Boolean, availableFrom: String, availableUntil: String,
  reservations: [{ _id: false, loanId: { type: Schema.Types.ObjectId, required: true }, startAt: Date, endAt: Date, quantity: Number }],
  loanBlocks: [{ allDay: Boolean, startTime: String, endTime: String, startAt: Date, endAt: Date, startDate: { type: String, required: true }, endDate: { type: String, required: true }, reason: { type: String, required: true, maxlength: 500 }, createdBy: user, createdAt: { type: Date, default: Date.now } }],
  reservationVersion: { type: Number, default: 0 }, deletedAt: Date
}, { timestamps: true, collection: 'association_equipment' });
equipmentSchema.index({ association: 1, deletedAt: 1, place: 1 });
const settingsSchema = new Schema({ loanPublic: { type: Boolean, default: true }, association: { ...association, unique: true }, inventoryIntervalMonths: { type: Number, default: 3, min: 1, max: 120 }, inventoryStartMonth: { type: String, required: true }, expiryAlertMonths: { type: Number, default: 1, min: 1, max: 120 } }, { timestamps: true, collection: 'association_equipment_settings' });
const checkSchema = new Schema({ association, equipment: { type: Schema.Types.ObjectId, ref: 'AssociationEquipment', required: true }, period: { type: String, required: true }, checked: Boolean, count: Number, comment: String, checkedBy: user, checkedAt: Date,
  history: [{ checked: Boolean, count: Number, comment: String, actor: user, at: Date }]
}, { timestamps: true, collection: 'association_equipment_inventory' });
checkSchema.index({ association: 1, equipment: 1, period: 1 }, { unique: true });
const loanSchema = new Schema({ association, equipment: { type: Schema.Types.ObjectId, ref: 'AssociationEquipment', required: true }, borrower: { ...user, required: true }, startDate: { type: String, required: true }, endDate: { type: String, required: true }, quantity: { type: Number, min: 1, required: true }, purpose: { type: String, maxlength: 500 },
  allDay: Boolean, startTime: String, endTime: String, startAt: Date, endAt: Date,
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled', 'returned'], default: 'pending' }, decidedBy: user, decidedAt: Date
}, { timestamps: true, collection: 'association_equipment_loans' });
loanSchema.index({ association: 1, equipment: 1, status: 1, startDate: 1, endDate: 1 });
const purchaseSchema = new Schema({ association, equipment: { type: Schema.Types.ObjectId, ref: 'AssociationEquipment', required: true }, name: String, quantity: Number, expiryDate: String, receivedBy: user }, { timestamps: true, collection: 'association_equipment_purchases' });
const reminderSchema = new Schema({ key: { type: String, required: true, unique: true }, association, sentAt: { type: Date, default: Date.now } }, { collection: 'association_equipment_reminders' });
export const AssociationEquipment = mongoose.model('AssociationEquipment', equipmentSchema);
export const EquipmentSettings = mongoose.model('EquipmentSettings', settingsSchema);
export const EquipmentInventory = mongoose.model('EquipmentInventory', checkSchema);
export const EquipmentLoan = mongoose.model('EquipmentLoan', loanSchema);
export const EquipmentPurchase = mongoose.model('EquipmentPurchase', purchaseSchema);
export const EquipmentReminder = mongoose.model('EquipmentReminder', reminderSchema);
