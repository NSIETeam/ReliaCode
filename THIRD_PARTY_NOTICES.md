# Third-party notices

## OpenEPCIS Community Edition

- Upstream: <https://github.com/openepcis/epcis-repository-ce>
- License: Apache License 2.0
- Intended use: GS1 EPCIS 2.0 capture and query repository, deployed as an
  external service.

ReliaCode does not currently vendor or modify OpenEPCIS source. If upstream
files are ever copied or changed here, retain its LICENSE, NOTICE, copyright,
and change notices as required by Apache-2.0.

## QR Code Generator for JavaScript

- Upstream: <https://github.com/kazuhikoarase/qrcode-generator>
- Version: 2.0.4
- Copyright: Copyright (c) 2009 Kazuhiko Arase
- License: MIT License
- Use: vendored browser distribution at `apps/scan-web/vendor/qrcode.js` to
  generate offline SVG QR-code labels.

The vendored source retains its upstream copyright and license header.

## jsQR

- Upstream: <https://github.com/cozmo/jsQR>
- Version: 1.4.0
- License: Apache License 2.0
- Use: browser camera-decoding fallback and automated scan verification for
  generated QR matrices. The vendored distribution and Apache-2.0 license are
  retained under `apps/scan-web/vendor/`.
