# Firefox installation and signing

Firefox Release and Beta reject unsigned XPI files. This is expected and cannot be disabled in normal release Firefox.

## Temporary installation

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select this project's `manifest.json` or the packaged ZIP/XPI. Temporary extensions are removed when Firefox restarts.

## Permanent installation

Mozilla must sign the extension even when it is distributed privately. Create API credentials at `https://addons.mozilla.org/developers/addon/api/key/`, install Mozilla's `web-ext` tool, and sign an unlisted build:

```bash
export AMO_JWT_ISSUER='user:…'
export AMO_JWT_SECRET='…'
web-ext sign --source-dir . --channel unlisted --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
```

Do not commit AMO credentials or send them in chat. Firefox Developer Edition, Nightly, and ESR can also allow unsigned installation after disabling `xpinstall.signatures.required`; Firefox Release and Beta cannot.
