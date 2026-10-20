# dsh-relay

[English](README.md) | [Polski](README.pl.md) | [简体中文](README.zh-CN.md)

> **Projekt społecznościowy:** to nieoficjalny projekt, niezależnie rozwijany i utrzymywany przez społeczność. Nie jest weryfikowany, rekomendowany ani wspierany przez DeepSeek.

Chmurowy Relay dla MVP zdalnego sterowania DSH z telefonu.

Publiczny endpoint produkcyjny: `https://relay.dshmobile.online`

## Dostęp przez przeglądarkę

Katalog główny Relay przekierowuje do `/app/`, czyli mobilnego klienta WWW do logowania, parowania, wyboru komputera i oryginalnego interfejsu DSH Web. Klient implementuje `sealed-tunnel-v1` z użyciem Web Crypto. Klucze urządzeń pozostają w IndexedDB przeglądarki oraz w pamięci aktywnego Service Workera; Relay nadal widzi wyłącznie metadane routingu, rozmiary szyfrogramów i charakterystykę czasową.

Nowe kody QR Companion są odnośnikami HTTPS w postaci `https://<relay>/app/#/pair?code=...&key=...`. Aparat iPhone'a może otworzyć je bezpośrednio, a fragmenty adresu URL nie są wysyłane do Relay. Wdrożenie produkcyjne wymaga HTTPS oraz `PUBLIC_RELAY_URL=https://twoj-relay.example` i `ALLOW_LEGACY_WEB_PROXY=0`.

### Język interfejsu

Klient przeglądarkowy Relay, panel administracyjny i strona zakończonej sesji obsługują angielski, polski i chiński uproszczony. Selektor języka z etykietą jest dostępny przed logowaniem i zmienia interfejs bez odświeżania ani usuwania fragmentu linku parowania. Kolejność wyboru to: zapisana obsługiwana preferencja `dsh-relay-language`, pierwszy obsługiwany wpis `navigator.languages` (lub `navigator.language`), a następnie angielski. Dopasowywane są rodziny `en`, `pl` i `zh`; pozostałe języki używają angielskiego. Gdy pamięć przeglądarki jest niedostępna, zmiana nadal działa na bieżącej stronie. Nazwy komputerów, zdalna zawartość DSH i informacje o wydaniu dostarczane przez serwer nie są tłumaczone.

Lokalizacja używa zewnętrznego skryptu `/app/i18n.js` z tego samego źródła przy zachowaniu obecnej CSP. Service Worker importuje ten sam katalog dla własnych błędów i zachowuje język prezentacji w metadanych wznawianego tunelu; język nigdy nie trafia do kopert tunelu ani żądań uwierzytelniania. Zasoby strony odzyskiwania Relay omijają zdalne przekazywanie. Nie dodano buforowania poświadczeń, kluczy ani odszyfrowanej treści w Cache API. Komunikaty walidacji i uprawnień generowane przez przeglądarkę używają języka przeglądarki lub systemu. Nadal obowiązują wymagania HTTPS, Service Worker, Web Crypto, WebSocket, uprawnień aparatu oraz ograniczenia działania w tle; zmiana języka nie zmienia możliwości przeglądarki.

## Administracja

`/admin/` jest wyłączone, dopóki oba poświadczenia nie zostaną skonfigurowane jako sekrety wdrożenia:

```bash
ADMIN_USERNAME=relay-admin
ADMIN_PASSWORD=a-unique-password-from-your-password-manager
```

Odizolowana sesja administratora HttpOnly udostępnia wyłącznie agregaty kont, urządzeń i sesji dostępu. Nigdy nie ujawnia ścieżek DSH, treści zadań, treści HTTP, ramek WebSocket, adresów IP, tokenów ani kluczy szyfrowania.

## Uruchomienie lokalne

```bash
cp .env.example .env
npm install
npm run build
npm start
```

