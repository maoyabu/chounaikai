import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { provideCsrfToken, verifyCsrfToken } from '../middleware/csrf.js';
import { associationFeatureEnabled } from '../services/associationFeatureService.js';
import { equipmentAccess, equipmentSettings, inventoryPeriod, checkInventory, equipmentError, checkedEquipmentId, japanDate } from '../services/equipmentService.js';
import { AssociationEquipment, EquipmentInventory } from '../models/equipment.js';

export const mobileInventoryRouter = express.Router({ mergeParams: true });
const handle = callback => async (req, res, next) => { try { await callback(req, res); } catch (error) { next(error); } };
export const inventoryItem = (item, check) => ({
  id: String(item._id), name: item.name, place: item.place || '未設定', imageURL: item.productImageUrl || '',
  unit: item.unit || '', count: check?.count ?? item.quantity, requiredQuantity: item.minimumQuantity || 0,
  expiryDate: item.expiryDate || '', checked: Boolean(check?.checked), comment: check?.comment || '',
  checkedBy: check?.checkedBy?.displayname || check?.checkedBy?.username || '', checkedAt: check?.checkedAt || null
});
mobileInventoryRouter.use(requireLogin, async (req, res, next) => {
  try {
    const { association } = await equipmentAccess(req.params.associationId, req.user._id, true);
    if (!associationFeatureEnabled(association, 'equipment')) throw equipmentError('この町内会では設備・備品管理を利用していません。', 404);
    res.set('Cache-Control', 'private, no-store');
    next();
  } catch (error) { next(error); }
}, provideCsrfToken);
mobileInventoryRouter.get('/', handle(async (req, res) => {
  const association = req.params.associationId;
  const settings = await equipmentSettings(association), period = inventoryPeriod(settings);
  const [items, checks] = await Promise.all([
    AssociationEquipment.find({ association, deletedAt: null, tracked: true, wishlist: { $ne: true } }).sort({ place: 1, stockCategory: 1, name: 1 }).lean(),
    EquipmentInventory.find({ association, period }).populate('checkedBy', 'displayname username').lean()
  ]);
  const byItem = new Map(checks.map(check => [String(check.equipment), check]));
  res.json({ period, intervalMonths: settings.inventoryIntervalMonths, today: japanDate(), csrfToken: res.locals.csrfToken,
    items: items.map(item => inventoryItem(item, byItem.get(String(item._id)))) });
}));
mobileInventoryRouter.post('/:equipmentId', verifyCsrfToken, handle(async (req, res) => {
  const { associationId, equipmentId } = req.params;
  checkedEquipmentId(equipmentId);
  const check = await checkInventory({ associationId, equipmentId, userId: req.user._id, period: req.body.period, input: req.body });
  // The actor and timestamp returned are those of this successful save, including an unchecked save.
  res.json({ checked: Boolean(check.checked), count: check.count, comment: check.comment || '',
    checkedBy: req.user.displayname || req.user.username || '', checkedAt: check.checkedAt });
}));
