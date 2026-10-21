import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/public/danger-location.js';
const { readPhotoLocation, getDeviceLocation } = globalThis.DangerLocation;
function photo(little = true, south = false) {
  const bytes = new Uint8Array(160), view = new DataView(bytes.buffer);
  const u16 = (offset, value) => view.setUint16(offset, value, little);
  const u32 = (offset, value) => view.setUint32(offset, value, little);
  bytes.set([255,216,255,225]); view.setUint16(4, 154);
  bytes.set([69,120,105,102,0,0], 6);
  const start = 12;
  bytes.set(little ? [73,73] : [77,77], start); u16(start+2,42); u32(start+4,8);
  u16(start+8,1); u16(start+10,0x8825); u16(start+12,4); u32(start+14,1); u32(start+18,26);
  u16(start+26,4);
  for (let index = 0; index < 4; index++) {
    const offset = start+28+index*12;
    u16(offset,index+1); u16(offset+2,index%2 ? 5 : 2); u32(offset+4,index%2 ? 3 : 2);
    if (index%2) u32(offset+8,index === 1 ? 80 : 104);
    else bytes[offset+8] = index === 0 ? (south ? 83 : 78) : 69;
  }
  [35,30,0,139,45,0].forEach((number,index)=>{ u32(start+80+index*8,number);u32(start+84+index*8,1); });
  return bytes.buffer;
}
test('reads photo GPS in both EXIF byte orders with correct hemispheres', () => {
  for (const little of [true,false]) {
    const result = readPhotoLocation(photo(little));
    assert.equal(result.latitude,35.5); assert.equal(result.longitude,139.75);
    assert.equal(result.locationSource,'photo'); assert.equal(result.accuracy,undefined);
    assert.equal(readPhotoLocation(photo(little,true)).latitude,-35.5);
  }
});
test('missing and malformed photo metadata returns null without breaking photo selection', () => {
  for (const buffer of [new ArrayBuffer(0),new Uint8Array([255,216,255,225,255,255]).buffer,photo().slice(0,100)]) assert.equal(readPhotoLocation(buffer),null);
});
test('GPS timeout retries with network location and a recent cached fix', () => {
  const calls=[]; let result;
  const geolocation={getCurrentPosition(success,failure,options){calls.push(options);if(calls.length===1) failure({code:3});else success({coords:{latitude:35,longitude:139,accuracy:80},timestamp:Date.now()});}};
  getDeviceLocation(geolocation,value=>{result=value;},()=>assert.fail());
  assert.equal(calls.length,2);assert.equal(calls[1].enableHighAccuracy,false);assert.equal(calls[1].maximumAge,60000);assert.equal(result.locationSource,'device');
});
test('permission denial is reported directly and a second failure is surfaced', () => {
  let count=0, code;
  getDeviceLocation({getCurrentPosition(_success,failure){count++;failure({code:1});}},()=>assert.fail(),error=>{code=error.code;});
  assert.equal(count,1);assert.equal(code,1);
  getDeviceLocation({getCurrentPosition(_success,failure){failure({code:2});}},()=>assert.fail(),error=>{code=error.code;});
  assert.equal(code,2);
});
