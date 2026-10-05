"""Browser timer regression: behavior changes must not unmount the pet.

Run against Vite: python3 tests/browser/behavior_lifecycle.py --base-url http://127.0.0.1:1431
Uses real browser timers and a fake scene; no GPU or pet-server connection.
"""
import argparse
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:1431')
base = parser.parse_args().base_url.rstrip('/')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--disable-gpu'])
    page = browser.new_page()
    page.route(base + '/', lambda route: route.fulfill(content_type='text/html', body='<html><body></body></html>'))
    page.goto(base + '/')
    result = page.evaluate("""async () => {
      const {BehaviorEngine} = await import('/src/behavior-engine.ts');
      const {defaultBehaviorProfile} = await import('/src/behavior.ts');
      const calls = [], states = [];
      const scene = {
        resetPose() {}, setWorking() {}, setMusicPreview() {},
        playDanceOnce(name) { calls.push(name); },
        playDance() {}, playAnimationOnce() {}, playActionLoop() {},
        requestCoffeeSip() {}, startSipLoop() {}, pulseProcedural() {},
        setEmotionWithReset() {}, isBusy() { return false; }, isLooping() { return false; }
      };
      const profile = defaultBehaviorProfile();
      profile.states.music.end = [];
      profile.states.music.occasionals = [{animation:'behavior:dancing', everyMin:.01, everyMax:.01, chance:1}];
      profile.states.dancing.mains = [{animation:'dance:ualDance', weight:1}];
      const engine = new BehaviorEngine(s => states.push(s.state));
      const input = {enabled:true, paused:false, state:'idle', profile, scene};
      const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
      engine.update(input); await tick(0);
      // This cancelled a native timer with a non-Window receiver and threw
      // "Illegal invocation", taking React's entire App tree with it.
      engine.update({...input, state:'music'}); await tick(100);
      if (!calls.length || !states.includes('dancing') || states.at(-1) !== 'music')
        throw new Error('Music must invoke Dancing once and return');
      engine.update({...input, state:'working'}); await tick(0);
      engine.previewEntry({animation:'dance:ualDance'}, false); await tick(0);
      engine.update({...input, state:'music'}); await tick(0);
      engine.dispose();
      const count = calls.length; await tick(50);
      if (calls.length !== count || states.at(-1) !== null)
        throw new Error('Disposal must cancel all pending native timers');
      return {dances: count};
    }""")
    browser.close()
    print('Browser behavior lifecycle passed: native timer cancellation, Music → Dancing → Music, state changes, preview, and disposal.', result)
