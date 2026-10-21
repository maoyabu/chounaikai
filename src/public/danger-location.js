/* Shared location helpers; no photo or location data leaves this browser. */
(() => {
  function readPhotoLocation(buffer) {
    try {
      const view = new DataView(buffer);
      const ascii = (offset, length) => String.fromCharCode(...new Uint8Array(buffer, offset, length)).replace(/\0.*$/, '');
      let start = -1, end = view.byteLength;
      if (view.getUint16(0) === 0xffd8) {
        for (let offset = 2; offset + 4 <= end;) {
          if (view.getUint8(offset) !== 0xff) break;
          const marker = view.getUint8(offset + 1);
          if (marker === 0xda || marker === 0xd9) break;
          const size = view.getUint16(offset + 2);
          if (size < 2 || offset + 2 + size > end) break;
          if (marker === 0xe1 && ascii(offset + 4, 6) === 'Exif') { start = offset + 10; end = offset + 2 + size; break; }
          offset += 2 + size;
        }
      } else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
        for (let offset = 12; offset + 8 <= end;) {
          const size = view.getUint32(offset + 4, true);
          if (offset + 8 + size > end) break;
          if (ascii(offset, 4) === 'EXIF') { start = offset + 8; end = start + size; if (ascii(start, 6) === 'Exif') start += 6; break; }
          offset += 8 + size + (size % 2);
        }
      } else if (view.getUint32(0) === 0x89504e47) {
        for (let offset = 8; offset + 12 <= end;) {
          const size = view.getUint32(offset);
          if (offset + size + 12 > end) break;
          if (ascii(offset + 4, 4) === 'eXIf') { start = offset + 8; end = start + size; break; }
          offset += size + 12;
        }
      }
      if (start < 0) return null;
      const little = ascii(start, 2) === 'II';
      if (!little && ascii(start, 2) !== 'MM') return null;
      const check = (offset, bytes) => { if (offset < start || offset + bytes > end) throw new Error('Invalid EXIF'); };
      const u16 = offset => { check(offset, 2); return view.getUint16(offset, little); };
      const u32 = offset => { check(offset, 4); return view.getUint32(offset, little); };
      if (u16(start + 2) !== 42) return null;
      const entries = offset => {
        const count = u16(offset); check(offset + 2, count * 12);
        return Array.from({ length: count }, (_, index) => offset + 2 + index * 12);
      };
      const pointer = entries(start + u32(start + 4)).find(entry => u16(entry) === 0x8825 && u16(entry + 2) === 4 && u32(entry + 4) === 1);
      if (!pointer) return null;
      const gps = entries(start + u32(pointer + 8));
      const coordinate = (tag, refTag, positive, negative) => {
        const entry = gps.find(entry => u16(entry) === tag), ref = gps.find(entry => u16(entry) === refTag);
        if (!entry || !ref || u16(entry + 2) !== 5 || u32(entry + 4) !== 3 || u16(ref + 2) !== 2 || u32(ref + 4) !== 2) return NaN;
        const direction = ascii(ref + 8, 1);
        if (direction !== positive && direction !== negative) return NaN;
        const offset = start + u32(entry + 8);
        const parts = [0, 8, 16].map(delta => u32(offset + delta) / u32(offset + delta + 4));
        if (parts.some(value => !Number.isFinite(value) || value < 0) || parts[1] >= 60 || parts[2] >= 60) return NaN;
        return (parts[0] + parts[1] / 60 + parts[2] / 3600) * (direction === negative ? -1 : 1);
      };
      const latitude = coordinate(2, 1, 'N', 'S'), longitude = coordinate(4, 3, 'E', 'W');
      return Number.isFinite(latitude) && Math.abs(latitude) <= 90 && Number.isFinite(longitude) && Math.abs(longitude) <= 180
        ? { latitude, longitude, locationSource: 'photo', locatedAt: new Date().toISOString() } : null;
    } catch { return null; }
  }
  function getDeviceLocation(geolocation, onSuccess, onFailure) {
    const success = result => onSuccess({ latitude: result.coords.latitude, longitude: result.coords.longitude, accuracy: result.coords.accuracy, locatedAt: new Date(result.timestamp).toISOString(), locationSource: 'device' });
    geolocation.getCurrentPosition(success, error => {
      if (error.code === 1) return onFailure(error);
      // GPS can time out indoors; allow a fresh network/cached fix on retry.
      geolocation.getCurrentPosition(success, onFailure, { enableHighAccuracy: false, maximumAge: 60000, timeout: 15000 });
    }, { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 });
  }
  globalThis.DangerLocation = { readPhotoLocation, getDeviceLocation };
})();
