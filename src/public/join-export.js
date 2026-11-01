const exportDialog = document.getElementById('join-export-dialog');
const downloadButton = document.getElementById('join-download');
const printButton = document.getElementById('join-print');
const closeButton = document.getElementById('join-export-close');
const exportStatus = document.getElementById('join-export-status');
const preview = document.getElementById('join-export-preview');
let imageUrl;
let filename;
let busy = false;
const printImage = document.createElement('img');
printImage.className = 'join-print-image';
printImage.alt = '加入案内';
document.body.append(printImage);

// Freeze grid positions using the browser's layout before canvas rendering.
// This also preserves the screen layout in renderers without CSS Grid support.
function freezeGrids(root) {
  root.querySelectorAll('.join-benefit-grid, .bulletin-outcome-grid').forEach(grid => {
    const bounds = grid.getBoundingClientRect();
    const positions = [...grid.children].map(child => ({ child, rect: child.getBoundingClientRect() }));
    grid.style.display = 'block';
    grid.style.position = 'relative';
    grid.style.height = `${bounds.height}px`;
    positions.forEach(({ child, rect }) => Object.assign(child.style, {
      position: 'absolute', boxSizing: 'border-box', margin: '0',
      left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`
    }));
  });
}

document.getElementById('join-export-open').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  downloadButton.disabled = printButton.disabled = true;
  preview.hidden = true;
  exportStatus.textContent = '画像を作成しています…';
  exportDialog.showModal();
  const source = document.querySelector('.join-page');
  const clone = source.cloneNode(true);
  clone.querySelectorAll('.join-screen-only').forEach(element => element.remove());
  const container = document.createElement('div');
  container.className = 'join-image-container';
  clone.style.width = `${source.getBoundingClientRect().width}px`;
  container.append(clone);
  document.body.append(container);
  try {
    await document.fonts.ready;
    await Promise.all([...clone.querySelectorAll('img')].map(img => img.decode()));
    freezeGrids(clone);
    const width = Math.ceil(clone.getBoundingClientRect().width);
    const height = Math.ceil(clone.getBoundingClientRect().height);
    // Bound memory use for unusually long guidance pages.
    const scale = Math.min(2, 16384 / Math.max(width, height), Math.sqrt(24000000 / (width * height)));
    const canvas = await window.html2canvas(clone, {
      scale, backgroundColor: '#ffffff', width, height,
      windowWidth: window.innerWidth, windowHeight: window.innerHeight, scrollY: 0
    });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Image encoding failed');
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = URL.createObjectURL(blob);
    preview.src = printImage.src = imageUrl;
    await Promise.all([preview.decode(), printImage.decode()]);
    filename = `${source.querySelector('h1').textContent.trim().replace(/[\\/:*?"<>|]/g, '_')}_加入のご案内.png`;
    preview.hidden = false;
    downloadButton.disabled = printButton.disabled = false;
    exportStatus.textContent = 'この画像を保存・印刷できます。印刷では用紙1枚に収まるように縮小します。';
  } catch (error) {
    exportStatus.textContent = '画像を作成できませんでした。閉じてからもう一度お試しください。';
  } finally {
    container.remove();
    busy = false;
  }
});
closeButton.addEventListener('click', () => { if (!busy) exportDialog.close(); });
exportDialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
downloadButton.addEventListener('click', () => {
  if (downloadButton.disabled || !imageUrl) return;
  const link = document.createElement('a');
  link.href = imageUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
});
// Apply to browser-menu printing too, once an image has been generated.
window.addEventListener('beforeprint', () => {
  if (imageUrl && !printButton.disabled) document.body.classList.add('join-image-printing');
});
window.addEventListener('afterprint', () => document.body.classList.remove('join-image-printing'));
printButton.addEventListener('click', () => {
  if (printButton.disabled || !imageUrl) return;
  exportDialog.close();
  document.body.classList.add('join-image-printing');
  window.print();
});
