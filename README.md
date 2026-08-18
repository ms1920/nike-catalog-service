# Nike Catalog Service

An e-commerce product catalog: a REST API with search, faceted filtering, carts, checkout
and user accounts, plus a React storefront styled from Nike's own design language.

Node.js throughout. No database to install, no cloud account, no secrets to provision —
`npm install && npm run dev` and it runs.

---

## Quick start

```bash
npm install

npm run dev          # API on :3000
npm run dev:web      # storefront on :5173 (proxies /api -> :3000)

npm test             # 178 tests
npm run verify       # types + lint + formatting + tests, all at once
npm run build        # compile the API to plain JS in dist/
npm run smoke        # end-to-end checks against a running server
npm run db:reset     # discard the datastore; the catalog fixture reinstalls
```

Run the two `dev` scripts in separate terminals. Vite proxies `/api` to the API, so
there is no CORS setup and no server address baked into the browser bundle.

With Docker:

```bash
docker compose up --build    # storefront on :8080, API behind it
```

| Variable                              | Default               | Purpose                                                  |
| ------------------------------------- | --------------------- | -------------------------------------------------------- |
| `PORT`                                | `3000`                | API port                                                 |
| `API_KEY`                             | _(unset)_             | When set, catalog writes need it — or an admin session   |
| `DATA_FILE`                           | `data/store.enc.json` | Encrypted datastore path                                 |
| `DATA_KEY`                            | _(committed default)_ | Datastore passphrase — see [Data at rest](#data-at-rest) |
| `DEFAULT_PAGE_SIZE` / `MAX_PAGE_SIZE` | `20` / `100`          | Paging default and hard ceiling                          |

---

## How it fits together

In plain terms: the browser asks the API for products, the API keeps everything in memory
for speed, and mirrors it to one encrypted file on disk so nothing is lost when it
restarts.

```
Browser  ──►  Vite / nginx  ──►  Express API  ──►  in-memory store
(React)       (serves the         (routes ->        (Maps)
               page, proxies       service ->           │
               /api)               repository)          ▼
                                                  encrypted file
                                                  (data/store.enc.json)
```

Requests travel through four layers, each with one job:

| Layer          | Job                                               | Why it is separate                                                               |
| -------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| **routes**     | Read the HTTP request, validate it, shape a reply | So nothing below this line has to know HTTP exists                               |
| **service**    | Enforce the business rules                        | "Can't oversell", "one line per size" — the rules that hold regardless of caller |
| **repository** | Store and fetch, behind an interface              | Swapping in Postgres means writing one class, changing nothing above             |
| **store**      | Actually hold the data                            | In-memory for reads, encrypted file for durability                               |

Four rules keep those boundaries honest:

**Only `app.ts` knows which storage is real.** Everything else depends on an interface.

**Only the routes know about HTTP.** Services throw `NotFoundError`, never "404". One
middleware turns domain errors into status codes, so the same service could be driven by
a background job or a command-line tool unchanged.

**Only the boundary touches untrusted input.** Zod parses request bodies and query
strings into typed values; every layer below assumes the data is already well-formed. The
decrypted datastore counts as untrusted too — a file can be edited — so it is validated
on load for the same reason.

**Filtering, sorting and pagination live in the repository, not the service.** A real
database has to do that work inside the query; you cannot load a million rows into memory
to filter them. Keeping it there means the in-memory version honours the same contract a
SQL version would.

---

## File structure

```
.
├── src/                              THE API (Node + Express + TypeScript)
│   ├── server.ts                     Entry point: boots the datastore, starts listening,
│   │                                 flushes to disk on shutdown so nothing is lost
│   ├── app.ts                        Composition root — the one place that decides which
│   │                                 concrete storage and rate limiters get used
│   ├── config.ts                     Reads environment variables once, at startup
│   │
│   ├── domain/                       The vocabulary. Pure types and pure functions, no I/O.
│   │   ├── product.ts                What a product is; ETag hashing; price formatting
│   │   ├── user.ts                   User vs PublicUser (the split that stops password
│   │   │                             hashes leaking); Session
│   │   ├── cart.ts                   Cart, priced cart, order, inventory holds,
│   │   │                             idempotency records
│   │   └── errors.ts                 Every failure the system can express, with its
│   │                                 HTTP status attached in one place
│   │
│   ├── repositories/                 Storage. Interface first, implementation second.
│   │   ├── product.repository.ts     The interface the rest of the code depends on
│   │   ├── in-memory-product.repository.ts   Map-backed catalog: search, facets, sorting
│   │   ├── user.repository.ts        Users and sessions
│   │   └── cart.repository.ts        Carts, orders, stock holds, idempotency keys
│   │
│   ├── services/                     Business rules.
│   │   ├── product.service.ts        Catalog rules (unique SKUs, soft delete)
│   │   ├── auth.service.ts           Registration, sign-in, session lifecycle
│   │   ├── cart.service.ts           Cart maths, stock reservations, checkout
│   │   └── password.ts               scrypt hashing — the riskiest code, isolated
│   │
│   ├── persistence/                  Durability.
│   │   ├── encrypted-store.ts        AES-256-GCM read/write, atomic file replacement
│   │   └── database.ts               Loads the file into the repositories and mirrors
│   │                                 changes back to it
│   │
│   ├── http/                         The web layer. One routes + one schemas file per resource.
│   │   ├── product.routes.ts         /products endpoints, ETag and If-Match handling
│   │   ├── product.schemas.ts        Validation for products and the query string
│   │   ├── user.routes.ts            /users and /users/sessions (register, sign in/out)
│   │   ├── user.schemas.ts           User entity + request validation, password policy
│   │   ├── cart.routes.ts            /cart endpoints, Idempotency-Key handling
│   │   ├── cart.schemas.ts           Validation for cart operations
│   │   ├── middleware.ts             Request ids, logging, authentication, error mapping
│   │   └── rate-limit.ts             Sliding-window throttling
│   │
│   └── seed/products.ts              38-product fixture used on first run
│
├── web/                              THE STOREFRONT (React 19 + Vite)
│   ├── index.html                    Page shell; loads fonts, sets the favicon
│   ├── tsconfig.json                 Separate from the API's: needs DOM types and JSX
│   └── src/
│       ├── main.tsx                  Mounts React
│       ├── App.tsx                   Page layout; owns which panel is open
│       │
│       ├── components/
│       │   ├── Masthead.tsx          Header: logo, nav, search, account, bag
│       │   ├── FilterRail.tsx        Left-hand filters, counts from the API
│       │   ├── Toolbar.tsx           Result count and sort control
│       │   ├── ProductCard.tsx       One product tile in the grid
│       │   ├── ProductMedia.tsx      Generated product artwork (see Storefront below)
│       │   ├── ProductPanel.tsx      Product detail: size picker, Add to Bag
│       │   ├── CartSheet.tsx         The bag: quantities, subtotal, checkout
│       │   ├── AuthSheet.tsx         Sign in / join form
│       │   ├── Sheet.tsx             Shared slide-over: focus trap, Escape, scroll lock
│       │   ├── Pagination.tsx        Numbered pager
│       │   └── Swoosh.tsx            The Nike mark as inline SVG
│       │
│       ├── state/
│       │   ├── auth.tsx              Who is signed in; token rehydration
│       │   └── cart.tsx              Cart contents; checkout idempotency key
│       │
│       ├── hooks/useCatalog.ts       Query state, debounced search, request cancellation
│       │
│       ├── lib/
│       │   ├── api.ts                Typed API client and wire types
│       │   ├── url-state.ts          Filters <-> address bar, so views are shareable
│       │   ├── format.ts             Display helpers
│       │   ├── scroll-lock.ts        Reference-counted background scroll lock
│       │   └── constants.ts          Values mirrored from the server
│       │
│       └── styles/
│           ├── tokens.css            Design tokens extracted from nike.com
│           └── app.css               All component styling
│
├── tests/                            178 tests
│   ├── helpers.ts                    App/user factories and fixtures
│   ├── product.service.test.ts       Business rules with no HTTP (18)
│   ├── products.api.test.ts          Catalog endpoints, ETag concurrency (60)
│   ├── users.api.test.ts             Registration, sign-in, password security (33)
│   ├── cart.api.test.ts              Cart and checkout behaviour (30)
│   ├── holds-idempotency.test.ts     Stock reservations and idempotent checkout (16)
│   ├── rate-limit.test.ts            Throttling behaviour (9)
│   └── encrypted-store.test.ts       Encryption, tamper detection (12)
│
├── scripts/smoke.mjs                 13 end-to-end checks against a live server
├── deploy/nginx.conf                 Serves the built site, proxies /api to the API
├── Dockerfile                        Multi-stage: builds both, ships two lean images
├── docker-compose.yml                The two-service stack
├── .github/workflows/ci.yml          5 CI jobs (see Continuous integration)
│
├── data/store.enc.json               The encrypted datastore (committed on purpose)
├── .env.example                      Documents every variable; .env itself is ignored
├── eslint.config.js                  Lint rules
├── tsconfig.json                     Typechecks src + tests
├── tsconfig.build.json               Production build: src only, emits dist/server.js
├── vite.config.ts                    Storefront build + dev proxy
└── vitest.config.ts                  Test runner
```

---

## API

Base path `/api/v1`. Success returns `{ data }`; failure returns `{ error }`.

| Method           | Path                                    | Purpose                                     |
| ---------------- | --------------------------------------- | ------------------------------------------- |
| `GET`            | `/health` · `/ready`                    | Is the process alive · can it serve traffic |
| `GET`            | `/products`                             | Search, filter, sort, paginate              |
| `GET`            | `/products/facets`                      | Filter-option counts for the current result |
| `GET`            | `/products/:id`                         | Fetch one — returns an `ETag`               |
| `GET`            | `/products/sku/:sku`                    | Fetch by SKU                                |
| `POST`           | `/products`                             | Create                                      |
| `PATCH`          | `/products/:id`                         | Update — requires `If-Match`                |
| `DELETE`         | `/products/:id`                         | Soft delete (status becomes `archived`)     |
| `POST`           | `/products/:id/variants/:sku/inventory` | Adjust stock by a signed delta              |
| `POST`           | `/users`                                | Register                                    |
| `POST`           | `/users/sessions`                       | Sign in                                     |
| `DELETE`         | `/users/sessions/current`               | Sign out                                    |
| `GET`            | `/users/me`                             | The signed-in user                          |
| `PATCH`          | `/users/me/password`                    | Change password, revoking all sessions      |
| `GET` `DELETE`   | `/cart`                                 | Read · empty                                |
| `POST`           | `/cart/items`                           | Add a size, reserving stock                 |
| `PATCH` `DELETE` | `/cart/items/:variantSku`               | Set quantity (`0` removes) · remove         |
| `POST`           | `/cart/checkout`                        | Place an order — accepts `Idempotency-Key`  |
| `GET`            | `/cart/orders`                          | Order history                               |

Authentication is modelled as operations on users rather than a separate `/auth` area,
because that is what it is: registering **creates a user**, signing in **creates a
session**, signing out **deletes** it. `/auth/login` would invent a resource that does not
exist in the domain and leave the user model with no endpoints of its own.

### Query parameters

`q` `category` `brand` `gender` `size` `tags` `status` `minPrice` `maxPrice`
`inStockOnly` `sort` `page` `pageSize`

Several values of the **same** filter are OR-ed; **different** filters are AND-ed. So
`category=Running,Training&brand=Nike` means _(Running OR Training) AND Nike_ — what a
shopper expects when ticking boxes. `tags` is the deliberate exception and is AND-ed.

Unknown parameters are **rejected with 400** rather than ignored. A typo'd
`?categoryy=Running` that silently returns the whole catalog is worse than an error,
because the caller believes the filter worked.

`status` defaults to `active`, so unreleased drafts and archived products can never leak
into a public listing by accident.

```bash
curl "localhost:3000/api/v1/products?category=Running&inStockOnly=true&sort=price:asc"
curl "localhost:3000/api/v1/products/facets?category=Running"
```

### Errors

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "price.amount", "message": "must be an integer" }],
    "requestId": "8a48142a-..."
  }
}
```

`VALIDATION_ERROR` 400 · `UNAUTHORIZED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 ·
`CONFLICT` / `INSUFFICIENT_STOCK` 409 · `PRECONDITION_FAILED` 412 ·
`PRECONDITION_REQUIRED` 428 · `RATE_LIMITED` 429 · `INTERNAL_ERROR` 500

