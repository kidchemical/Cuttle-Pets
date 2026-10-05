"""Real WebGL readback and screenshot checks, with native window operations mocked.

python3 tests/browser/render_readback.py --base-url http://127.0.0.1:1420
Does not establish native desktop input delivery or hardware frame-rate gains.
"""
import argparse
import json
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:1420')
base = parser.parse_args().base_url.rstrip('/')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    page = browser.new_page(viewport={'width': 600, 'height': 700})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script("""let callback = 0;
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'settings' }, currentWebview: { label: 'settings', windowLabel: 'settings' } },
        invoke: async () => null, transformCallback: () => ++callback,
        unregisterCallback: () => {}, convertFileSrc: s => s,
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      window.pixelReads = [];
      const original = WebGL2RenderingContext.prototype.readPixels;
      WebGL2RenderingContext.prototype.readPixels = function(...args) {
        if (window.onNextPixelRead && args[2] === 1) { const fn = window.onNextPixelRead; delete window.onNextPixelRead; queueMicrotask(fn); }
        pixelReads.push({width: args[2], height: args[3], async: typeof args[6] === 'number'});
        return original.apply(this, args);
      };
    """)
    def mock(route):
        route.fulfill(status=200, content_type='application/json', body=json.dumps({}), headers={'Access-Control-Allow-Origin': '*'})
    page.route('http://127.0.0.1:8790/**', mock)
    page.goto(base + '/?settings')
    page.evaluate("""async () => {
      const {default: React} = await import('/node_modules/.vite/deps/react.js');
      const {default: {createRoot}} = await import('/node_modules/.vite/deps/react-dom_client.js');
      const {VRMScene} = await import('/src/components/VRMScene.tsx');
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:0;z-index:10000';
      document.body.append(host);
      window.sceneRef = React.createRef();
      window.sceneRoot = createRoot(host);
      window.__clawInputRegionsEnabled = true;
      sceneRoot.render(React.createElement(VRMScene, {ref:sceneRef, modelPath:'/model1.vrm', idleAnimationPath:'/idle_loop.vrma', qualitySettings:{preset:'ultra',pixelRatioCap:4,maxFps:60,springBones:true}}));
    }""")
    page.wait_for_function('window.__clawInputRegions?.length > 0', timeout=60000)
    results = page.evaluate("""async () => {
      const regions = window.__clawInputRegions;
      if (!regions.every(r => r.x >= 0 && r.y >= 0 && r.x + r.width <= innerWidth && r.y + r.height <= innerHeight)) throw Error('Mask outside viewport');
      const screenshot = sceneRef.current.captureScreenshot();
      const image = new Image(); image.src = screenshot; await image.decode();
      const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
      const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
      // Pick an opaque pixel close to the middle, away from silhouette edges.
      let chosen = null, score = Infinity;
      for(let y=0; y<c.height; y++) for(let x=0; x<c.width; x++) {
        if (pixels[(y*c.width+x)*4+3] < 250) continue;
        const d = (x-c.width/2)**2 + (y-c.height/2)**2;
        if(d < score) {score=d;chosen={x,y};}
      }
      if(!chosen) throw Error('Blank screenshot');
      const hit = await __clawHitTest(chosen.x / c.width * innerWidth, chosen.y / c.height * innerHeight);
      const empty = await __clawHitTest(0, 0);
      const outside = await __clawHitTest(-1, -1);
      // Multiple callers and teardown must resolve rather than hang.
      const superseded = __clawHitTest(0, 0);
      window.onNextPixelRead = () => sceneRoot.unmount();
      const onTeardown = __clawHitTest(300, 350);
      const settled = await Promise.race([Promise.all([superseded,onTeardown]),new Promise((_,reject)=>setTimeout(()=>reject(Error('Hit-test hung on teardown')),1000))]);
      return {hit,empty,outside,regions:regions.length,reads:pixelReads,settled,screenshot:screenshot.slice(0,22)};
    }""")
    assert results['hit'] is True, results
    assert results['empty'] is False, results
    assert results['outside'] is False, results
    assert results['settled'] == [True, True], results
    assert results['screenshot'] == 'data:image/png;base64,', results
    assert results['reads'] and all(r['async'] for r in results['reads']), results
    assert any(r['width'] == 128 for r in results['reads']), results
    assert any(r['width'] == 1 and r['height'] == 1 for r in results['reads']), results
    page.wait_for_timeout(250)  # Allow in-flight GPU fences and cleanup to finish.
    assert not errors, errors
    print('WebGL passed: async silhouette/cursor reads, opaque/transparent hits, screenshot alpha, bounds, and teardown.')
    browser.close()
