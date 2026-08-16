# dsh-relay

Cloud Relay for the DSH mobile remote-control MVP.

## Local

```bash
cp .env.example .env
npm install
npm run build
npm start
```

The default listener is `http://127.0.0.1:8787`. Set `DATABASE_PATH` to a persistent location in production. The Relay expects HTTPS/WSS in any public deployment and never logs tunnel payloads.

## Railway

Create a Railway service from this directory, set `JWT_SECRET` to a long random value, and attach a persistent volume mounted at `/data`. Set `DATABASE_PATH=/data/relay.sqlite`. Railway's generated public domain must be used as the Relay base URL by the mobile app and Companion. The service must be behind Railway TLS; the Companion automatically converts an `https://` Relay URL to `wss://` for its device connection.

The MVP is intentionally single-instance. SQLite volume persistence and a single Relay replica are required until a shared store is introduced.

## Mobile release policy

The public `GET /app/version?platform=android|ios` endpoint drives update prompts in the mobile app. Configure each platform independently:

```bash
APP_ANDROID_LATEST_VERSION=0.2.0
APP_ANDROID_MINIMUM_VERSION=0.1.0
APP_ANDROID_DOWNLOAD_URL=https://play.google.com/store/apps/details?id=com.deepseek.dshremote
APP_ANDROID_RELEASE_NOTES=Improved remote session stability.
APP_IOS_LATEST_VERSION=0.2.0
APP_IOS_MINIMUM_VERSION=0.1.0
APP_IOS_DOWNLOAD_URL=https://apps.apple.com/app/id0000000000
APP_IOS_RELEASE_NOTES=Improved remote session stability.
```

Raise `LATEST_VERSION` for a dismissible prompt. Raise `MINIMUM_VERSION` only when older builds must be blocked. Always configure a valid platform download URL before raising either version.
