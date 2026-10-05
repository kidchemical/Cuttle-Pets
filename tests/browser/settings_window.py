"""Standalone browser smoke test; run against Vite with all pet API calls mocked.

python tests/browser/settings_window.py --base-url http://127.0.0.1:1431
Requires Playwright plus its Chromium browser. Screenshots go under temp/.
"""
import argparse
from pathlib import Path
import json
from playwright.sync_api import sync_playwright
parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:1431')
base_url = parser.parse_args().base_url.rstrip('/')
scratch = Path(__file__).resolve().parents[2] / 'temp'
scratch.mkdir(exist_ok=True)
saved = {}
music_analysis = {'status': 'listening', 'bpm': None, 'candidate_bpm': 118.4, 'confidence': .22, 'playing': True}
def mock(route):
    path = route.request.url.split(':8790')[-1]
    if path == '/settings':
        if route.request.method == 'POST': saved.update(route.request.post_data_json)
        body = saved
    elif path == '/model/list': body = {'models': [{'name': 'Example.vrm', 'url': '/model/serve/Example.vrm'}]}
    elif path == '/music': body = {'analysis': music_analysis}
    elif path == '/cuttle/connection': body = {'ok': True, 'state': 'disconnected'}
    elif path == '/dance/list': body = {'dances': [{'name': 'Test imported dance.vmd', 'url': '/dance/serve/Test imported dance.vmd'}]}
    else: body = {}
    route.fulfill(status=200, content_type='application/json', body=json.dumps(body), headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type'})
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 760, 'height': 800})
    context.route('http://127.0.0.1:8790/**', mock)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(f'{base_url}/?settings')
    page.get_by_role('button', name='Animations', exact=True).click()
    page.get_by_role('option', name='Test imported dance').wait_for()
    page.get_by_text('Now: Connecting to pet…', exact=True).wait_for()
    assert page.locator('canvas').count() == 0
    assert page.get_by_role('button', name='Close settings', exact=True).count() == 0
    peer = context.new_page()
    peer.goto(f'{base_url}/?settings')
    peer.evaluate("""() => { window.commands=[]; window.bus = new BroadcastChannel('cuttle-pet-windows'); bus.onmessage = e => { if (e.data.name==='pet-command') { commands.push(e.data.payload); if(e.data.payload.type==='status') bus.postMessage({name:'pet-status',payload:{state:'music',actionId:null,danceId:null,working:false,sipping:false}}); if(e.data.payload.type==='screenshot') bus.postMessage({name:'pet-screenshot',payload:{request:e.data.payload.request,image:'data:image/png;base64,test'}}) } } }""")
    # A newly opened settings window requests the existing state, even if the
    # pet has not changed animation since opening the first window.
    page.reload()
    page.get_by_role('button', name='Animations', exact=True).click()
    peer.wait_for_function("commands.some(c => c.type==='status')")
    page.get_by_text('Now: Listening to music', exact=True).wait_for()
    status = page.locator('div[role="status"]').filter(has_text='Now:')
    assert status.count() == 1
    assert status.bounding_box()['y'] < page.get_by_text('Imported Motion', exact=True).bounding_box()['y']
    page.get_by_role('button', name='Behavior', exact=True).click()
    enabled = page.get_by_role('checkbox', name='Behavior engine enabled', exact=False)
    assert page.get_by_role('button', name='Save profile', exact=True).bounding_box()['y'] < enabled.bounding_box()['y']
    with page.expect_response(lambda r: r.url.endswith('/settings') and r.request.method == 'POST'):
        page.get_by_label('Animation or behavior', exact=True).select_option('behavior:dancing')
    assert saved['behaviorSettings']['current']['states']['idle']['mains'][0]['animation'] == 'behavior:dancing'
    page.get_by_role('button', name='Preview once', exact=True).click()
    peer.wait_for_function("commands.some(c => c.type==='animation' && c.id==='behavior:dancing' && c.mode==='once')")
    page.get_by_role('button', name='Stop preview', exact=True).click()
    peer.wait_for_function("commands.some(c => c.type==='stop')")
    page.get_by_role('button', name='Reset to default', exact=True).click()
    peer.evaluate("""() => bus.postMessage({name:'pet-status',payload:{state:'music',actionId:'idle',danceId:null,working:false,sipping:false,musicMotion:true,behaviorEntries:[{state:'music',phase:'mains',index:0}]}})""")
    main = page.locator('[data-entry="music:mains:0"]')
    page.wait_for_function("document.querySelector('[data-entry=\"music:mains:0\"]')?.dataset.active === 'true'")
    assert main.get_attribute('aria-selected') == 'false', 'Playback is distinct from editor selection'
    assert 'Playing' in main.inner_text()
    page.get_by_role('button', name='Animations', exact=True).click()
    music = page.locator('[data-animation="music"]')
    page.wait_for_function("document.querySelector('[data-animation=\"music\"]')?.dataset.active === 'true'")
    assert page.locator('[data-animation="idle"]').get_attribute('data-active') == 'false'
    music.scroll_into_view_if_needed()
    # Static highlight: no infinite repaint animations (a second webview
    # animating on a timer competes with the pet renderer for the GPU).
    assert music.evaluate("e => getComputedStyle(e).animationName") == 'none'
    page.screenshot(path=str(scratch / 'animation-playing.png'))
    page.emulate_media(reduced_motion='reduce')
    assert music.evaluate("e => getComputedStyle(e).animationName") == 'none'
    assert 'Playing' in music.inner_text()
    page.emulate_media(reduced_motion='no-preference')
    peer.evaluate("""() => bus.postMessage({name:'pet-status',payload:{state:'dancing',actionId:null,danceId:'dance:jile',working:false,sipping:false,musicMotion:false,behaviorEntries:[{state:'music',phase:'occasionals',index:0},{state:'dancing',phase:'mains',index:0}]}})""")
    page.wait_for_function("document.querySelector('[data-animation=\"dance:jile\"]')?.dataset.active === 'true'")
    assert music.get_attribute('data-active') == 'false'
    page.get_by_role('button', name='Behavior', exact=True).click()
    page.wait_for_function("document.querySelector('[data-entry=\"music:occasionals:0\"]')?.dataset.active === 'true'")
    assert page.locator('.live-entry[data-active="true"]').count() == 2
    assert page.locator('[data-entry="dancing:mains:0"]').get_attribute('data-active') == 'true'
    assert page.locator('[data-entry="idle:mains:0"]').get_attribute('data-active') == 'false'
    page.locator('[data-entry="music:occasionals:0"]').scroll_into_view_if_needed()
    page.screenshot(path=str(scratch / 'behavior-playing.png'))
    page.get_by_role('button', name='Add rocket-launch example', exact=True).click()
    peer.evaluate("""() => bus.postMessage({name:'pet-status',payload:{state:'idle',actionId:'action:cheering',danceId:null,working:false,sipping:false,behaviorEntries:[],reaction:{id:'rocket-launch',index:1}}})""")
    page.wait_for_function("document.querySelector('[data-reaction-step=\"rocket-launch:1\"]')?.dataset.active === 'true'")
    assert page.locator('.live-entry[data-active="true"]').count() == 1

    page.get_by_role('button', name='Animations', exact=True).click()
    page.get_by_label('Global animation speed', exact=True).fill('2')
    page.get_by_role('option', name='Happy', exact=False).click()
    page.get_by_label('Individual speed', exact=True).fill('0.5')
    page.get_by_text('Effective speed: 1.00×').wait_for()
    page.get_by_role('button', name='Preview on pet', exact=True).click()
    peer.wait_for_function("commands.some(c => c.type==='animation' && c.id==='action:happy')")
    peer.get_by_role('button', name='Animations', exact=True).click()
    assert peer.get_by_label('Global animation speed', exact=True).input_value() == '2'
    page.reload()
    page.get_by_role('button', name='Animations', exact=True).click()
    assert page.get_by_label('Global animation speed', exact=True).input_value() == '2'
    page.get_by_role('option', name='Happy', exact=False).click()
    assert page.get_by_label('Individual speed', exact=True).input_value() == '0.5'
    page.screenshot(path=str(scratch / 'animation-settings.png'))
    page.get_by_role('button', name='Reset this animation', exact=True).click()
    assert page.get_by_label('Individual speed', exact=True).input_value() == '1'
    page.get_by_role('button', name='Reset all animations', exact=True).click()
    assert page.get_by_label('Global animation speed', exact=True).input_value() == '1'
    page.get_by_role('button', name='Quality', exact=True).click()
    page.get_by_label('Frame rate limit').select_option('120')
    page.get_by_role('button', name='Low', exact=True).click()
    assert page.get_by_label('Frame rate limit').input_value() == '120'
    page.reload()
    page.get_by_role('button', name='Quality', exact=True).click()
    assert page.get_by_label('Frame rate limit').input_value() == '120'
    page.get_by_role('button', name='Model', exact=True).click()
    page.get_by_label('Custom VRM models').wait_for()
    assert page.get_by_label('Built-in VRM models').evaluate("e => getComputedStyle(e).colorScheme") == 'dark'
    option = page.get_by_label('Custom VRM models').locator('option').last
    assert option.evaluate("e => getComputedStyle(e).backgroundColor") == 'rgb(32, 40, 56)'
    assert option.evaluate("e => getComputedStyle(e).color") == 'rgb(237, 242, 251)'
    page.screenshot(path=str(scratch / 'settings-model.png'))
    page.get_by_role('button', name='Music', exact=True).click()
    page.locator('.music-bpm-card[data-state="calculating"]').wait_for()
    assert page.locator('.music-bpm-value strong').inner_text() == '118'
    assert page.locator('.music-bpm-value').evaluate('e => getComputedStyle(e).color') == 'rgb(243, 212, 119)'
    assert page.locator('.music-bpm-value strong').evaluate('e => parseFloat(getComputedStyle(e).fontSize)') >= 44
    assert page.get_by_role('region', name='BPM analysis').bounding_box()['y'] < page.get_by_role('region', name='Headphone fit', exact=True).bounding_box()['y']
    page.locator('.settings-content').evaluate('e => e.scrollTop = 0')
    page.screenshot(path=str(scratch / 'music-calculating.png'))
    music_analysis.update(bpm=120, locked=True, confidence=.85)
    page.locator('.music-bpm-card[data-state="locked"]').wait_for()
    assert page.locator('.music-bpm-value strong').inner_text() == '120'
    assert page.locator('.music-bpm-value').evaluate('e => getComputedStyle(e).color') == 'rgb(114, 227, 161)'
    page.screenshot(path=str(scratch / 'music-locked.png'))
    music_analysis.update(bpm=None, candidate_bpm=None, locked=False, confidence=.1)
    page.locator('.music-bpm-card[data-state="calculating"]').wait_for()
    assert page.locator('.music-bpm-value strong').inner_text() == '120'
    page.get_by_text('Last estimate · still checking the rhythm.', exact=True).wait_for()
    page.get_by_role('checkbox', name='Preview headphones and nodding without music').check()
    peer.wait_for_function("commands.filter(c=>c.type==='music-preview').at(-1)?.active === true")
    with page.expect_response(lambda r: r.url.endswith('/settings') and r.request.method == 'POST'):
        page.get_by_role('slider', name='Overall scale', exact=True).fill('1.2')
    assert peer.evaluate("commands.filter(c=>c.type==='music-preview').at(-1).active") is True
    for tab in ['General','Music','Cuttle','Voice','Model','Persona','Behavior','Quality','Display']:
        page.get_by_role('button', name=tab, exact=True).click()
    page.get_by_role('button', name='Persona', exact=True).click()
    page.get_by_role('button', name='Auto Generate', exact=True).click()
    peer.wait_for_function("commands.some(c => c.type==='screenshot')")
    page.set_viewport_size({'width': 480, 'height': 500})
    for tab in ['General','Music','Cuttle','Voice','Model','Persona','Behavior','Quality','Display','Animations']:
        page.get_by_role('button', name=tab, exact=True).click()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), tab
        assert page.locator('.settings-content').evaluate('e => e.scrollWidth <= e.clientWidth'), tab
    page.screenshot(path=str(scratch / 'animation-settings-small.png'))
    assert not errors, errors
    print('Browser checks passed: standalone settings, imported list, immediate state request, behavior assignments, live sync, preview routing, reload persistence, reset, all tabs, small window, no page errors.')
    browser.close()