Validation reports **every** failure at once, not just the first — a user fixing a form
should not need six attempts to discover six problems. Unexpected errors log a stack trace
server-side and return a bare 500, so internal details never reach a client. Every
response carries `x-request-id`, which also appears in the error body and the access log,
so one report can be traced to one line in the logs.

---

## Design decisions

### Money is stored as whole paise, never as a decimal

₹13,295.00 is stored as the integer `1329500`.

The reason, concretely: computers store numbers in binary, and most decimal fractions have
no exact binary form — the same way 1/3 has no exact decimal form. So `0.1 + 0.2` is
genuinely `0.30000000000000004`. The damage shows up when the same total is computed two
ways: seven line items of `1499.95` **summed** gives `10499.650000000001`, but `1499.95 × 7`
gives `10499.65`. A cart whose line totals and invoice total disagree is a real bug that
reaches a customer.

Whole numbers have no such problem, and JavaScript holds them exactly up to
9,007,199,254,740,991 — ₹1 crore is only 1,000,000,000 paise, nowhere near the limit. This
is also what Stripe, PayPal and Razorpay all do; their APIs take integer minor units for
exactly this reason. The alternatives are a decimal library (correct, but a dependency, and
every `+` becomes a method call) or `BigInt` (exact, but will not serialise to JSON). The
cost here is one divide-by-100 when displaying a price, and that is all.

