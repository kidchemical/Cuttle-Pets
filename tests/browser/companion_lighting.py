"""Real WebGL companion lighting through VRMScene, with native calls mocked.

python3 tests/browser/companion_lighting.py --base-url http://127.0.0.1:1420
An optional --asset /path/to/pet.glb checks an imported asset without modifying it.
This verifies rendering, not native desktop interaction.
"""
import argparse
import base64
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:1420')
parser.add_argument('--asset', type=Path)
args = parser.parse_args()
base = args.base_url.rstrip('/')
output = Path(__file__).resolve().parents[2] / 'temp'
output.mkdir(exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    page = browser.new_page(viewport={'width': 600, 'height': 600})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script("""let callback = 0;
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
        invoke: async () => null, transformCallback: () => ++callback,
        unregisterCallback: () => {}, convertFileSrc: s => s,
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    """)
    page.route(base + '/companion-lighting-test', lambda route: route.fulfill(
        content_type='text/html', body='<html><body style="margin:0;background:#222"></body></html>'))
    asset_bytes = args.asset.read_bytes() if args.asset else None
    def server_mock(route):
        if '/assets/pets/serve/' in route.request.url:
            route.fulfill(content_type='model/gltf-binary', body=asset_bytes, headers={'Access-Control-Allow-Origin': '*'})
        else:
            route.fulfill(content_type='application/json', body='{}', headers={'Access-Control-Allow-Origin': '*'})
    page.route('http://127.0.0.1:8790/**', server_mock)
    page.goto(base + '/companion-lighting-test')
    if asset_bytes is None:
        # Export a textured PBR fixture with the chao's relevant material traits.
        encoded = page.evaluate("""async () => {
          const T = await import('/node_modules/.vite/deps/three.js');
          const {GLTFExporter} = await import('/node_modules/.vite/deps/three_addons_exporters_GLTFExporter__js.js');
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#66bbaa'; ctx.fillRect(0,0,2,2);
          const map = new T.CanvasTexture(canvas); map.colorSpace = T.SRGBColorSpace;
          const material = new T.MeshPhysicalMaterial({map, metalness:1, roughness:0.85, specularIntensity:0});
          material.name = 'body';
          const model = new T.Group(); model.add(new T.Mesh(new T.SphereGeometry(0.5,24,16),material));
          const buffer = await new GLTFExporter().parseAsync(model,{binary:true});
          return btoa(String.fromCharCode(...new Uint8Array(buffer)));
        }""")
        asset_bytes = base64.b64decode(encoded)
    results = page.evaluate("""async () => {
      const {default:RefreshRuntime} = await import('/@react-refresh');
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const T = await import('/node_modules/.vite/deps/three.js');
      const previousRender = T.Mesh.prototype.onBeforeRender;
      T.Mesh.prototype.onBeforeRender = function(renderer, scene, camera) {window.actualScene = {renderer,scene,camera}};
      const {default:React} = await import('/node_modules/.vite/deps/react.js');
      const {default:{createRoot}} = await import('/node_modules/.vite/deps/react-dom_client.js');
      const {VRMScene} = await import('/src/components/VRMScene.tsx');
      const {createPetConfig} = await import('/src/companions.ts');
      const {DEFAULT_GLOBAL_LIGHTING,DEFAULT_CURSOR_LIGHT} = await import('/src/lighting.ts');
      const cfg = createPetConfig('test','Test','test.glb',{parts:[],bones:[],clips:[],materials:[]});
      cfg.anchor = 'beside'; cfg.idle.style = 'still'; cfg.limbMotion = 0; cfg.occasional.enabled = false;
      const darkStage = {...DEFAULT_GLOBAL_LIGHTING,ambientIntensity:0,keyIntensity:0,fillIntensity:0};
      const host = document.createElement('div'); host.style.cssText = 'position:fixed;inset:0'; document.body.append(host);
      const root = createRoot(host), ref = React.createRef();
      const props = {ref,modelPath:'/model1.vrm',pets:[cfg],lightingSettings:darkStage,cursorLightSettings:DEFAULT_CURSOR_LIGHT,
        qualitySettings:{preset:'ultra',pixelRatioCap:1,maxFps:60,springBones:true}};
      root.render(React.createElement(VRMScene,props));
      await new Promise((resolve,reject) => {
        const interval = setInterval(() => {if(window.actualScene?.scene.getObjectByName('pet:test')?.visible){clearInterval(interval);clearTimeout(timer);resolve()}},50);
        const timer = setTimeout(() => {clearInterval(interval);reject(Error('Companion load timed out'))},30000);
      });
      await new Promise(resolve=>setTimeout(resolve,400)); // Finish the appearance transition before framing.
      ref.current.setSuspended(true);
      const {scene,renderer,camera} = actualScene;
      const holder = scene.getObjectByName('pet:test');
      const box = new T.Box3().setFromObject(holder), center = box.getCenter(new T.Vector3()), size = box.getSize(new T.Vector3());
      camera.position.copy(center).add(new T.Vector3(0,0,size.y*3)); camera.lookAt(center); camera.updateProjectionMatrix();
      // Isolate the companion in the existing renderer for pixel comparisons.
      for(const child of scene.children) if(child.name !== 'companions' && !child.isLight) child.visible = false;
      function pixels() {
        const image = ref.current.captureScreenshot(), gl = renderer.getContext();
        const data = new Uint8Array(600*600*4); gl.readPixels(0,0,600,600,gl.RGBA,gl.UNSIGNED_BYTE,data);
        let count = 0, rgb = [0,0,0];
        for(let i=0;i<data.length;i+=4) if(data[i+3]>250){count++;for(let c=0;c<3;c++)rgb[c]+=data[i+c]}
        if(count < 100) throw Error('Companion render blank');
        return {count,rgb:rgb.map(v=>v/count),image};
      }
      async function stage(settings) {
        props.lightingSettings = settings;
        root.render(React.createElement(VRMScene,{...props}));
        ref.current.setSuspended(false);
        // Wait for a rendered frame using the new props and stage fill.
        await new Promise(resolve=>setTimeout(resolve,100));
        ref.current.setSuspended(true);
      }
      const dark = pixels();
      await stage(DEFAULT_GLOBAL_LIGHTING); const white = pixels();
      await stage({...DEFAULT_GLOBAL_LIGHTING,ambientColor:'#ff0000',keyColor:'#ff0000',fillColor:'#ff0000'}); const redStage = pixels();
      await stage(darkStage);
      // A point light in the real cursor rig shades the companion normally.
      const point = scene.children.find(o=>o.isPointLight);
      point.visible = true; point.color.set('#ff0000'); point.intensity = 0.4;
      point.position.copy(center).add(new T.Vector3(0,0,size.y)); const redCursor = pixels();
      point.visible = false; const darkAgain = pixels();
      root.unmount(); T.Mesh.prototype.onBeforeRender = previousRender;
      return {dark,white,redStage,redCursor,darkAgain};
    }""")
    for name, result in results.items():
        (output / f'companion-lighting-{name}.png').write_bytes(base64.b64decode(result.pop('image').split(',')[1]))
    assert max(results['dark']['rgb']) < 1, results
    assert max(results['darkAgain']['rgb']) < 1, results
    assert min(results['white']['rgb']) > 5, results
    for name in ['redStage', 'redCursor']:
        assert results[name]['rgb'][0] > 5, results
        assert max(results[name]['rgb'][1:]) < 1, results
    assert not errors, errors
    print('Companion WebGL passed: lights off = black; white stage, red stage, and cursor point light affect the surface.')
    print(json.dumps(results))
    browser.close()
