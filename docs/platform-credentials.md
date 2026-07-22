# Production platform credential activation

The verifier uses official platform APIs where access has been granted. A platform without valid credentials is reported as unavailable or requiring review; it is never represented by generated catalogue data or a fabricated absence result.

Configure credentials only through the deployment secret manager:

| Platform | Required configuration |
| --- | --- |
| Spotify | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` |
| YouTube | `YOUTUBE_API_KEY` with YouTube Data API v3 enabled and quota controls |
| Audiomack | `AUDIOMACK_CONSUMER_KEY`, `AUDIOMACK_CONSUMER_SECRET`, exact `AUDIOMACK_PROFILE_URL` |
| SoundCloud | `SOUNDCLOUD_CLIENT_ID`, `SOUNDCLOUD_CLIENT_SECRET`, exact `SOUNDCLOUD_PROFILE_URL` |
| TIDAL | `TIDAL_CLIENT_ID`, `TIDAL_CLIENT_SECRET`, exact `TIDAL_PROFILE_URL` |

Deezer and Apple catalogue reads use their public catalogue endpoints. Their availability and response semantics must still be verified during release acceptance.

Run the credential acceptance harness against an authorized artist and known released track:

```bash
npm run accept:credentials
```

The harness additionally verifies a real Keycloak bearer token issued through Google federation. It performs actual catalogue lookups, fails on missing configuration or degraded credentials, redacts secrets from errors, and emits no bearer token or customer email.

Required acceptance inputs are documented by the command itself. Use environment variables or an approved ephemeral secret injection mechanism; never place credentials on a shared command line, in source control, or in an evidence report.

For platforms without an approved official catalogue API, the product produces manual-review work. Optional web verification must be separately approved, rate-limited, attributable, and compliant with the target service. Proxy rotation, CAPTCHA bypass, and access-control evasion are prohibited.