`formatMoney` defaults to `en-IN`, because Indian numbering groups by lakh:
`₹1,50,000.00`, not `₹150,000.00`.

_Known limit:_ dividing by 100 assumes the currency has two decimal places. True for INR
and USD, wrong for zero-decimal currencies like JPY.

### Validation happens once, at the edge, with Zod

TypeScript's types disappear when the code is compiled, so they cannot check a JSON body
that arrives over the network — at runtime that data is simply unknown. Zod checks the
real shape while the program is running, and the TypeScript type is derived from the same
definition, so one declaration serves both.

This is not ceremony. `z.number().int()` on a price is what rejects `19.999` at the door
instead of letting it reach the datastore and resurface as a wrong total. `.strict()` is
what rejects `{"role":"admin"}` smuggled into a registration body, rather than silently
ignoring it.

### Stock lives on the size, not the product

Stock is a property of _this shoe in size 9_, not of the shoe. Putting it on the product
would make the API unable to express the single most common state in retail: in stock, but
not in your size.

### Stock changes by a signed delta, never by setting a total

`{"delta":-1}`, not `{"inventory":6}`. Two people buying at the same moment correctly
leave stock at N−2. Had each read N and written N−1, one sale would vanish — the classic
lost-update bug.

### Carts hold references; orders hold prices

