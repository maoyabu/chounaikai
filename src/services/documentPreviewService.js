// ExcelJS throws when .text is read from a merged cell whose master is blank.
// Display merged content once, at its master cell, and keep blank cells empty.
export const documentCellText = cell => {
  if (cell.isMerged && cell.master.address !== cell.address) return '';
  if (cell.value === null || cell.value === undefined) return '';
  return String(cell.text ?? '').slice(0, 2000);
};
