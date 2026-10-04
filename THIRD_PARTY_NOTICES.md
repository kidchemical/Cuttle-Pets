# Third-party notices

Cuttle Pets' own code is licensed under MIT; dependencies and assets retain
their own licenses. Preserve their copyright notices, conditions, and disclaimers
when redistributing them. Replacing a dependency in the future does not remove
notice obligations for copies that still contain it.

## Audio analysis and Windows capture

- **NumPy** — BSD-3-Clause, NumPy Developers. Numerical arrays, FFT, and
  autocorrelation primitives; the streaming detector is Cuttle Pets code.
  [License](docs/third-party/numpy.txt), [project](https://numpy.org).
- **SoundCard** — BSD-3-Clause, copyright 2016 Bastian Bechtold. Windows WASAPI
  output-loopback capture only.
  [License](docs/third-party/soundcard.txt), [project](https://github.com/bastibe/SoundCard).
- **CFFI** — MIT, copyright Armin Rigo, Maciej Fijalkowski and others.
  SoundCard's native-library interface dependency.
  [License](docs/third-party/cffi.txt), [project](https://github.com/python-cffi/cffi).
- **pycparser** — BSD-3-Clause, copyright Eli Bendersky.
  CFFI's parser dependency where installed.
  [License](docs/third-party/pycparser.txt), [project](https://github.com/eliben/pycparser).

The checked-in notices cover these projects' source licenses. Python wheels can
also bundle additional libraries (for example BLAS implementations in NumPy).
When packaging a release, preserve the complete licenses shipped with the exact
wheels being distributed, including their bundled-library notices. A source
license list alone is not a substitute for the wheel's license files.

## Existing renderer and assets

The renderer is derived from claw-sama (MIT). Its original attribution remains
in [app/UPSTREAM-LICENSE.txt](app/UPSTREAM-LICENSE.txt).
Models, animations and props retain the separate terms documented in
[docs/ASSET_LICENSES.md](docs/ASSET_LICENSES.md). Other existing renderer/Python
dependencies retain the notices distributed with their packages.
