"""Check that live BPM polling leaves the settings controls idle and stops on close.

python3 tests/browser/music_polling.py --base-url http://127.0.0.1:1420
"""
import argparse
import json
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:1420')
base = parser.parse_args().base_url.rstrip('/')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    errors = []
    polls = [0]
    page.on('pageerror', lambda error: errors.append(str(error)))
    def mock(route):
        body = {}
        if route.request.url.endswith('/music'):
            polls[0] += 1
            body = {'analysis': {'status': 'listening', 'locked': True, 'bpm': 120 + polls[0], 'confidence': .8, 'playing': True}}
        route.fulfill(status=200, content_type='application/json', body=json.dumps(body), headers={'Access-Control-Allow-Origin': '*'})
    page.route('http://127.0.0.1:8790/**', mock)
    page.goto(base + '/?settings')
    page.evaluate("""async () => {
      const {default: React} = await import('/node_modules/.vite/deps/react.js');
      const {default: {createRoot}} = await import('/node_modules/.vite/deps/react-dom_client.js');
      const {MusicSettingsPanel} = await import('/src/components/MusicSettingsPanel.tsx');
      const {DEFAULT_FIT, DEFAULT_MUSIC} = await import('/src/music-settings.ts');
      const host = document.createElement('div'); host.id = 'polling-check'; document.body.append(host);
      window.fitReads = 0;
      // Reading fit fields measures control rendering without depending on DOM
      // mutations (React may rerender without changing existing DOM nodes).
      const fit = new Proxy(DEFAULT_FIT, {get(target,key) { fitReads++; return target[key]; }});
      const noop = () => {};
      window.musicRoot = createRoot(host);
      musicRoot.render(React.createElement(MusicSettingsPanel, {fit, music:DEFAULT_MUSIC, enabled:true, onFitChange:noop, onMusicChange:noop, onEnabledChange:noop, onPreview:noop}));
    }""")
    page.locator('#polling-check input[aria-label="Overall scale"]').wait_for()
    reads = page.evaluate('fitReads')
    assert reads > 0
    page.wait_for_function("Number(document.querySelector('#polling-check .music-bpm-value strong')?.textContent) >= 124")
    assert polls[0] >= 4
    assert page.evaluate('fitReads') == reads, 'BPM polling rerendered headphone fitting controls'
    page.evaluate('musicRoot.unmount()')
    after = polls[0]
    page.wait_for_timeout(800)
    assert polls[0] == after, 'Music polling continued after unmount'
    assert not errors, errors
    print('Music polling passed: live readout advances, fitting controls stay idle, polling stops on unmount.')
    browser.close()
