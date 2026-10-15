# Для розробки: як усе влаштовано

Цей файл написано, щоб будь-хто (людина або ШІ в новому чаті) міг продовжити роботу без попереднього контексту.

## Ідея

Інтерфейс журналу взято з сайту «Розбір ринку» (`static/journal/*`) **без змін логіки**. На сайті він говорить із сервером запитами
`JR.api.get("/journals/1/entries")`. Тут ці самі запити обробляє «локальний сервер» у браузері (`lib/jl-api.js`) над IndexedDB.
Тому інтерфейс (`js/jr-*.js`) майже збігається з сайтом, а правки сайту легко переносяться.

Відмінності від файлів сайту:
- `js/jr-core.js`: `JR.api = JL.api` замість `fetch`.
- `js/jr-entries.js`, `js/jr-review.js`: файли беруться з `m.url` (blob-адреса), а не `/api/journal/media/<id>`.
- `js/journal.js`: без входу/сайтової навігації, експорт CSV будується в браузері, підказка про резервну копію, оновлення екрана після змін із хмари.
- `js/jr-account.js` (новий): вікно «Дані й хмара».
- `index.html`, `manifest.webmanifest`, `sw.js`: власні, шляхи відносні (працює в підпапці GitHub Pages).

## Модулі `lib/` (порядок підключення в `index.html` важливий)

| Файл | Що робить | Відповідник на сайті (Python) |
|---|---|---|
| `jl-util.js` | `ApiError`, `pyRound` (округлення як у Python), `pySum` (сума як у Python 3.12+), `pyFloat` (`float()` як у Python), дати, ISO-тиждень, CSV читання/запис, CRC32, читання/запис ZIP, `sniff` (тип файла за вмістом), `safeFilename` | частини `journal.py`, `journal_stats.py` |
| `jl-schema.js` | ринки, типи полів, ліміти, `defaultFields`, `cleanFields`, `cleanEntry` | `journal.py` |
| `jl-stats.js` | `JL.stats.compute(entries, group, from, to)` | `journal_stats.py` |
| `jl-import.js` | розпізнавання колонок, CSV, Notion ZIP, `Converter` | `journal_import.py` |
| `jl-db.js` | IndexedDB `journal-app-v1`: `tx(stores, mode, fn)`, `nextId`, `meta` | `journal.py` (SQLite) |
| `jl-api.js` | маршрутизатор, ті самі маршрути, що `journal_api.py` | `journal_api.py`, `JournalStore` |
| `jl-backup.js` | резервна копія ZIP: `backupCreate`, `backupRestore` | немає |
| `jl-sync.js` | черга, синхронізація, злиття | немає |
| `jl-firebase.js` | Firebase Auth + Firestore (`JL.cloud`) | немає |

### Числа як у Python
Логіка статистики й перевірок порівнюється з Python-кодом сайту побіжно. Тому в JS є `pyRound` (банківське округлення), `pySum`,
`pyFloat`. Не заміняй їх на `Math.round`/`reduce`/`Number()`: це дасть розбіжності в останніх знаках, які тест `parity.test.js` одразу покаже.

## Модель даних (IndexedDB `journal-app-v1`)

- `journals` (ключ `id`): `{id, name, market, currency, fields[], created_at, _u}`
- `entries` (ключ `id`, індекс `journal_id`): `{id, journal_id, data{}, opened, created_at, updated_at, _u}`
- `reviews` (ключ `key` = `"<jid>|<РРРР-ММ>"`): `{key, journal_id, month, data{}, updated_at, _u}`
- `media` (ключ `id`, індекс `entry_id`): `{id, entry_id, journal_id, field, name, mime, size, created_at, _u}`
- `blobs` (ключ = `media.id`): сам файл (Blob)
- `outbox` (ключ `"<kind>/<id>"`): `{key, kind, id, op: "put"|"del", ts}`: що ще не відправлено в хмару
- `meta`: `cloudUid`, `cursor`, `lastSync`, `lastBackup`

`_u` це мілісекунди зміни за годинником пристрою: за ним працює правило «пізніше перемагає». Ідентифікатори числові й зростають:
`max(last+1, Date.now()*1000 + rand(1000))` (безпечні для JS-чисел).

Будь-яка зміна даних проходить через `lib/jl-api.js` і ставить `_u` та позначку в `outbox` (`t.mark(kind, id, op)`). Нову функцію, яка пише в базу,
робити так само, інакше зміна не потрапить у хмару. Усередині транзакції IndexedDB можна чекати лише на виклики `t.*` (не на `fetch`, `DecompressionStream` тощо).

