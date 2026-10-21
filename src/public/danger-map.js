window.initDangerMap = () => {
  const element = document.getElementById('danger-history-map');
  if (!element) return;
  const points = JSON.parse(element.dataset.points), bounds = new google.maps.LatLngBounds();
  const map = new google.maps.Map(element, { center: { lat: points[0].latitude, lng: points[0].longitude }, zoom: 15 });
  points.forEach(point => {
    const position = { lat: point.latitude, lng: point.longitude };
    bounds.extend(position);
    const marker = new google.maps.Marker({ position, map, title: point.title });
    marker.addListener('click', () => {
      const link = document.createElement('a'); link.href = point.url; link.textContent = point.title;
      new google.maps.InfoWindow({ content: link }).open({ map, anchor: marker });
    });
  });
  if (points.length > 1) { map.fitBounds(bounds); google.maps.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > 16) map.setZoom(16); }); }
  window.focusDangerPosition = (lat, lng) => { map.setCenter({ lat, lng }); map.setZoom(16); };
};