A stored cart is only ids and quantities. Names and prices are looked up fresh on every
read, so a price change is reflected immediately and a cart can never quote a stale figure.

Orders do the opposite: each order line records its own price, because an order must
preserve what the customer agreed to pay even if the catalog changes tomorrow.

### Adding to a cart reserves stock, but only for 15 minutes

Two shoppers each adding the last pair should not both reach the payment screen, so
entering a cart places a hold.

The time limit is the interesting part. A permanent reservation means one abandoned cart
strands that pair forever, and a popular size quietly becomes unbuyable. Holds are separate
records from cart lines, because a cart is long-lived and a reservation is not — when a
hold expires the line stays put and simply reports that it can no longer be fulfilled. Your
bag keeps its contents; you can lose your claim on scarce stock.

A shopper's own hold is not counted against them, or their cart would appear to be
competing with itself. Expiry is evaluated whenever availability is next read, rather than
by a background timer that would keep the process awake and need supervising.

### Checkout can be safely retried

`Idempotency-Key` makes a repeat harmless: the same key returns the **original** order
instead of placing a second one. That is the fix for a double-clicked Pay button, or a
client that timed out and cannot tell whether the order went through.

One ordering detail matters: the key is checked **before** the empty-cart check. A
successful checkout empties the cart, so the textbook retry arrives with an empty cart —
and checking that first would answer a legitimate retry with "cannot check out an empty
cart". A reused key describing a genuinely different basket is a 409, because replaying the
old order would hide a real client bug.

