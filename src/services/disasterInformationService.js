import { loadShelters } from './shelterService.js';
import { loadResidentSafety } from './safetyService.js';
import { alertLevels } from '../public/alert-level-data.js';
import { buildingStatuses, safetyStatuses, safetyEventKey, memberSafetyStatus, householdSafetyState } from '../lib/safetyStatus.js';

const activeAlert = association => Number.isInteger(association.alertLevel) && association.alertLevel >= 1 && association.alertLevel <= 5;

export async function loadDisasterInformation(associationId, userId, query = {}) {
  const shelters = await loadShelters(associationId, userId, query.selected ? String(query.selected) : undefined);
  let active = activeAlert(shelters.association);
  let selectedTab = active && ['safety', 'alerts', 'shelters'].includes(query.tab) ? query.tab : active ? 'safety' : 'shelters';
  let safety = {};
  if (selectedTab === 'safety') {
    safety = await loadResidentSafety(associationId, userId);
    active = activeAlert(safety.association);
    if (!active) selectedTab = 'shelters';
  }
  return { ...shelters, ...safety, activeAlert: active, selectedTab, alertLevels, buildingStatuses, safetyStatuses, safetyEventKey, memberSafetyStatus, householdSafetyState };
}
