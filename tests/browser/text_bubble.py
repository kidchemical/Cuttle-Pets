"""Text reveal regression: display-clock batching, speed changes, instant mode,
Unicode graphemes, SSE lifetime and cancellation. All server calls are mocked.

python3 tests/browser/text_bubble.py --base-url http://127.0.0.1:1420
"""
import argparse
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:1420')
base = parser.parse_args().base_url.rstrip('/')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.route('http://127.0.0.1:8790/**', lambda r: r.fulfill(
        status=200, content_type='application/json', body='{}', headers={'Access-Control-Allow-Origin': '*'}))
    page.goto(base + '/?settings')
    page.evaluate("""async () => {
      const {default: React} = await import('/node_modules/.vite/deps/react.js');
      const {default: {createRoot}} = await import('/node_modules/.vite/deps/react-dom_client.js');
      const {TextBubble} = await import('/src/components/TextBubble.tsx');
      const {DEFAULT_BUBBLE_SETTINGS, normalizeBubbleSettings} = await import('/src/bubble-settings.ts');
      if(normalizeBubbleSettings({textSpeed: Infinity}).textSpeed !== 1 || normalizeBubbleSettings({textSpeed: -1}).textSpeed !== 0 || normalizeBubbleSettings({textSpeed: 99}).textSpeed !== 8) throw Error('Invalid speed normalization');
      window.streams = [];
      window.EventSource = class { constructor() { streams.push(this); } close() { this.closed = true; } };
      const host = document.createElement('div'); host.id='bubble-test'; host.style.cssText='position:fixed;inset:0;z-index:10000'; document.body.append(host);
      window.bubbleRoot = createRoot(host);
      window.messages = [];
      function Harness() {
        const [speed, setSpeed] = React.useState(.25); window.setSpeed = setSpeed;
        return React.createElement(TextBubble, {ttsEnabled:false, bubble:{...DEFAULT_BUBBLE_SETTINGS, textSpeed:speed}, onMessage:m=>messages.push(m)});
      }
      bubbleRoot.render(React.createElement(Harness));
    }""")
    page.wait_for_function('Boolean(window.__clawPreviewBubble && window.setSpeed)')
    sample = 'Unicode 👩🏽‍💻 é — ' * 80
    page.evaluate('(text) => __clawPreviewBubble(text)', sample)
    page.wait_for_timeout(200)
    slow = page.locator('#bubble-test').text_content()
    assert 1 <= len(slow) < 30, len(slow)
    page.evaluate('setSpeed(4)')
    page.wait_for_timeout(200)
    fast = page.locator('#bubble-test').text_content()
    assert len(fast) > len(slow) + 60, (len(slow), len(fast))
    page.evaluate('setSpeed(0)')
    page.wait_for_function('(sample) => document.querySelector("#bubble-test").textContent === sample', arg=sample)
    assert page.locator('#bubble-test span').evaluate_all("nodes => nodes.every(n => getComputedStyle(n).animationName === 'none')")
    page.evaluate("streams[0].onmessage({data:JSON.stringify({clearText:true})})")
    page.wait_for_function('document.querySelector("#bubble-test").textContent === ""')
    page.evaluate('setSpeed(.25)')
    page.wait_for_timeout(50)
    page.evaluate('(text) => __clawPreviewBubble(text)', sample)
    page.wait_for_timeout(80)
    page.evaluate("streams[0].onmessage({data:JSON.stringify({clearText:true})})")
    page.wait_for_timeout(200)
    assert page.locator('#bubble-test').text_content() == ''
    assert page.evaluate('streams.length') == 1, 'Changing speed must not reconnect SSE'
    page.evaluate('bubbleRoot.unmount()')
    assert page.evaluate('streams[0].closed && !window.__clawPreviewBubble')
    assert not errors, errors
    browser.close()
    print('Text bubble passed: batched reveal, live speed, Instant, Unicode, cancellation and stable SSE.')
