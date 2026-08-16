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
