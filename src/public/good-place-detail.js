const commentsDialog = document.getElementById('good-place-reactions');
if (commentsDialog) {
  document.querySelector('[data-open-comments]').addEventListener('click', () => commentsDialog.showModal());
  commentsDialog.querySelector('[data-close-comments]').addEventListener('click', () => commentsDialog.close());
  const restoreComments = () => {
    if ((location.hash === '#good-place-reactions' || new URLSearchParams(location.search).has('commentPage')) && !commentsDialog.open) commentsDialog.showModal();
  };
  window.addEventListener('hashchange', restoreComments);
  restoreComments();
}

const locationLink = document.querySelector('.good-place-location-link');
if (locationLink) {
  locationLink.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
    const mapWindow = window.open('about:blank', '_blank', 'popup,width=1200,height=850,resizable=yes,scrollbars=yes');
    if (!mapWindow) return;
    mapWindow.opener = null;
    mapWindow.location.replace(locationLink.href);
    event.preventDefault();
  });
}

const detailPhotoDialog = document.getElementById('good-place-detail-photo-dialog');
const detailPhotoTrigger = document.querySelector('[data-open-detail-photo]');
if (detailPhotoDialog && detailPhotoTrigger) {
  detailPhotoTrigger.addEventListener('click', () => detailPhotoDialog.showModal());
  detailPhotoDialog.addEventListener('click', event => {
    if (event.target === detailPhotoDialog) detailPhotoDialog.close();
  });
}