Inventory is decremented one line at a time and **reversed if a later line fails**.
Without that, a cart whose third item is out of stock would leave the first two silently
decremented.

_This is a compensating action, not a transaction._ It is not atomic under concurrency —
another request can slip between steps. On Postgres the whole method becomes a single
`BEGIN … COMMIT` with `UPDATE … SET inventory = inventory - $1 WHERE inventory >= $1`, and
the reversal logic gets deleted.

### Updating a product requires the version you read

`GET /products/:id` returns an `ETag` — a fingerprint of that product's contents. `PATCH`
requires it back in `If-Match`. If the product changed in between, the write is rejected
with 412.

Without this, two people editing the same product would each save, and the second would
silently erase the first. The header is **required**, not optional: optional means the
unsafe path is the default, and every client that forgets gets last-write-wins without ever
being told. `If-Match: *` is the explicit way to overwrite regardless.

The ETag is a hash of the content rather than a version counter. It needs no extra field,
two edits in the same millisecond still differ (where a timestamp would collide), and two
genuinely identical states correctly produce the same tag.

### Deleting a product only archives it

`DELETE` sets `status: archived`. Catalog rows are referenced by orders, analytics and
search indexes; deleting the row outright orphans all of that history.

### Sorting always breaks ties on id

Without a tie-break, two products at the same price can swap places between page 1 and
page 2 — so someone scrolling sees one item twice and never sees another.

### Rate limiting uses a sliding window

Sign-in has the tightest limit, for two reasons that compound. It is the obvious target for
credential-stuffing, **and** password checking deliberately costs ~57 ms of memory-hard
work. That makes an unthrottled sign-in endpoint a way to exhaust the server's CPU as well
as a way to guess passwords — a few hundred concurrent attempts starve everything else
whether or not any password is ever found. The limit is keyed on IP **and** email, so one
attacker cannot lock out everyone sharing an office connection.

Sliding rather than fixed windows: a fixed window lets someone fire the full quota at
0.99 s and again at 1.01 s, technically obeying two windows while delivering double the
burst.

_Known limit:_ counters live in the process, so two copies of the server allow twice the
rate, and a restart forgives everyone. A real deployment needs a shared store;
`RateLimitStore` is the seam for that.

Health and readiness are never throttled — rate limiting a health check is how a busy
service gets itself taken out of rotation.

---

## Authentication

