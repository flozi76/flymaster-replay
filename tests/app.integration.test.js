const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class ElementMock {
  constructor() {
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.listeners = {};
    this.children = [];
    this.classList = {
      add: () => {},
      remove: () => {},
    };
  }

  addEventListener(type, fn) {
    this.listeners[type] ??= [];
    this.listeners[type].push(fn);
  }

  trigger(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn(event);
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
  }
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

test('app bootstraps and loads a Flymaster group track', async () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'app.js'),
    'utf8',
  );

  const domReadyHandlers = [];
  const elements = {
    map: new ElementMock(),
    'btn-load-group': new ElementMock(),
    'group-url': new ElementMock(),
    'live-status': new ElementMock(),
    'pilot-list': new ElementMock(),
    'pilot-count': new ElementMock(),
    'btn-clear': new ElementMock(),
    'btn-play': new ElementMock(),
    'btn-pause': new ElementMock(),
    'btn-rewind': new ElementMock(),
    'speed-select': new ElementMock(),
    'time-slider': new ElementMock(),
    'time-display': new ElementMock(),
    'drop-zone': new ElementMock(),
    'file-input': new ElementMock(),
    'group-token': new ElementMock(),
  };
  elements['group-url'].value = 'https://lt.flymaster.net/bs.php?grp=7784';
  elements['group-token'].value = '';

  let mapInitCount = 0;

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    Date,
    Math,
    Promise,
    parseInt,
    isFinite,
    window: { location: { hostname: 'flozi76.github.io' } },
    document: {
      querySelector: selector => {
        if (!selector.startsWith('#')) return null;
        return elements[selector.slice(1)] ?? null;
      },
      querySelectorAll: () => [],
      addEventListener: (type, fn) => {
        if (type === 'DOMContentLoaded') domReadyHandlers.push(fn);
      },
      createElement: () => new ElementMock(),
      getElementById: id => elements[id] ?? null,
    },
    parseIGC: () => ({ pilotName: 'Pilot', fixes: [] }),
    FileReader: class {},
    FlymasterClient: {
      parseGroupId: () => '7784',
      getPilots: async () => [{ serial: '123', name: 'Pilot One' }],
      tryGetLiveData: async () => ({
        123: [
          { time: 100, lat: 47.1, lon: 10.1, alt: 1200 },
          { time: 130, lat: 47.2, lon: 10.2, alt: 1250 },
        ],
      }),
    },
    L: {
      map: () => {
        mapInitCount += 1;
        return { fitBounds: () => {} };
      },
      tileLayer: () => ({ addTo: () => {} }),
      polyline: (latLngs = []) => ({
        _latLngs: latLngs,
        addTo() { return this; },
        remove() {},
        setLatLngs(next) { this._latLngs = next; },
      }),
      circleMarker: latLng => ({
        _latLng: latLng,
        addTo() { return this; },
        remove() {},
        bindTooltip() { return this; },
        setLatLng(next) { this._latLng = next; },
        setStyle() {},
      }),
      latLngBounds: pts => pts,
    },
  });

  vm.runInContext(source, context, { filename: 'app.js' });
  assert.equal(domReadyHandlers.length, 1);

  domReadyHandlers[0]();
  assert.equal(mapInitCount, 1);

  elements['btn-load-group'].trigger('click');
  await flush();
  await flush();

  assert.equal(elements['pilot-count'].textContent, '1 pilot');
  assert.match(elements['live-status'].textContent, /Loaded 1 pilot/);
  assert.equal(elements['btn-load-group'].disabled, false);
});