## Синхронізація (`lib/jl-sync.js`)

Хмара підключається через об'єкт `JL.cloud` (`user()`, `onUser(fn)`, `adapter()`), `adapter()` дає `{push(docs), pull(cursor, limit)}`.
Формат документа: `{kind, rid, deleted, u, data: JSON-рядок|null, blob: base64|null}`, `kind` один із `journals|entries|reviews|media`.

`run()`: 1) `pull`: сторінками за курсором, кожен документ іде в `applyRemote` за правилами пізніше-перемагає (також для видалень: «надгробки»);
2) `push`: пакети з `outbox` (до 100 документів чи 5 МБ), фото стискаються до 640 КБ (`shrink`), відео не відправляються; після успіху запис із `outbox` видаляється, лише якщо його не змінили за цей час.
Якщо локально новіше, ніж у хмарі, запис ставиться в `outbox` повторно (виправлення хмари).

`attach(uid)`: перший вхід на пристрої: усе локальне ставиться в чергу (злиття). Інший акаунт на пристрої з даними: подія `conflict` (UI питає про видалення).

### Firestore
`users/{uid}/items/{kind}_{rid}` з полями `kind, rid, deleted, u, data, blob, srv` (`srv` = `serverTimestamp()`, за ним курсор).
Курсор у адаптері: `"сек.наносек"`; сторінки в межах одного запуску йдуть через `startAfter(snapshot)`, новий запуск через `where srv >= курсор` (документи з однаковим `srv` не губляться, повтори безпечні, бо застосування документа ідемпотентне).
Документ Firestore ≤ 1 МБ, тому фото ≤ 640 КБ (base64 ≈ 853 КБ). Без Firebase Storage (він платний). Правила: `firestore.rules`.

Що **не** перевірялося: реальні виклики Firebase (немає доступу до мережі Google при розробці). Перевірено все до межі `adapter()`. Якщо при першому реальному запуску щось не так, дивись текст помилки в «Дані й хмара»: `MSG` у `jl-firebase.js` перекладає коди помилок Firebase.

## Тести (`python3 tests/run_all.py`)

1. `tests/parity.test.js` (Node 18+, ~3000 звірок): ті самі входи через JS і через Python-код сайту, відповіді мають збігатися точно. Еталони в `tests/fixtures/parity.json.gz`, їх генерує `tests/gen_fixtures.py` проти коду сайту: `python3 tests/gen_fixtures.py /шлях/до/backend` (потрібен лише якщо змінилась логіка на сайті).
2. `tests/e2e_core.py` (Playwright + Chromium): інтерфейс, локальний API, файли, імпорт CSV/ZIP, експорт, резервні копії, робота без інтернету, відсутність помилок консолі й порушень CSP.
3. `tests/e2e_sync.py`: синхронізація на імітованій хмарі між кількома «пристроями» (окремі профілі браузера): передача, конфлікти, видалення, черга після перезавантаження, злиття при першому вході, інший акаунт, стиснення фото, сторінки.

Підготовка: `pip install playwright && playwright install chromium`. Тести самі піднімають `python3 -m http.server`.

## Налагодження
- Локально: `./tests/serve.sh` і відкрити `http://127.0.0.1:8765/index.html`.
- Сторінка під CSP (мета-тег у `index.html`): стилі лише з файлів, без інлайн-стилів у розмітці й без `eval`. Для Firebase дозволено `gstatic.com`, `*.googleapis.com`, `*.firebaseio.com`.
- Скинути все: DevTools → Application → Storage → Clear site data.

## Відомі відмінності від сайту
- Пошук за текстом шукає по JSON запису без пробілів після `:` і `,` (у Python з пробілами): на практиці різниці немає.
- Імпорт: заголовок колонки, що дослівно збігається з назвою поля журналу, зіставляється автоматично (власний експорт). Це доповнення відносно сайту.
- Читання CSV: UTF-16 розпізнається лише з позначкою порядку байтів (виправлено так само й на сайті: раніше таблиці Windows-1251 могли читатися як сміття).

## Ідеї на потім
- Вхід через Google (потрібні Authorized domains і `signInWithPopup`).
- Відео в хмару (Firebase Storage, тариф Blaze).
- Шифрування записів паролем на стороні пристрою.
- Видалення старих «надгробків» із хмари.