**Passwords are hashed with scrypt** (N=32768, r=8, p=1) and a unique random salt each.
scrypt is deliberately slow and memory-hungry, which is what makes large-scale guessing
expensive; a fast hash like SHA-256 is not acceptable for passwords no matter how it is
salted. The cost settings are stored inside the hash string
(`scrypt$N$r$p$salt$hash`), so they can be raised later without invalidating existing
passwords — and any hash below current policy is quietly upgraded the next time that person
signs in. Comparison uses `timingSafeEqual`, because ordinary string comparison stops at
the first wrong byte and that timing difference is measurable enough to leak the hash.

**Sessions are random 256-bit tokens, stored hashed.** The server keeps only a SHA-256 of
the token, so a stolen session table cannot be replayed as logins. SHA-256 is the right
choice _here_, unlike for passwords: a long random token has no guessable structure, so
slow hashing would add latency to every request and buy nothing.

**Account enumeration is treated as a real risk.** Sign-in returns the same message whether
the email is unknown or the password is wrong — and when the email is unknown it still
performs a hash against a dummy value, so the response takes the same time. Without that,
timing alone reveals which addresses are registered and the shared message achieves
nothing. Registration does reveal that an address is taken: it genuinely cannot proceed,
and a vague error would leave the person stuck.

**Roles.** `customer` and `admin`. Registration cannot grant itself a role — the schema
rejects unknown fields, so `{"role":"admin"}` is refused outright. Catalog writes accept an
API key (for machines, like a nightly import) or an admin session (for people). A signed-in
customer attempting one gets **403, not 401**: we know exactly who they are, so telling
them to sign in again cannot help.

**The token is returned in the response body, not a cookie.** That avoids CSRF entirely,
since another site cannot read a response body. The cost is that the browser must store it,
and `localStorage` is readable by any script injected into the page. The stronger design is
an httpOnly, Secure, SameSite refresh cookie plus a short-lived in-memory token — a
deliberate simplification here, recorded rather than glossed over.

---

## Data at rest

Everything — products, users, sessions, carts, orders, holds, idempotency records — lives
in a single AES-256-GCM encrypted file that is committed to the repository. The in-memory
repositories serve all reads; the file is written behind them on a 250 ms delay, so no
request ever waits for the disk.

### What the encryption actually buys you

Worth being blunt, because this is easy to oversell. The data file is in the repository and,
by default, so is the passphrase. Anyone with the repository has both. **That is not
confidentiality against someone who can read the repo.**

What it genuinely provides:

- **Tamper detection.** GCM is authenticated encryption: change one byte and startup fails
  loudly instead of quietly loading altered records.
- **Opacity at rest.** Emails and order history are not sitting in plain text to be grepped
  or read in a diff. The file is written `0600`.
- **Real confidentiality when `DATA_KEY` is set** and kept out of the repo. That is the
  intended posture for anything real, and the server logs a warning while the default is in
  use.

The important protection for the most sensitive field is elsewhere: passwords are hashed
**before** they ever reach this file, so decrypting it still yields no usable credentials.

### Not losing data

Writes go to a temporary file which is then renamed over the original, because a crash
midway through a direct write would leave a half-written file that fails its integrity
check — losing everything. `SIGTERM` forces a flush before exit, since a change made in the
last 250 ms would otherwise vanish. A failure to decrypt **refuses to start**: coming up
empty would look like data loss and would then overwrite the good file with that empty state
on the first write, turning a recoverable wrong-key mistake into a permanent one.

Products are persisted rather than re-seeded on each boot, because checkout decrements
stock — re-seeding would resurrect sold inventory and leave past orders contradicting the
catalog.

---

## Storefront

React 19 and Vite, styled from Nike's live design language rather than from taste. The
tokens in `web/src/styles/tokens.css` were extracted from `nike.com`: `#FFFFFF` canvas,
`#111111` ink (never pure black), `#707072` secondary text, `#F5F5F5` product tiles, pill
buttons at `30px`, a 4 pt spacing unit, and **no shadows anywhere** — Nike's own CSS reports
zero elevation on every component, and matching that is most of why this reads as Nike
rather than as a generic dashboard.