Domyślny nasłuch to `http://127.0.0.1:8787`. W środowisku produkcyjnym ustaw `DATABASE_PATH` na trwałą lokalizację. Relay oczekuje HTTPS/WSS w każdym wdrożeniu publicznym i przekazuje zaszyfrowane ramki tunelu 0.1.9 bez dostępu do tekstu jawnego DSH.

## Wydania

Każdy pull request i push gałęzi instaluje zablokowane zależności, buduje, testuje i audytuje Relay w GitHub Actions. Tag dokładnie zgodny z wersją w `package.json` i `package-lock.json` (na przykład `v0.1.9`) automatycznie tworzy wydanie GitHub Releases.

Każde wydanie zawiera archiwa `.tar.gz` i `.zip` ze skompilowanym katalogiem `dist/`, plikami wdrożeniowymi i manifestami zależności produkcyjnych oraz `SHA256SUMS`. Ten sam proces publikuje `ghcr.io/april-jk/dsh-relay:<version>` i `:latest`. Tylko najwyższy stabilny tag SemVer może zaktualizować `latest`; istniejących obrazów wersji i plików wydania nie wolno zastępować inną treścią. Po rozpakowaniu archiwum uruchom `npm ci --omit=dev` przed `npm start`; zależności natywne są instalowane dla platformy docelowej, a nie dołączane z CI.

## Railway

Utwórz usługę Railway z tego katalogu, ustaw `JWT_SECRET` na losową wartość o długości co najmniej 32 bajtów i podłącz trwały wolumen zamontowany w `/data`. Uruchomienie produkcyjne kończy się błędem, gdy ten sekret jest nieobecny, zbyt krótki lub nadal ustawiony na udokumentowaną wartość zastępczą. Ustaw `DATABASE_PATH=/data/relay.sqlite`. Dodaj własną domenę HTTPS, na przykład `relay.dshmobile.online`, i używaj jej jako adresu bazowego Relay w aplikacji mobilnej i Companion. Companion automatycznie zamienia adres Relay `https://` na `wss://` dla połączenia urządzenia.

Ustaw `TRUST_PROXY=1` w Railway, aby ograniczanie szybkości korzystało z pierwszego adresu przekazanego przez zaufane proxy Railway. Pozostaw tę opcję wyłączoną, gdy proces Node jest wystawiony bezpośrednio.

Ustaw `PUBLIC_RELAY_URL=https://relay.dshmobile.online`, aby odpowiedzi z biletem zwracały kanoniczny tunel klienta `wss://`. W produkcji utrzymuj `ALLOW_LEGACY_WEB_PROXY=0`; włączenie tej opcji ponownie otwiera przestarzałe proxy tekstu jawnego `/s` wyłącznie do lokalnych testów migracji.

MVP jest celowo jednoinstancyjny. Do czasu wprowadzenia wspólnego magazynu wymagane są trwałość wolumenu SQLite i jedna replika Relay.

## Prywatne wdrożenie z Dockerem

```bash
cp .env.example .env
```

Ustaw losowy `JWT_SECRET` o długości co najmniej 32 bajtów, a następnie uruchom jednoinstancyjny Relay:

```bash
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

Umieść odwrotne proxy HTTPS przed portem `8787`. Pozostaw `TRUST_PROXY=0`, chyba że proxy nadpisuje nagłówki przekazywania klienta. Wolumen `relay-data` zawiera stan SQLite i wymaga kopii zapasowych. W aplikacji mobilnej wybierz **Serwer Relay** i wpisz publiczny adres HTTPS; uruchom DSH z tym samym adresem w `DSH_RELAY`.

## Limity zasobów

Relay ogranicza liczbę bezpiecznych sesji, bajty szyfrogramów, szybkość ramek, czas uzgadniania i czas bezczynności. Domyślne wartości są odpowiednie dla wdrożenia MVP i można je zmieniać zmiennymi środowiskowymi:

| Zmienna | Domyślnie | Zakres |
| --- | ---: | --- |
| `MAX_API_BODY_BYTES` | 65,536 | Treść żądania JSON API |
| `MAX_WS_PAYLOAD_BYTES` | 4,194,304 | Jedna przychodząca ramka WebSocket |
| `API_RATE_LIMIT_PER_MINUTE` | 300 | Żądania API na adres klienta |
| `AUTH_RATE_LIMIT_PER_MINUTE` | 20 | Dodatkowy limit uwierzytelniania na adres klienta |
| `PAIR_RATE_LIMIT_PER_MINUTE` | 30 | Dodatkowy limit parowania na adres klienta |
| `WS_UPGRADE_RATE_LIMIT_PER_MINUTE` | 120 | Aktualizacje WebSocket na adres klienta |
| `MAX_SECURE_TUNNELS_GLOBAL` | 512 | Równoczesne sesje sealed na instancję Relay |
| `MAX_SECURE_TUNNELS_PER_DEVICE` | 8 | Równoczesne sesje sealed na komputer |
| `MAX_SECURE_TUNNEL_BYTES` | 536,870,912 | Łączne bajty szyfrogramu na sesję |
| `SECURE_FRAME_RATE_LIMIT_PER_MINUTE` | 2,400 | Ramki sealed na sesję dostępu |
| `SECURE_TUNNEL_IDLE_TIMEOUT_MS` | 300,000 | Limit bezczynności sesji sealed |
| `SECURE_HANDSHAKE_TIMEOUT_MS` | 10,000 | Limit czasu uzgadniania E2EE |

Poniższe limity dotyczą wyłącznie przestarzałego proxy tekstu jawnego, jawnie włączonego przez `ALLOW_LEGACY_WEB_PROXY=1`:

| Zmienna | Domyślnie | Zakres |
| --- | ---: | --- |
| `TUNNEL_RATE_LIMIT_PER_MINUTE` | 600 | Przekazywane żądania HTTP na adres klienta |
| `MAX_TUNNEL_BODY_BYTES` | 2,097,152 | Jedno przestarzałe żądanie HTTP |
| `MAX_TUNNEL_RESPONSE_BYTES` | 33,554,432 | Jedna przestarzała odpowiedź HTTP |
| `MAX_PENDING_HTTP_PER_DEVICE` | 32 | Przestarzałe równoczesne tunele HTTP na komputer |
| `MAX_TUNNEL_WS_PER_DEVICE` | 16 | Przestarzałe równoczesne tunele WebSocket na komputer |
| `MAX_PENDING_HTTP_GLOBAL` | 512 | Przestarzałe równoczesne tunele HTTP na instancję Relay |
| `MAX_TUNNEL_WS_GLOBAL` | 256 | Przestarzałe równoczesne tunele WebSocket na instancję Relay |

Liczniki szybkości są celowo lokalne dla instancji, zgodnie z jednoinstancyjną architekturą MVP. Wygasłe tokeny odświeżania, sesje parowania, sesje dostępu i zdarzenia są usuwane przy starcie oraz co 15 minut.

## Polityka wydań aplikacji mobilnej

Publiczny endpoint `GET /app/version?platform=android|ios` steruje monitami o aktualizację w aplikacji mobilnej. Skonfiguruj każdą platformę niezależnie:

```bash
APP_ANDROID_LATEST_VERSION=0.2.0
APP_ANDROID_MINIMUM_VERSION=0.1.3
APP_ANDROID_DOWNLOAD_URL=https://play.google.com/store/apps/details?id=io.github.apriljk.dshremote
APP_ANDROID_RELEASE_NOTES=Improved remote session stability.
APP_IOS_LATEST_VERSION=0.2.0
APP_IOS_MINIMUM_VERSION=0.1.3
APP_IOS_DOWNLOAD_URL=https://apps.apple.com/app/id0000000000
APP_IOS_RELEASE_NOTES=Improved remote session stability.
```

Podnieś `LATEST_VERSION`, aby wyświetlić monit z możliwością odrzucenia. Podnoś `MINIMUM_VERSION` tylko wtedy, gdy starsze wersje muszą zostać zablokowane. Przed podniesieniem którejkolwiek wersji zawsze skonfiguruj prawidłowy adres pobierania dla platformy.

## Licencja

[MIT](LICENSE)
