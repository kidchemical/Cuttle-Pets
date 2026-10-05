"""Settings imports with native Tauri event mocks; no user files are written.
Run against Vite: python3 tests/browser/settings_imports.py --base-url http://127.0.0.1:1420
Actual OS drag delivery/focus still require a native desktop interaction check.
"""
import argparse
import json
import struct
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:1420')
base = parser.parse_args().base_url.rstrip('/')
saved, calls = {}, []
model_json = json.dumps({'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'name': 'Example'}]}).encode()
model_json += b' ' * (-len(model_json) % 4)
glb = struct.pack('<III', 0x46546C67, 2, 20 + len(model_json)) + struct.pack('<II', len(model_json), 0x4E4F534A) + model_json

def mock(route):
    path = route.request.url.split(':8790')[-1]
    body = {}
    if path == '/settings':
        if route.request.method == 'POST': saved.update(route.request.post_data_json)
        body = saved
    elif path.endswith('/source.glb'):
        route.fulfill(body=glb, content_type='model/gltf-binary', headers={'Access-Control-Allow-Origin': '*'})
        return
    elif path.endswith('/stage'):
        calls.append((path, route.request.post_data_json))
        body = {'ok': True, 'token': 'mock', 'name': 'Example', 'format': 'glb', 'url': path.replace('/stage', '/source.glb')}
    elif path.endswith('/commit'):
        body = {'ok': True, 'name': 'example.glb'}
    elif path in ('/model/import', '/dance/import'):
        calls.append((path, route.request.post_data_json))
        body = {'ok': True, 'url': '/model/serve/Example.vrm'}
    elif path == '/model/list': body = {'models': [{'name': 'Example.vrm', 'url': '/model/serve/Example.vrm'}]}
    elif path == '/dance/list': body = {'dances': []}
    route.fulfill(content_type='application/json', body=json.dumps(body), headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type'})

native = """(() => {
  window.isTauri = true;
  const callbacks = new Map(), listeners = new Map(); let next = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: {currentWindow:{label:'settings'}, currentWebview:{label:'settings'}},
    transformCallback: cb => { callbacks.set(++next, cb); return next; },
    invoke: async (cmd, args) => {
      if (cmd==='plugin:event|listen') { const id=++next; listeners.set(id,{...args}); return id; }
      if (cmd==='plugin:event|unlisten') { listeners.delete(args.eventId); return; }
      if (cmd==='pick_companion_file') return '/picked/example.glb';
      if (cmd==='pick_vrm_file') return '/picked/Example.vrm';
      if (cmd==='pick_dance_file') return '/picked/example.vmd';
      if (cmd==='pick_music_file') return null;
      return null;
    }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener:()=>{}};
  window.nativeDrop = (type, paths=[]) => {
    for (const [id,l] of listeners) if(l.event==='tauri://drag-'+type) callbacks.get(l.handler)({id,event:l.event,payload:{paths,position:{x:10,y:10}}});
  };
  window.dropListenerCount = () => [...listeners.values()].filter(l=>l.event==='tauri://drag-drop').length;
})();"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1100, 'height': 900})
    page.add_init_script(native)
    page.route('http://127.0.0.1:8790/**', mock)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base + '/?settings')

    def tab(name):
        page.get_by_role('button', name=name, exact=True).click()
        page.wait_for_function('dropListenerCount() === 1')

    def drop(paths):
        page.evaluate('(paths) => nativeDrop("drop", paths)', paths)

    tab('Pets')
    page.evaluate('nativeDrop("enter", ["/dropped/chao.glb"])')
    assert page.get_by_text('Drop a model anywhere', exact=False).evaluate('e => getComputedStyle(e).backgroundColor') == 'rgb(37, 66, 56)'
    drop(['/dropped/chao.glb'])
    page.get_by_role('article', name='Pet Example', exact=True).wait_for()
    assert calls[-1] == ('/assets/pets/stage', {'path': '/dropped/chao.glb'})
    page.get_by_label('Follow lag (higher is looser)').fill('1.2')
    page.wait_for_function("document.querySelector('input[aria-label=\"Follow lag (higher is looser)\"]').value === '1.2'")
    with page.expect_response(lambda r: r.url.endswith('/settings') and r.request.method == 'POST'):
        page.get_by_label('Lighting fill').fill('0.5')
    assert saved['petSettings']['pets'][0]['followLag'] == 1.2
    assert saved['petSettings']['pets'][0]['lighting'] == .5
    count = len(calls)
    drop(['/invalid/chao.txt'])
    page.get_by_text('Supported files: .glb, .gltf, .fbx, .dae', exact=True).wait_for()
    assert len(calls) == count

    tab('Props')
    drop(['/dropped/hat.glb'])
    page.get_by_role('article', name='Prop Example', exact=True).wait_for()
    assert calls[-1] == ('/assets/props/stage', {'path': '/dropped/hat.glb'})
    tab('Model')
    with page.expect_response(lambda r: r.url.endswith('/model/import')):
        drop(['/dropped/Character.vrm'])
    assert calls[-1] == ('/model/import', {'path': '/dropped/Character.vrm'})
    count = len(calls)
    drop(['/one.vrm', '/two.vrm'])
    page.get_by_role('alert').filter(has_text='Drop one model at a time.').wait_for()
    assert len(calls) == count
    tab('Animations')
    with page.expect_response(lambda r: r.url.endswith('/dance/list')):
        drop(['/dropped/dance.fbx', '/dropped/dance.mp3'])
    assert calls[-2:] == [('/dance/import', {'path':'/dropped/dance.fbx'}), ('/dance/import', {'path':'/dropped/dance.mp3'})]
    # Picker follows the same importer, and page changes remove listeners.
    with page.expect_response(lambda r: r.url.endswith('/dance/import')):
        page.get_by_role('button', name='Select motion file… (.vmd/.vrma/.fbx)', exact=True).click()
    assert calls[-1] == ('/dance/import', {'path':'/picked/example.vmd'})
    page.get_by_role('button', name='General', exact=True).click()
    page.wait_for_function('dropListenerCount() === 0')
    before = len(calls); drop(['/ignore.glb']); assert len(calls) == before
    assert not errors, errors
    Path('temp').mkdir(exist_ok=True)
    tab('Pets'); page.screenshot(path='temp/settings-pets-motion.png')
    browser.close()
print('Settings imports passed: native drop routing for Pets/Props/Model/Animations, hover feedback, settings persistence, validation, picker parity, listener cleanup.')