**Fonts are substituted, and that matters.** Nike uses Helvetica Now Text and Display,
licensed faces that cannot be redistributed. Nike's own India stylesheet lists Inter as a
fallback, so this ships Inter Tight + Inter: the same neo-grotesque skeleton, openly
licensed. The Swoosh is a Nike trademark, reproduced here for an exercise — do not deploy
this publicly.

**Product artwork is generated, not stubbed.** The fixture's image URLs do not resolve, so
rather than ship broken images or invent stock photography, each card draws a tile in Nike's
real product-tile grey, tinted from that product's own colourway and rotated through five
hard-edged compositions chosen from the product id. A single repeated shape across a 24-tile
grid reads as a template no matter how the colour varies. Point `images` at a real CDN and
photographs replace it with no code change.

No invented social proof: no review counts, no star ratings, no "trusted by 50,000
athletes". Stock warnings quote the real number the API returned.

**Cart updates are not optimistic.** Every change returns the recalculated cart and replaces
local state with it. The server is the only thing that knows current stock, so guessing
locally would sometimes need a visible correction; for a cart, a brief spinner beats a
number that flickers to the wrong value.

**The idempotency key is held per checkout attempt**, so a retry after a network failure
reuses it. Generating a fresh key on retry would make the server treat it as a brand-new
order — the exact double-charge the mechanism exists to prevent.

**Responsiveness.** No feature is removed to fit a screen: the nav wraps rather than
scrolling out of sight, and the filter rail becomes a slide-over below 1024 px but stays
reachable. Column count comes from `repeat(auto-fill, minmax(min(16rem, 100%), 1fr))`, so it
follows the available width instead of jumping at fixed breakpoints, and headings use
`clamp()` with Nike's real size as the ceiling. Verified with a script across twelve screen
sizes that walks each element's scrollable ancestors, so it detects content **clipped by a
container** rather than merely missing from the page.

---

## Continuous integration

Five jobs, ordered so the cheapest failures surface first.

| Job      | What it proves                                                                    |
| -------- | --------------------------------------------------------------------------------- |
| `static` | Types compile (API + web), lint passes, formatting is clean                       |
| `unit`   | 178 tests on Node 22 and 24, with coverage                                        |
| `build`  | Artifacts exist **and** the compiled JS boots on bare `node` and reports ready    |
| `smoke`  | A real server over a real socket: purchase flow, retry replay, session revocation |
| `docker` | Both images build, then the running stack is smoke-tested **through nginx**       |

The `build` job checks that `dist/server.js` exists rather than trusting the exit code,
because a build that emits nothing still exits successfully. The `docker` job tests through
the proxy rather than hitting the API directly, so a broken proxy route fails in CI instead
of in front of a reviewer — which is exactly what it caught: `/ready` was not proxied and
was quietly returning the HTML page with a 200.

Smoke tests are deliberately separate from the unit suite. Unit and integration tests drive
the app in-process with substituted storage, which cannot catch anything about the
**deployed** artifact — a broken entry point, a datastore that will not decrypt, an
environment variable never wired through. `npm run smoke` runs them against any URL.

---

## Testing

178 tests. `npm test`.

Two layers, deliberately. Service tests exercise business rules through the storage
interface with no HTTP involved, proving the rules hold regardless of how they are called.
API tests drive the real Express app in-process; `createApp()` never opens a port, so each
test builds its own app and its own fresh storage, and they run in parallel without
interfering.

Expected counts are **derived from the fixture**, not hard-coded. `expect(total).toBe(4)` is
a fact about the fixture rather than about the filtering logic, and it turns every catalog
edit into a false alarm. Growing the fixture from 12 to 38 products required no test
rewrites because of this.

