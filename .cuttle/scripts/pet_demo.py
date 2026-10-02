import json
import os
import sys
import urllib.request

params = json.loads(os.environ.get('CUTTLE_ACTION_PARAMS_JSON', '{}'))
sequence = params.get('sequence', 'stop')
url = os.environ.get('CUTTLE_PET_SERVER', 'http://127.0.0.1:8790').rstrip('/')
try:
    req = urllib.request.Request(url + '/demo', data=json.dumps({'sequence': sequence}).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as response:
        result = json.load(response)
    if not result.get('ok') or not result.get('delivered'):
        raise RuntimeError('No pet window connected. Launch it with bash start_pet.sh.')
    print(json.dumps(result))
except Exception as exc:
    print(f'Pet demo failed: {exc}', file=sys.stderr)
    sys.exit(1)
