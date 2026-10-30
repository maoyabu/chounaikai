const exportDialog = document.getElementById('join-export-dialog');
const downloadButton = document.getElementById('join-download');
const printButton = document.getElementById('join-print');
const closeButton = document.getElementById('join-export-close');
const exportStatus = document.getElementById('join-export-status');
document.getElementById('join-export-open').addEventListener('click', () => {
  exportStatus.textContent = '';
  exportDialog.showModal();
});
closeButton.addEventListener('click', () => exportDialog.close());
printButton.addEventListener('click', () => { exportDialog.close(); window.print(); });
downloadButton.addEventListener('click', async () => {
  downloadButton.disabled = printButton.disabled = closeButton.disabled = true;
  exportStatus.textContent = 'PDFを作成しています…';
  const source = document.querySelector('.join-page');
  const clone = source.cloneNode(true);
  clone.classList.add('join-pdf');
  clone.querySelectorAll('.join-screen-only').forEach(element => element.remove());
  const container = document.createElement('div');
  container.className = 'join-pdf-container';
  container.append(clone);
  document.body.append(container);
  try {
    if (typeof window.html2pdf !== 'function') throw new Error('PDF library unavailable');
    await document.fonts.ready;
    await Promise.all([...clone.querySelectorAll('img')].map(img => img.decode()));
    const title = source.querySelector('h1').textContent.trim().replace(/[\\/:*?"<>|]/g, '_');
    await window.html2pdf().set({
      margin: 12, filename: `${title}_加入のご案内.pdf`,
      image: { type: 'jpeg', quality: .98 },
      html2canvas: { scale: 2, backgroundColor: '#ffffff', windowWidth: 900, scrollY: 0 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['.bulletin-benefit-card', '.bulletin-outcome-card', '.join-qr', 'h2', 'h3'] }
    }).from(clone).save();
    exportStatus.textContent = 'PDFファイルをダウンロードしました。';
  } catch (error) {
    exportStatus.textContent = 'PDFを作成できませんでした。もう一度お試しください。';
  } finally {
    container.remove();
    downloadButton.disabled = printButton.disabled = closeButton.disabled = false;
  }
});
exportDialog.addEventListener('cancel', event => { if (downloadButton.disabled) event.preventDefault(); });