The security-relevant properties get direct tests, because they are the ones that fail
silently: no plain text reaches the datastore, a single flipped byte is detected, a fresh
salt and nonce are used on every write (reusing a nonce under GCM is catastrophic), the two
sign-in failure modes are indistinguishable, `{"role":"admin"}` is rejected, changing a
password revokes every session, a stale `If-Match` cannot overwrite newer data, a replayed
idempotency key moves stock exactly once, and one user can neither see nor modify another's
cart.

---

## Tradeoffs

**In-memory storage with an encrypted file mirror, instead of Postgres.** The deciding
constraint was that a fresh clone must run with nothing to install or provision. The costs
are real: no sharing between processes, per-process rate limits, a checkout that is not
truly atomic, and search quality capped at weighted keyword matching.

`ProductRepository` is what keeps this reversible — migrating means writing one class:

| Concern    | Now                   | With Postgres                         |
| ---------- | --------------------- | ------------------------------------- |
| Filtering  | `Array.filter`        | `WHERE` plus partial indexes          |
| Search     | Weighted term match   | `tsvector` / `ts_rank`, or OpenSearch |
| Facets     | Recounted per request | `GROUP BY`, or a cached rollup        |
| Inventory  | Rebuild the array     | `UPDATE … WHERE inventory >= $1`      |
| Pagination | `slice`               | `LIMIT`/`OFFSET`, then keyset         |
| Checkout   | Manual reversal       | One transaction                       |

**Page-number pagination, not cursors.** Page numbers are what a numbered storefront pager
needs, and they can honestly report a total page count. They degrade on very deep pages and
can skip an item if the catalog changes mid-scroll; cursor pagination on `(sort key, id)` is
the fix, and the existing id tie-break is already the stable key it would need.

**Search is deliberately simple.** Weighted field matching, with every term required. No
stemming, no fuzzy matching: `runing` finds nothing. Real relevance ranking belongs in
Postgres full-text search or OpenSearch, not in application code.

**No tax or shipping line.** Both are real business rules that vary by destination.
Inventing a percentage would make the total a lie, so the cart shows a subtotal and says so.

**One `package.json` for API and storefront.** Simpler for a reviewer to clone and run than
a workspace setup. A production repo would split them so the front end cannot accidentally
import server code.

---

## Future developments

1. **Postgres behind the existing interface** — real transactions, `tsvector` search, cursor
   pagination, and the manual inventory reversal deleted.
2. **A payment step.** Checkout currently moves stock but takes no money. A real one needs a
   payment intent whose success and the inventory commit cannot diverge — the hardest
   correctness problem in the whole flow.
3. **Shared rate-limit storage**, so limits hold across multiple server copies.
4. **OpenAPI generated from the Zod schemas**, with a typed client for the front end. This
   would delete the hand-maintained wire types in `web/src/lib/api.ts` and the duplicated
   `MAX_QUANTITY` constant, and make it impossible for client and server to disagree.
5. **httpOnly refresh cookie plus in-memory access token**, so a script injected into the
   page cannot walk off with a seven-day session.
6. **Order lifecycle** — confirmed, packed, shipped, delivered, returned — with the state
   machine and the stock consequences of a return.
7. **Observability** — OpenTelemetry traces and structured logs, reusing the existing request
   id as the correlation key.
8. **Accessibility audit with real assistive technology.** Focus management, keyboard paths
   and labelling were built in deliberately, but only automated checks and keyboard testing
   have been done; a screen-reader pass is not the same thing and has not happened.

---

## Retargeting this to another domain

`src/domain/product.ts` and the fixture carry essentially all the catalog-specific
knowledge; the query, pagination, faceting, error and HTTP machinery is generic. Pointing
this at a Backstage-style internal service catalog maps over almost exactly:
`category` → `lifecycle`, `brand` → `owning team`, `variants` → `deployed environments`,
`inStock` → `healthy`. The filter, facet, sort and paginate surface is the same problem
wearing different words.
